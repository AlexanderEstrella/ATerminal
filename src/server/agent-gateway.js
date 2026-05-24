'use strict';

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getAgent, markAgentOnline, markAgentOffline, endSession } = require('../db');

const VALID_SHELLS = new Set(['powershell', 'cmd', 'wsl', 'bash', 'zsh', 'sh', 'fish']);

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_PERSISTED_OUTPUT_CHARS = 500 * 1024;

function createAgentGateway(httpServer, db, audit) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/agent' });

  // agentId → ws
  const agentConnections = new Map();
  // sessionId → agentId
  const sessionAgentMap = new Map();
  // sessionId → { onOutput, onExit }
  const sessionBrowserCbs = new Map();
  const pendingRequests = new Map();
  // sessionId -> { chunks: string[], bytes: number }
  const sessionOutputBuffers = new Map();
  const MAX_BUFFER_BYTES = 500 * 1024;
  let agentBroadcaster = null;

  wss.on('connection', (ws, req) => {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      ws.close(4001, 'No auth');
      return;
    }

    const credentials = authHeader.slice(7); // strip 'Bearer '
    const colonIdx = credentials.indexOf(':');
    if (colonIdx === -1) {
      ws.close(4001, 'No auth');
      return;
    }
    const agentId = credentials.slice(0, colonIdx);
    const agentSecret = credentials.slice(colonIdx + 1);

    const agent = getAgent(db, agentId);
    if (!agent) {
      ws.close(4002, 'Unknown agent');
      return;
    }

    if (!bcrypt.compareSync(agentSecret, agent.secret_hash)) {
      ws.close(4003, 'Bad secret');
      return;
    }

    markAgentOnline(db, agentId);
    const previous = agentConnections.get(agentId);
    if (previous && previous !== ws && previous.readyState === previous.OPEN) {
      previous.close(4004, 'Replaced by new connection');
    }
    agentConnections.set(agentId, ws);
    if (agentBroadcaster) agentBroadcaster('agent:status', { agentId, hostname: agent.hostname, status: 'online' });
    audit.log('agent_connected', agentId, { hostname: agent.hostname });

    // Ping/pong keepalive
    let pongTimer = null;
    const pingInterval = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        clearInterval(pingInterval);
        return;
      }
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch (_) {
        return;
      }
      pongTimer = setTimeout(() => {
        ws.terminate();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return;
      }

      switch (msg.type) {
        case 'hello': {
          // Update agent metadata
          try {
            const shells = Array.isArray(msg.shells)
              ? JSON.stringify(msg.shells.filter((shell) => VALID_SHELLS.has(shell)))
              : null;
            db.prepare(
              'UPDATE agents SET name=?, hostname=?, platform=?, shells=? WHERE id=?'
            ).run(msg.hostname || agent.hostname, msg.hostname || agent.hostname, msg.platform || agent.platform, shells, agentId);
            reconcileAgentSessions(agentId, msg.sessions);
            if (agentBroadcaster) agentBroadcaster('sessions:changed', { agentId });
          } catch (_) {}
          break;
        }

        case 'output': {
          if (sessionAgentMap.get(msg.sessionId) !== agentId) return;
          appendOutputBuffer(msg.sessionId, msg.data);
          // Forward to browser
          for (const cbs of getSessionCallbacks(msg.sessionId).values()) {
            cbs.onOutput(msg.data);
          }
          break;
        }

        case 'exit': {
          if (sessionAgentMap.get(msg.sessionId) !== agentId) return;
          try { endSession(db, msg.sessionId); } catch (_) {}
          for (const cbs of getSessionCallbacks(msg.sessionId).values()) {
            cbs.onExit(msg.code);
          }
          if (agentBroadcaster) agentBroadcaster('sessions:changed', { agentId });
          sessionBrowserCbs.delete(msg.sessionId);
          sessionAgentMap.delete(msg.sessionId);
          break;
        }

        case 'pong': {
          if (pongTimer) {
            clearTimeout(pongTimer);
            pongTimer = null;
          }
          break;
        }

        case 'response': {
          const pending = pendingRequests.get(msg.requestId);
          if (!pending || pending.agentId !== agentId) return;
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.requestId);
          if (msg.ok) pending.resolve(msg.data);
          else pending.reject(new Error(msg.error || 'Agent request failed'));
          break;
        }

        default:
          break;
      }
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      if (pongTimer) clearTimeout(pongTimer);
      if (agentConnections.get(agentId) === ws) {
        markAgentOffline(db, agentId);
        agentConnections.delete(agentId);
        rejectAgentRequests(agentId, new Error('Agent disconnected'));
        if (agentBroadcaster) agentBroadcaster('agent:status', { agentId, status: 'offline' });
        audit.log('agent_disconnected', agentId, {});
      }
    });
  });

  // --- Public interface ---

  function sendToAgent(agentId, msg) {
    const ws = agentConnections.get(agentId);
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function requestAgent(agentId, msg, timeoutMs = 10_000) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error('Agent request timed out'));
      }, timeoutMs);

      pendingRequests.set(requestId, { agentId, resolve, reject, timer });
      const sent = sendToAgent(agentId, { ...msg, requestId });
      if (!sent) {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        reject(new Error('Agent is offline'));
      }
    });
  }

  function rejectAgentRequests(agentId, err) {
    for (const [requestId, pending] of pendingRequests.entries()) {
      if (pending.agentId !== agentId) continue;
      clearTimeout(pending.timer);
      pending.reject(err);
      pendingRequests.delete(requestId);
    }
  }

  function listConnectedAgents() {
    return [...agentConnections.keys()];
  }

  function registerSessionCallbacks(sessionId, agentId, { onOutput, onExit }) {
    sessionAgentMap.set(sessionId, agentId);
    if (!sessionBrowserCbs.has(sessionId)) sessionBrowserCbs.set(sessionId, new Map());
    const callbackId = crypto.randomUUID();
    sessionBrowserCbs.get(sessionId).set(callbackId, { onOutput, onExit });
    return callbackId;
  }

  function removeSessionCallbacks(sessionId, callbackId) {
    if (!callbackId) {
      sessionBrowserCbs.delete(sessionId);
      return;
    }
    const callbacks = sessionBrowserCbs.get(sessionId);
    if (!callbacks) return;
    callbacks.delete(callbackId);
    if (callbacks.size === 0) sessionBrowserCbs.delete(sessionId);
  }

  function removeSession(sessionId) {
    sessionAgentMap.delete(sessionId);
    sessionBrowserCbs.delete(sessionId);
    // Keep recent output available for ended-session context until process restart.
  }

  function getAgentForSession(sessionId) {
    return sessionAgentMap.get(sessionId);
  }

  function disconnectAgent(agentId) {
    const ws = agentConnections.get(agentId);
    if (ws && ws.readyState === ws.OPEN) {
      ws.close(4005, 'Agent unpaired');
    }
  }

  function getOutputBuffer(sessionId) {
    const liveBuffer = sessionOutputBuffers.get(sessionId)?.chunks;
    if (liveBuffer && liveBuffer.length > 0) return liveBuffer;
    const persisted = getPersistedOutput(sessionId);
    return persisted ? [persisted] : [];
  }

  function appendOutputBuffer(sessionId, data) {
    if (typeof data !== 'string' || data.length === 0) return;
    if (!sessionOutputBuffers.has(sessionId)) {
      sessionOutputBuffers.set(sessionId, { chunks: [], bytes: 0 });
    }
    const buffer = sessionOutputBuffers.get(sessionId);
    buffer.chunks.push(data);
    buffer.bytes += Buffer.byteLength(data, 'utf8');
    appendPersistedOutput(sessionId, data);

    while (buffer.bytes > MAX_BUFFER_BYTES && buffer.chunks.length > 1) {
      const removed = buffer.chunks.shift();
      buffer.bytes -= Buffer.byteLength(removed, 'utf8');
    }

    if (buffer.bytes > MAX_BUFFER_BYTES && buffer.chunks.length === 1) {
      buffer.chunks[0] = buffer.chunks[0].slice(-MAX_BUFFER_BYTES);
      buffer.bytes = Buffer.byteLength(buffer.chunks[0], 'utf8');
    }
  }

  function getSessionCallbacks(sessionId) {
    return sessionBrowserCbs.get(sessionId) || new Map();
  }

  function setBroadcaster(fn) {
    agentBroadcaster = fn;
  }

  function reconcileAgentSessions(agentId, sessionIds) {
    if (!Array.isArray(sessionIds)) return;
    const live = new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0));
    const activeRows = db.prepare(
      "SELECT id FROM sessions WHERE agent_id = ? AND status = 'active'"
    ).all(agentId);
    for (const row of activeRows) {
      if (live.has(row.id)) {
        sessionAgentMap.set(row.id, agentId);
      } else {
        try { endSession(db, row.id); } catch (_) {}
        sessionAgentMap.delete(row.id);
      }
    }
  }

  function appendPersistedOutput(sessionId, data) {
    try {
      db.prepare(
        `INSERT INTO session_output (session_id, data, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id)
         DO UPDATE SET
           data = substr(session_output.data || excluded.data, ?),
           updated_at = excluded.updated_at`
      ).run(sessionId, data, Date.now(), -MAX_PERSISTED_OUTPUT_CHARS);
    } catch (_) {}
  }

  function getPersistedOutput(sessionId) {
    try {
      return db.prepare('SELECT data FROM session_output WHERE session_id = ?').get(sessionId)?.data || '';
    } catch (_) {
      return '';
    }
  }

  return {
    sendToAgent,
    requestAgent,
    listConnectedAgents,
    registerSessionCallbacks,
    removeSessionCallbacks,
    removeSession,
    getAgentForSession,
    disconnectAgent,
    getOutputBuffer,
    setBroadcaster,
  };
}

module.exports = { createAgentGateway };
