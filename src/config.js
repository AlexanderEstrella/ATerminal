'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { openDb, createUser } = require('./db');

const CONFIG_DIR = process.env.ATERMINAL_CONFIG_DIR
  ? path.resolve(process.env.ATERMINAL_CONFIG_DIR)
  : path.join(os.homedir(), '.aterminal');
const SERVER_CONFIG_PATH = path.join(CONFIG_DIR, 'server.json');
const AGENT_CONFIG_PATH = path.join(CONFIG_DIR, 'agent.json');

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch (_) {}
}

function writeSecretJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

function requireStrongPassword(password) {
  if (!password || password.length < 12) {
    throw new Error('Admin password must be at least 12 characters.');
  }
}

// ── Interactive prompt helper ───────────────────────────────────────────────

function prompt(rl, question, defaultVal) {
  return new Promise((resolve) => {
    const label = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    rl.question(label, (ans) => resolve(ans.trim() || defaultVal || ''));
  });
}

function promptPassword(question) {
  return new Promise((resolve) => {
    process.stdout.write(`${question}: `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    let pass = '';
    stdin.on('data', function handler(ch) {
      ch = ch.toString();
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode?.(wasRaw);
        stdin.pause();
        stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(pass);
      } else if (ch === '') {
        process.exit(1);
      } else if (ch === '') {
        if (pass.length > 0) { pass = pass.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        pass += ch;
        process.stdout.write('*');
      }
    });
  });
}

// ── Server config ──────────────────────────────────────────────────────────

async function initServer(opts = {}) {
  ensureConfigDir();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const portStr = opts.port != null
    ? String(opts.port)
    : await prompt(rl, 'Server port', '3000');
  const port = parseInt(portStr) || 3000;
  const host = opts.host || '127.0.0.1';

  const adminUser = opts.adminUser || await prompt(rl, 'Admin username', 'admin');

  let adminPass = opts.adminPass;
  if (!adminPass) {
    while (true) {
      adminPass = await promptPassword('Admin password (min 12 chars)');
      if (adminPass.length >= 12) break;
      console.log('Password must be at least 12 characters.');
    }
  }
  requireStrongPassword(adminPass);

  rl.close();

  const jwtSecret = crypto.randomBytes(64).toString('hex');
  const dbPath = path.join(CONFIG_DIR, 'aterminal.db');

  const config = { host, port, jwtSecret, dbPath, adminUser };
  writeServerConfig(config);

  const db = openDb(dbPath);
  const passwordHash = bcrypt.hashSync(adminPass, 12);
  try {
    createUser(db, { id: crypto.randomUUID(), username: adminUser, passwordHash, role: 'admin' });
  } catch (err) {
    if (!err.message.includes('UNIQUE')) throw err;
    // User already exists from a previous init — leave it
  }

  console.log('\nSetup complete!');
  console.log(`  Config: ${SERVER_CONFIG_PATH}`);
  console.log(`  Database: ${dbPath}`);
  console.log('\nRun: aterminal server start');
}

function readServerConfig() {
  if (!fs.existsSync(SERVER_CONFIG_PATH)) {
    throw new Error(`Server not initialized. Run: aterminal server init`);
  }
  const config = JSON.parse(fs.readFileSync(SERVER_CONFIG_PATH, 'utf8'));
  if (!config.jwtSecret || config.jwtSecret.length < 64) {
    throw new Error('Server config has an invalid jwtSecret. Re-run: aterminal server init');
  }
  if (!config.dbPath) {
    config.dbPath = path.join(CONFIG_DIR, 'aterminal.db');
  }
  config.host = config.host || '127.0.0.1';
  config.port = parseInt(config.port) || 3000;
  return config;
}

function writeServerConfig(config) {
  ensureConfigDir();
  writeSecretJson(SERVER_CONFIG_PATH, config);
}

// ── Agent config ───────────────────────────────────────────────────────────

function readAgentConfig() {
  if (!fs.existsSync(AGENT_CONFIG_PATH)) {
    throw new Error(`Agent not enrolled. Run: aterminal agent enroll --server <url> --token <token>`);
  }
  return JSON.parse(fs.readFileSync(AGENT_CONFIG_PATH, 'utf8'));
}

function writeAgentConfig(config) {
  ensureConfigDir();
  writeSecretJson(AGENT_CONFIG_PATH, config);
}

module.exports = { initServer, readServerConfig, writeServerConfig, readAgentConfig, writeAgentConfig };
