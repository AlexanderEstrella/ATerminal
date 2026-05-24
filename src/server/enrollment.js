'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createEnrollmentToken, useEnrollmentToken, upsertAgent, fingerprintEnrollmentToken } = require('../db');
const { requireAuth } = require('./auth');
const VALID_PLATFORMS = new Set(['win32', 'darwin', 'linux', 'freebsd', 'openbsd']);
function createEnrollmentRouter(db, config, audit) {
    const router = express.Router();
    // POST /api/enrollment/tokens — admin only, creates a new enrollment token
    router.post('/tokens', requireAuth(config), (req, res) => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin role required' });
        }
        const token = crypto.randomBytes(32).toString('base64url');
        createEnrollmentToken(db, { token, createdBy: req.user.username });
        audit.log('enrollment_token_created', req.user.username, {
            tokenFingerprint: fingerprintEnrollmentToken(token),
        });
        return res.json({ token });
    });
    // POST /api/enrollment/enroll — no auth required, called by the agent CLI
    router.post('/enroll', (req, res) => {
        const { token, hostname, platform, name } = req.body || {};
        if (!isNonEmptyString(token) || !isNonEmptyString(hostname) || !isNonEmptyString(platform)) {
            return res.status(400).json({ error: 'token, hostname, and platform are required' });
        }
        if (!VALID_PLATFORMS.has(platform)) {
            return res.status(400).json({ error: 'Unsupported platform' });
        }
        const agentId = crypto.randomUUID();
        try {
            useEnrollmentToken(db, token, agentId);
        }
        catch (err) {
            if (err.message && err.message.includes('Token already used')) {
                return res.status(409).json({ error: 'Enrollment token already used' });
            }
            return res.status(404).json({ error: 'Enrollment token not found' });
        }
        const cleanHostname = hostname.trim().slice(0, 255);
        const cleanName = isNonEmptyString(name) ? name.trim().slice(0, 255) : cleanHostname;
        const agentSecret = crypto.randomBytes(32).toString('base64url');
        const secretHash = bcrypt.hashSync(agentSecret, 12);
        upsertAgent(db, {
            id: agentId,
            name: cleanName,
            hostname: cleanHostname,
            platform,
            secretHash,
            enrolledAt: Date.now(),
        });
        audit.log('agent_enrolled', 'system', { agentId, hostname: cleanHostname, platform });
        return res.json({ agentId, agentSecret });
    });
    return router;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
module.exports = { createEnrollmentRouter };
