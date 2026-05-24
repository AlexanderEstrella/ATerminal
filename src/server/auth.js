'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getUser } = require('../db');

function signToken(user, jwtSecret) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    jwtSecret,
    { expiresIn: '24h' }
  );
}

function requireAuth(config) {
  return function (req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const token = authHeader.slice(7);
    try {
      req.user = jwt.verify(token, config.jwtSecret);
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

function createAuthRouter(db, config, audit) {
  const router = express.Router();

  // POST /api/auth/login
  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }

    const user = getUser(db, username);
    if (!user) {
      audit.log('login_failed', username, { reason: 'user_not_found' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = bcrypt.compareSync(password, user.password_hash);
    if (!match) {
      audit.log('login_failed', username, { reason: 'bad_password' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user, config.jwtSecret);
    audit.log('login_success', username, {});
    return res.json({ token, user: { username: user.username, role: user.role } });
  });

  // POST /api/auth/change-password — change own password
  router.post('/change-password', requireAuth(config), (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword required' });
    }
    if (newPassword.length < 12) {
      return res.status(400).json({ error: 'New password must be at least 12 characters' });
    }

    const user = getUser(db, req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = bcrypt.hashSync(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(newHash, user.username);
    return res.json({ ok: true });
  });

  return router;
}

module.exports = { createAuthRouter, requireAuth, signToken };
