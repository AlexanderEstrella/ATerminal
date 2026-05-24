'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createDeviceRequest, getDeviceRequest, listPendingDeviceRequests, approveDeviceRequest, rejectDeviceRequest, upsertAgent, } = require('../db');
const { requireAuth } = require('./auth');
const VALID_PLATFORMS = new Set(['win32', 'darwin', 'linux', 'freebsd', 'openbsd']);
const TTL_MS = 5 * 60 * 1000; // 5 minutes
function createDeviceAuthRouter(db, config, audit) {
    const router = express.Router();
    // POST /api/device/request — agent calls this to start the flow
    router.post('/request', (req, res) => {
        const { hostname, platform } = req.body || {};
        if (!hostname || !platform) {
            return res.status(400).json({ error: 'hostname and platform required' });
        }
        if (!VALID_PLATFORMS.has(platform)) {
            return res.status(400).json({ error: 'Unsupported platform' });
        }
        const id = crypto.randomBytes(16).toString('hex');
        const expiresAt = Date.now() + TTL_MS;
        createDeviceRequest(db, { id, hostname: hostname.trim().slice(0, 255), platform, expiresAt });
        audit.log('device_request_created', 'system', { id, hostname });
        return res.json({ id, expiresAt });
    });
    // GET /api/device/poll/:id — agent polls for approval
    router.get('/poll/:id', (req, res) => {
        const row = getDeviceRequest(db, req.params.id);
        if (!row)
            return res.status(404).json({ error: 'Request not found' });
        if (row.status === 'pending' && Date.now() > row.expires_at) {
            return res.json({ status: 'expired' });
        }
        if (row.status === 'approved') {
            return res.json({ status: 'approved', agentId: row.agent_id, agentSecret: row.agent_secret });
        }
        return res.json({ status: row.status });
    });
    // GET /api/device/pending — admin lists pending requests
    router.get('/pending', requireAuth(config), (req, res) => {
        const rows = listPendingDeviceRequests(db).filter((r) => r.expires_at > Date.now());
        return res.json({ requests: rows });
    });
    // POST /api/device/approve/:id — admin approves
    router.post('/approve/:id', requireAuth(config), (req, res) => {
        const row = getDeviceRequest(db, req.params.id);
        if (!row)
            return res.status(404).json({ error: 'Request not found' });
        if (row.status !== 'pending')
            return res.status(409).json({ error: `Request already ${row.status}` });
        if (Date.now() > row.expires_at)
            return res.status(410).json({ error: 'Request expired' });
        const agentId = crypto.randomUUID();
        const agentSecret = crypto.randomBytes(32).toString('base64url');
        const secretHash = bcrypt.hashSync(agentSecret, 12);
        upsertAgent(db, {
            id: agentId,
            name: row.hostname,
            hostname: row.hostname,
            platform: row.platform,
            shells: null,
            secretHash,
            enrolledAt: Date.now(),
        });
        approveDeviceRequest(db, row.id, agentId, agentSecret);
        audit.log('device_request_approved', req.user.username, { id: row.id, hostname: row.hostname });
        return res.json({ ok: true });
    });
    // POST /api/device/reject/:id — admin rejects
    router.post('/reject/:id', requireAuth(config), (req, res) => {
        const row = getDeviceRequest(db, req.params.id);
        if (!row)
            return res.status(404).json({ error: 'Request not found' });
        if (row.status !== 'pending')
            return res.status(409).json({ error: `Request already ${row.status}` });
        rejectDeviceRequest(db, row.id);
        audit.log('device_request_rejected', req.user.username, { id: row.id, hostname: row.hostname });
        return res.json({ ok: true });
    });
    return router;
}
module.exports = { createDeviceAuthRouter };
