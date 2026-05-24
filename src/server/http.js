'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { createAuthRouter, requireAuth } = require('./auth');
const { createEnrollmentRouter } = require('./enrollment');
const { createApiRouter } = require('./browser-ws');
const { createDeviceAuthRouter } = require('./device-auth');

function createHttpServer(db, config, audit) {
  const app = express();

  // Trust the first proxy hop (Tailscale Serve, Cloudflare, etc.) so
  // express-rate-limit can read X-Forwarded-For without throwing.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '32kb' }));
  app.use('/vendor/xterm', express.static(path.join(__dirname, '../../node_modules/@xterm/xterm')));
  app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, '../../node_modules/@xterm/addon-fit')));
  app.use('/vendor/xterm-addon-web-links', express.static(path.join(__dirname, '../../node_modules/@xterm/addon-web-links')));
  app.use(express.static(path.join(__dirname, '../../public')));

  // Unauthenticated health check for uptime monitors
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
  });

  // Rate limiters
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please try again later' },
  });

  const enrollmentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many enrollment requests, please try again later' },
  });

  // Mount routers
  app.use('/api/auth/login', loginLimiter);
  app.use('/api/auth', createAuthRouter(db, config, audit));

  app.use('/api/enrollment', enrollmentLimiter);
  app.use('/api/enrollment', createEnrollmentRouter(db, config, audit));

  const deviceLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many device requests, please try again later' },
  });

  app.use('/api/device', deviceLimiter);
  app.use('/api/device', createDeviceAuthRouter(db, config, audit));

  // File download — auth required, proxied through agent
  app.get('/api/download', requireAuth(config), async (req, res) => {
    const agentId = typeof req.query.agent === 'string' ? req.query.agent : '';
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';

    if (!agentId || !filePath) {
      return res.status(400).json({ error: 'agent and path query params required' });
    }
    if (filePath.length > 2048) return res.status(400).json({ error: 'path too long' });
    if (!canAccessAgentFilesystem(db, req.user, agentId)) {
      audit.log('file_download_denied', req.user.username, { agentId });
      return res.status(403).json({ error: 'Not authorized for this agent' });
    }

    const agentGateway = app.get('agentGateway');
    try {
      const result = await agentGateway.requestAgent(agentId, { type: 'fs:read', path: filePath }, 30_000);
      const filename = filePath.split(/[\\/]/).pop() || 'download';
      const buf = Buffer.from(result.data, 'base64');
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', buf.length);
      res.end(buf);
    } catch (err) {
      res.status(502).json({ error: err.message || 'Failed to read file from agent' });
    }
  });

  // All other /api routes require authentication
  // createApiRouter is called lazily so agentGateway is available after http.js
  // returns — we attach it via app.set('agentGateway', ...) in index.js.
  app.use('/api', requireAuth(config), (req, res, next) => {
    const agentGateway = req.app.get('agentGateway');
    createApiRouter(db, config, agentGateway, audit)(req, res, next);
  });

  // SPA catch-all: serve index.html for non-/api routes
  app.get(/^(?!\/api).*$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
  });

  const server = http.createServer(app);
  return { app, server };
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  next();
}

function canAccessAgentFilesystem(db, user, agentId) {
  if (!user || !agentId) return false;
  if (user.role === 'admin') return true;
  const row = db.prepare(
    'SELECT id FROM sessions WHERE agent_id = ? AND (owner IS NULL OR owner = ?) LIMIT 1'
  ).get(agentId, user.username);
  return Boolean(row);
}

module.exports = { createHttpServer };
