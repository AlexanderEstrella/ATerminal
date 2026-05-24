'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { listSessions, listAgents, createSession, endSession, parseShells, listUserLocations, upsertUserLocation, deleteUserLocation, } = require('../db');
const { isAllowedRequestOrigin } = require('./origin');
const SUPPORTED_SHELLS = new Set(['powershell', 'cmd', 'wsl', 'bash', 'zsh', 'sh', 'fish']);
const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
const MAX_CONTEXT_OUTPUT_CHARS = 12000;
// ---------------------------------------------------------------------------
// Socket.IO browser-facing WebSocket layer
// ---------------------------------------------------------------------------
function createBrowserWs(httpServer, db, config, agentGateway, audit) {
    const io = new Server(httpServer, {
        transports: ['websocket', 'polling'],
        allowRequest: (req, callback) => {
            callback(null, isAllowedRequestOrigin(req, config));
        },
    });
    agentGateway.setBroadcaster((event, data) => io.emit(event, data));
    // Auth middleware — verify JWT from handshake
    io.use((socket, next) => {
        const token = socket.handshake.auth && socket.handshake.auth.token;
        if (!token) {
            return next(new Error('Authentication required'));
        }
        try {
            socket.user = jwt.verify(token, config.jwtSecret);
            next();
        }
        catch (err) {
            next(new Error('Invalid or expired token'));
        }
    });
    io.on('connection', (socket) => {
        const attachedSessions = new Map();
        audit.log('socket_connected', socket.user.username, { socketId: socket.id });
        // terminal:attach — browser wants to receive output for an existing session
        socket.on('terminal:attach', (payload) => {
            const sessionId = typeof payload === 'string' ? payload : payload?.sessionId;
            const noReplay = typeof payload === 'object' && payload?.noReplay === true;
            const session = getSession(db, sessionId);
            if (!session) {
                socket.emit('terminal:error', { sessionId, message: 'Session not found' });
                return;
            }
            if (!canAccessSession(socket.user, session)) {
                audit.log('terminal_attach_denied', socket.user.username, { sessionId });
                socket.emit('terminal:error', { sessionId, message: 'Not authorized for this session' });
                return;
            }
            const previousCallbackId = attachedSessions.get(sessionId);
            if (previousCallbackId)
                agentGateway.removeSessionCallbacks(sessionId, previousCallbackId);
            const callbackId = agentGateway.registerSessionCallbacks(sessionId, session.agent_id, {
                onOutput: (data) => socket.emit('terminal:output', { sessionId, data }),
                onExit: (code) => socket.emit('terminal:exit', { sessionId, code }),
            });
            attachedSessions.set(sessionId, callbackId);
            audit.log('terminal_attach', socket.user.username, { sessionId });
            // Replay buffered output so the terminal isn't blank on first attach.
            // Skip replay when the client already has the content (reconnect case).
            if (!noReplay) {
                const replayBuffer = agentGateway.getOutputBuffer(sessionId);
                if (replayBuffer.length > 0) {
                    socket.emit('terminal:output', { sessionId, data: replayBuffer.join('') });
                }
            }
        });
        // terminal:input — forward keystrokes to the agent
        socket.on('terminal:input', ({ sessionId, data } = {}) => {
            const session = getSession(db, sessionId);
            if (!session || !canAccessSession(socket.user, session) || typeof data !== 'string') {
                return;
            }
            if (Buffer.byteLength(data, 'utf8') > MAX_TERMINAL_INPUT_BYTES) {
                socket.emit('terminal:error', { sessionId, message: 'Input event too large' });
                return;
            }
            const agentId = agentGateway.getAgentForSession(sessionId);
            if (agentId) {
                agentGateway.sendToAgent(agentId, { type: 'input', sessionId, data });
            }
            audit.log('terminal_input', socket.user.username, { sessionId, bytes: data ? data.length : 0 });
        });
        // terminal:resize — forward terminal resize to the agent
        socket.on('terminal:resize', ({ sessionId, cols, rows } = {}) => {
            const session = getSession(db, sessionId);
            if (!session || !canAccessSession(socket.user, session))
                return;
            const safeCols = clampInt(cols, 20, 500);
            const safeRows = clampInt(rows, 5, 200);
            if (!safeCols || !safeRows)
                return;
            const agentId = agentGateway.getAgentForSession(sessionId);
            if (agentId) {
                agentGateway.sendToAgent(agentId, { type: 'resize', sessionId, cols: safeCols, rows: safeRows });
            }
            audit.log('terminal_resize', socket.user.username, { sessionId, cols: safeCols, rows: safeRows });
        });
        // terminal:detach — browser is done watching this session
        socket.on('terminal:detach', (sessionId) => {
            const session = getSession(db, sessionId);
            if (session && canAccessSession(socket.user, session)) {
                const callbackId = attachedSessions.get(sessionId);
                if (callbackId) {
                    agentGateway.removeSessionCallbacks(sessionId, callbackId);
                    attachedSessions.delete(sessionId);
                }
                audit.log('terminal_detach', socket.user.username, { sessionId });
            }
        });
        socket.on('disconnect', () => {
            for (const [sessionId, callbackId] of attachedSessions.entries()) {
                agentGateway.removeSessionCallbacks(sessionId, callbackId);
            }
            attachedSessions.clear();
            audit.log('socket_disconnected', socket.user.username, { socketId: socket.id });
        });
    });
}
// ---------------------------------------------------------------------------
// REST API router (mounted at /api with requireAuth already applied)
// ---------------------------------------------------------------------------
function createApiRouter(db, config, agentGateway, audit) {
    const router = express.Router();
    // GET /api/sessions
    router.get('/sessions', (req, res) => {
        const sessions = listSessions(db).filter((session) => canAccessSession(req.user, session));
        res.json(serializeSessionSummaries(db, agentGateway, sessions));
    });
    // GET /api/sessions/:id/context - metadata plus recent terminal output
    router.get('/sessions/:id/context', (req, res) => {
        const session = getSession(db, req.params.id);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }
        if (!canAccessSession(req.user, session)) {
            audit.log('session_context_denied', req.user.username, { sessionId: session.id });
            return res.status(403).json({ error: 'Not authorized for this session' });
        }
        const agent = db.prepare('SELECT id, hostname, name, platform, last_seen FROM agents WHERE id = ?').get(session.agent_id);
        const outputBuffer = agentGateway.getOutputBuffer(session.id);
        const rawOutput = outputBuffer.join('');
        const outputPreview = formatTerminalPreview(rawOutput);
        const onlineAgents = agentGateway.listConnectedAgents();
        audit.log('session_context_viewed', req.user.username, {
            sessionId: session.id,
            bytes: Buffer.byteLength(outputPreview, 'utf8'),
        });
        return res.json({
            session: {
                id: session.id,
                agent_id: session.agent_id,
                name: session.name,
                shell: session.shell,
                cwd: session.cwd,
                status: session.status,
                created_at: session.created_at,
                ended_at: session.ended_at,
            },
            agent: agent ? {
                id: agent.id,
                hostname: agent.hostname,
                name: agent.name,
                platform: agent.platform,
                last_seen: agent.last_seen,
                status: onlineAgents.includes(agent.id) ? 'online' : 'offline',
            } : null,
            outputPreview,
            outputTruncated: rawOutput.length > MAX_CONTEXT_OUTPUT_CHARS,
            bufferedChunks: outputBuffer.length,
        });
    });
    // POST /api/sessions — spawn a new terminal session on an agent
    router.post('/sessions', async (req, res) => {
        const { agentId, shell, name } = req.body || {};
        let { cwd } = req.body || {};
        if (!agentId) {
            return res.status(400).json({ error: 'agentId is required' });
        }
        const agent = db.prepare('SELECT id, hostname, name, platform, shells FROM agents WHERE id = ?').get(agentId);
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }
        if (!agentGateway.listConnectedAgents().includes(agentId)) {
            return res.status(409).json({ error: 'Agent is offline' });
        }
        const sessionId = crypto.randomUUID();
        const resolvedShell = shell || 'powershell';
        if (!SUPPORTED_SHELLS.has(resolvedShell)) {
            return res.status(400).json({ error: 'Unsupported shell' });
        }
        const agentShells = parseShells(agent.shells);
        if (agentShells.length > 0 && !agentShells.includes(resolvedShell)) {
            return res.status(400).json({ error: 'Shell is not available on that agent' });
        }
        const resolvedName = typeof name === 'string' && name.trim()
            ? name.trim().slice(0, 120)
            : resolvedShell;
        if (cwd != null) {
            const pathError = validatePathInput(cwd);
            if (pathError)
                return res.status(400).json({ error: pathError });
            try {
                const listing = await agentGateway.requestAgent(agentId, { type: 'fs:list', path: cwd }, 5_000);
                cwd = listing.path;
            }
            catch (_) {
                // CWD validation unavailable — proceed with the path as provided.
                // The shell handles invalid directories by starting in the default location.
            }
        }
        createSession(db, {
            id: sessionId,
            agentId,
            name: resolvedName,
            shell: resolvedShell,
            cwd,
            owner: req.user.username,
        });
        agentGateway.sendToAgent(agentId, {
            type: 'spawn',
            sessionId,
            shell: resolvedShell,
            cwd,
            cols: 220,
            rows: 50,
        });
        // Register placeholder callbacks; the browser will override them on attach
        agentGateway.registerSessionCallbacks(sessionId, agentId, {
            onOutput: () => { },
            onExit: () => { },
        });
        if (cwd) {
            upsertUserLocation(db, {
                user: req.user.username,
                agentId,
                path: cwd,
                label: cwd,
                type: 'recent',
            });
        }
        audit.log('session_created', req.user.username, { sessionId, agentId, shell: resolvedShell, cwd });
        return res.json({
            id: sessionId,
            agent_id: agentId,
            name: resolvedName,
            shell: resolvedShell,
            cwd,
            status: 'active',
            created_at: Date.now(),
        });
    });
    // DELETE /api/sessions/history — remove all ended sessions (admin only)
    router.delete('/sessions/history', (req, res) => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin role required' });
        }
        const { deleteEndedSessions } = require('../db');
        const result = deleteEndedSessions(db);
        audit.log('sessions_history_cleared', req.user.username, { count: result.changes });
        res.json({ deleted: result.changes });
    });
    // DELETE /api/sessions/:id — kill a session
    router.delete('/sessions/:id', (req, res) => {
        const sessionId = req.params.id;
        const session = getSession(db, sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }
        if (!canAccessSession(req.user, session)) {
            audit.log('session_kill_denied', req.user.username, { sessionId });
            return res.status(403).json({ error: 'Not authorized for this session' });
        }
        const agentId = agentGateway.getAgentForSession(sessionId) || session.agent_id;
        if (agentId) {
            agentGateway.sendToAgent(agentId, { type: 'kill', sessionId });
        }
        endSession(db, sessionId);
        agentGateway.removeSession(sessionId);
        audit.log('session_killed', req.user.username, { sessionId, agentId });
        res.json({ success: true });
    });
    // GET /api/agents — list all agents with online/offline status
    router.get('/agents', (req, res) => {
        const rows = listAgents(db);
        const online = agentGateway.listConnectedAgents();
        res.json(rows.map((a) => ({ ...a, status: online.includes(a.id) ? 'online' : 'offline' })));
    });
    router.get('/agents/:agentId/locations', async (req, res) => {
        const agentId = req.params.agentId;
        const agent = db.prepare('SELECT id, hostname, name, platform FROM agents WHERE id = ?').get(agentId);
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }
        if (!canAccessAgentFilesystem(db, req.user, agentId)) {
            audit.log('locations_list_denied', req.user.username, { agentId });
            return res.status(403).json({ error: 'Not authorized for this agent' });
        }
        if (!agentGateway.listConnectedAgents().includes(agentId)) {
            return res.status(409).json({ error: 'Agent is offline' });
        }
        const locationPath = typeof req.query.path === 'string' ? req.query.path : undefined;
        const pathError = validatePathInput(locationPath);
        if (pathError)
            return res.status(400).json({ error: pathError });
        try {
            const listing = await agentGateway.requestAgent(agentId, {
                type: 'fs:list',
                path: locationPath,
            }, 10_000);
            audit.log('locations_listed', req.user.username, { agentId, path: listing.path });
            res.json(listing);
        }
        catch (err) {
            const message = err.message || 'Failed to list locations';
            res.status(message.includes('timed out') ? 504 : 400).json({ error: message });
        }
    });
    // DELETE /api/agents/:id — unpair (remove) an agent
    router.delete('/agents/:id', (req, res) => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin role required' });
        }
        const agentId = req.params.id;
        const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId);
        if (!agent)
            return res.status(404).json({ error: 'Agent not found' });
        // End all active sessions for this agent
        db.prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE agent_id = ? AND status = 'active'")
            .run(Date.now(), agentId);
        // Disconnect the agent WebSocket if connected
        const gw = req.app.get('agentGateway');
        if (gw)
            gw.disconnectAgent(agentId);
        // Remove from DB
        db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
        audit.log('agent_unpaired', req.user.username, { agentId });
        return res.json({ ok: true });
    });
    router.get('/locations', (req, res) => {
        const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
        const type = typeof req.query.type === 'string' ? req.query.type : 'recent';
        if (!agentId)
            return res.status(400).json({ error: 'agentId is required' });
        if (!['recent', 'favorite'].includes(type)) {
            return res.status(400).json({ error: 'Invalid location type' });
        }
        if (!canAccessAgentFilesystem(db, req.user, agentId)) {
            audit.log('locations_saved_denied', req.user.username, { agentId, type });
            return res.status(403).json({ error: 'Not authorized for this agent' });
        }
        res.json(listUserLocations(db, { user: req.user.username, agentId, type }));
    });
    router.post('/locations/favorites', (req, res) => {
        const { agentId, path, label } = req.body || {};
        if (!agentId || typeof agentId !== 'string') {
            return res.status(400).json({ error: 'agentId is required' });
        }
        if (!canAccessAgentFilesystem(db, req.user, agentId)) {
            audit.log('location_favorite_denied', req.user.username, { agentId });
            return res.status(403).json({ error: 'Not authorized for this agent' });
        }
        const pathError = validatePathInput(path);
        if (pathError || !path)
            return res.status(400).json({ error: pathError || 'path is required' });
        upsertUserLocation(db, {
            user: req.user.username,
            agentId,
            path,
            label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : path,
            type: 'favorite',
        });
        audit.log('location_favorited', req.user.username, { agentId, path });
        res.json({ success: true });
    });
    router.delete('/locations/favorites', (req, res) => {
        const { agentId, path } = req.body || {};
        if (!agentId || typeof agentId !== 'string') {
            return res.status(400).json({ error: 'agentId is required' });
        }
        if (!canAccessAgentFilesystem(db, req.user, agentId)) {
            audit.log('location_unfavorite_denied', req.user.username, { agentId });
            return res.status(403).json({ error: 'Not authorized for this agent' });
        }
        const pathError = validatePathInput(path);
        if (pathError || !path)
            return res.status(400).json({ error: pathError || 'path is required' });
        deleteUserLocation(db, {
            user: req.user.username,
            agentId,
            path,
            type: 'favorite',
        });
        audit.log('location_unfavorited', req.user.username, { agentId, path });
        res.json({ success: true });
    });
    // GET /api/status — server health snapshot
    router.get('/status', (req, res) => {
        res.json({
            uptime: process.uptime(),
            sessions: listSessions(db).length,
            agents: agentGateway.listConnectedAgents().length,
            node: process.version,
            user: { username: req.user.username, role: req.user.role },
            publicUrl: config.publicUrl || null,
        });
    });
    router.post('/qr', async (req, res) => {
        const { text } = req.body || {};
        if (typeof text !== 'string' || text.length === 0 || text.length > 2048) {
            return res.status(400).json({ error: 'text must be a non-empty string up to 2048 characters' });
        }
        try {
            const dataUrl = await QRCode.toDataURL(text, {
                errorCorrectionLevel: 'M',
                margin: 2,
                width: 224,
                color: {
                    dark: '#0d1117',
                    light: '#ffffff',
                },
            });
            audit.log('qr_generated', req.user.username, { bytes: text.length });
            res.json({ dataUrl });
        }
        catch (_) {
            res.status(500).json({ error: 'Failed to generate QR code' });
        }
    });
    return router;
}
function getSession(db, sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length > 100)
        return null;
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
}
function canAccessSession(user, session) {
    return Boolean(user && session && (user.role === 'admin' || !session.owner || session.owner === user.username));
}
function canAccessAgentFilesystem(db, user, agentId) {
    if (!user || !agentId)
        return false;
    if (user.role === 'admin')
        return true;
    const row = db.prepare('SELECT id FROM sessions WHERE agent_id = ? AND (owner IS NULL OR owner = ?) LIMIT 1').get(agentId, user.username);
    return Boolean(row);
}
function serializeSessionSummaries(db, agentGateway, sessions) {
    const onlineAgents = new Set(agentGateway.listConnectedAgents());
    const agentsById = new Map(listAgents(db).map((agent) => [agent.id, agent]));
    return sessions.map((session) => {
        const agent = agentsById.get(session.agent_id);
        return {
            id: session.id,
            agent_id: session.agent_id,
            name: session.name,
            shell: session.shell,
            cwd: session.cwd,
            status: session.status,
            created_at: session.created_at,
            ended_at: session.ended_at,
            agent: agent ? {
                id: agent.id,
                hostname: agent.hostname,
                name: agent.name,
                platform: agent.platform,
                last_seen: agent.last_seen,
                status: onlineAgents.has(agent.id) ? 'online' : 'offline',
            } : null,
        };
    });
}
function validatePathInput(value) {
    if (value == null || value === '')
        return null;
    if (typeof value !== 'string')
        return 'path must be a string';
    if (value.length > 2048)
        return 'path is too long';
    if (/[\0-\x08\x0B\x0C\x0E-\x1F]/.test(value))
        return 'path contains invalid characters';
    return null;
}
function formatTerminalPreview(output) {
    if (!output)
        return '';
    const tail = output.length > MAX_CONTEXT_OUTPUT_CHARS
        ? output.slice(-MAX_CONTEXT_OUTPUT_CHARS)
        : output;
    return tail
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
function clampInt(value, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed))
        return null;
    return Math.max(min, Math.min(max, parsed));
}
module.exports = { createBrowserWs, createApiRouter };
