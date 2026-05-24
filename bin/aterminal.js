#!/usr/bin/env node
'use strict';

const path = require('path');
const { program } = require('commander');
const { version } = require('../package.json');

program
  .name('aterminal')
  .description('ATerminal — self-hosted remote terminal platform')
  .version(version);

// ── Server commands ─────────────────────────────────────────────────────────

const server = program.command('server').description('Manage the ATerminal server');

server
  .command('init')
  .description('Initialize the server (first-time setup)')
  .option('--host <host>', 'Host/interface to bind', '127.0.0.1')
  .option('--port <port>', 'Port to listen on', '3000')
  .option('--admin-user <user>', 'Admin username', 'admin')
  .option('--admin-pass <pass>', 'Admin password (skip interactive prompt)')
  .action(async (opts) => {
    const { initServer } = require('../src/config');
    try {
      await initServer({
        host: opts.host,
        port: parseInt(opts.port),
        adminUser: opts.adminUser,
        adminPass: opts.adminPass,
      });
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  });

server
  .command('start')
  .description('Start the ATerminal server')
  .action(async () => {
    const { readServerConfig } = require('../src/config');
    const { startServer } = require('../src/server/index');
    try {
      const config = readServerConfig();
      await startServer(config);
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  });

server
  .command('setup')
  .description('Initialize the server if needed, then start it')
  .option('--host <host>', 'Host/interface to bind on first init', '127.0.0.1')
  .option('--lan', 'Bind on all interfaces on first init and print a LAN URL')
  .option('--port <port>', 'Port to listen on first init', '3000')
  .option('--admin-user <user>', 'Admin username for first init', 'admin')
  .option('--admin-pass <pass>', 'Admin password for first init')
  .option('--public-url <url>', 'External URL to print and encode in the setup QR')
  .option('--cloudflare', 'Start a Cloudflare quick tunnel and use its HTTPS URL')
  .option('--tailscale', 'Use Tailscale Funnel for a stable HTTPS URL via your tailnet')
  .option('--no-qr', 'Do not print a terminal QR code')
  .action(async (opts) => {
    const { initServer, readServerConfig } = require('../src/config');
    const { writeServerConfig } = require('../src/config');
    const { startServer } = require('../src/server/index');

    try {
      const exclusiveFlags = [opts.cloudflare, opts.tailscale, !!opts.publicUrl].filter(Boolean).length;
      if (exclusiveFlags > 1) {
        throw new Error('Use only one of --cloudflare, --tailscale, or --public-url.');
      }

      let config;
      try {
        config = readServerConfig();
        if (opts.lan && config.host !== '0.0.0.0') {
          config.host = '0.0.0.0';
          writeServerConfig(config);
        }
        console.log('Using existing server config.');
      } catch (err) {
        if (!err.message.includes('Server not initialized')) throw err;
        await initServer({
          host: opts.lan ? '0.0.0.0' : opts.host,
          port: parseInt(opts.port),
          adminUser: opts.adminUser,
          adminPass: opts.adminPass,
        });
        config = readServerConfig();
      }

      // If --public-url was passed, persist it in the server config
      if (opts.publicUrl) {
        const normalizedPublicUrl = normalizePublicUrl(opts.publicUrl);
        if (normalizedPublicUrl && config.publicUrl !== normalizedPublicUrl) {
          config.publicUrl = normalizedPublicUrl;
          writeServerConfig(config);
        }
      }

      await syncAdminPasswordFromEnv(config);
      await startServer(config);
      await maybeAutoEnrollLocalAgent(config);
      if (opts.cloudflare) {
        await startCloudflareQuickTunnel(config, opts);
      } else if (opts.tailscale) {
        await startTailscaleFunnel(config, opts);
      } else {
        await printSetupAccess(config, opts);
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  });

// ── Agent commands ──────────────────────────────────────────────────────────

const agent = program.command('agent').description('Manage the ATerminal agent');

agent
  .command('enroll')
  .description('Enroll this machine as an agent on an ATerminal server')
  .requiredOption('--server <url>', 'ATerminal server URL (e.g. https://terminal.example.com)')
  .option('--token <token>', 'One-time enrollment token (omit to use approval flow)')
  .action(async (opts) => {
    const os = require('os');
    const { writeAgentConfig } = require('../src/config');
    const { assertSecureServerUrl } = require('../src/url-security');

    const serverUrl = opts.server.replace(/\/$/, '');
    assertSecureServerUrl(serverUrl);

    if (opts.token) {
      try {
        const enrollUrl = serverUrl + '/api/enrollment/enroll';

        const body = JSON.stringify({
          token: opts.token,
          hostname: os.hostname(),
          platform: process.platform,
          name: os.hostname(),
        });

        console.log(`Enrolling with ${serverUrl}...`);
        const result = await httpPost(enrollUrl, body);
        writeAgentConfig({ serverUrl, agentId: result.agentId, agentSecret: result.agentSecret });
        console.log('Enrolled successfully!');
        console.log(`  Agent ID: ${result.agentId}`);
        console.log('\nRun: aterminal agent start');
      } catch (err) {
        console.error('Enrollment failed:', err.message);
        process.exit(1);
      }
    } else {
      let deviceId;
      let expiresAt;

      try {
        const requestUrl = serverUrl + '/api/device/request';
        const body = JSON.stringify({
          hostname: os.hostname(),
          platform: process.platform,
          name: os.hostname(),
        });
        const data = await httpPost(requestUrl, body);
        deviceId = data.id;
        expiresAt = data.expiresAt;
      } catch (err) {
        console.error('Device request failed:', err.message);
        process.exit(1);
      }

      console.log(`\nWaiting for admin approval in the ATerminal UI...\n  Device: ${os.hostname()}\n  Expires: ${new Date(expiresAt).toLocaleTimeString()}\n\nPress Ctrl+C to cancel.`);

      const interval = setInterval(async () => {
        if (Date.now() > expiresAt) {
          clearInterval(interval);
          console.log('\nRequest expired. Run the command again to retry.');
          process.exit(1);
        }

        try {
          const data = await httpGet(serverUrl + '/api/device/poll/' + deviceId);

          if (data.status === 'approved') {
            clearInterval(interval);
            const { writeAgentConfig } = require('../src/config');
            writeAgentConfig({ serverUrl, agentId: data.agentId, agentSecret: data.agentSecret });
            console.log(`\nApproved! Agent enrolled as ${data.agentId}\nRun: aterminal agent start`);
            process.exit(0);
          } else if (data.status === 'rejected') {
            clearInterval(interval);
            console.log('\nRequest rejected.');
            process.exit(1);
          } else if (data.status === 'expired') {
            clearInterval(interval);
            console.log('\nRequest expired. Run the command again to retry.');
            process.exit(1);
          }
          // status === 'pending' — keep polling
        } catch (err) {
          console.error('Poll error:', err.message);
          // transient error — keep polling
        }
      }, 3000);
    }
  });

agent
  .command('start')
  .description('Start the ATerminal agent and connect to the server')
  .action(async () => {
    const { readAgentConfig } = require('../src/config');
    const { startAgent } = require('../src/agent/index');
    try {
      const config = readAgentConfig();
      await startAgent(config);
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  });

// ── HTTP helper (no extra deps) ─────────────────────────────────────────────

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? require('https') : require('http');
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Invalid response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? require('https') : require('http');
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          else resolve(parsed);
        } catch {
          reject(new Error(`Invalid response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function syncAdminPasswordFromEnv(config) {
  const fs = require('fs');
  const bcrypt = require('bcryptjs');
  const { openDb, getUser } = require('../src/db');

  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;

  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/^ADMIN_PASS=(.+)$/m);
  if (!match) return;

  const adminPass = match[1].trim();
  if (!adminPass) return;

  const db = openDb(config.dbPath);
  const username = config.adminUser || 'admin';
  const user = getUser(db, username);
  if (!user) return;

  if (bcrypt.compareSync(adminPass, user.password_hash)) return;

  const hash = bcrypt.hashSync(adminPass, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
  console.log('Admin password synced from .env');
}

async function maybeAutoEnrollLocalAgent(config) {
  const crypto = require('crypto');
  const os = require('os');
  const { spawn } = require('child_process');
  const bcrypt = require('bcryptjs');
  const { openDb } = require('../src/db');
  const { writeAgentConfig, readAgentConfig } = require('../src/config');

  // Already enrolled — just start the agent
  try {
    readAgentConfig();
    console.log('Starting local agent...');
    spawnAgent();
    return;
  } catch { /* not enrolled yet */ }

  const db = openDb(config.dbPath);
  const agentCount = db.prepare('SELECT COUNT(*) as c FROM agents').get().c;

  if (agentCount > 0) {
    // Agents exist but no local config — user enrolled externally, skip auto-start
    return;
  }

  // First run: auto-enroll this machine so the user doesn't need a second terminal
  const agentId = crypto.randomUUID();
  const agentSecret = crypto.randomBytes(32).toString('base64url');
  const secretHash = bcrypt.hashSync(agentSecret, 10);
  const hostname = os.hostname();

  db.prepare(
    `INSERT INTO agents (id, name, hostname, platform, secret_hash, enrolled_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'offline')`
  ).run(agentId, `${hostname} (local)`, hostname, process.platform, secretHash, Date.now());

  writeAgentConfig({ serverUrl: `http://127.0.0.1:${config.port}`, agentId, agentSecret });

  console.log(`\nThis machine enrolled as agent "${hostname} (local)".`);
  console.log('Starting local agent...');
  spawnAgent();

  function spawnAgent() {
    const child = spawn(
      process.execPath,
      ['--no-warnings=ExperimentalWarning', path.join(__dirname, 'aterminal.js'), 'agent', 'start'],
      { stdio: 'inherit', detached: false }
    );
    child.on('error', (err) => console.error('Agent error:', err.message));
  }
}

async function printSetupAccess(config, opts) {
  const accessUrl = normalizePublicUrl(opts.publicUrl || config.publicUrl) || buildAccessUrl(config);

  console.log('\nOpen ATerminal:');
  console.log(`  ${accessUrl}`);
  console.log('\nAfter signing in, use Pair Device to show QR codes for phones and agents.');

  if (opts.qr) {
    const QRCode = require('qrcode');
    try {
      const qr = await QRCode.toString(accessUrl, { type: 'terminal', small: true, margin: 1 });
      console.log('\nScan to open from another device:');
      console.log(qr);
    } catch (_) {
      console.log('\nQR unavailable in this terminal.');
    }
  }

  if (config.host === '127.0.0.1' || config.host === 'localhost') {
    console.log('\nLocal-only mode: phones on the same network cannot reach this until you use --lan, a tunnel, or a reverse proxy.');
  }

  console.log('\nPress Ctrl+C to stop the server.');
}

async function startCloudflareQuickTunnel(config, opts) {
  const { spawn, spawnSync } = require('child_process');
  const check = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
  if (check.error) {
    throw new Error(`cloudflared was not found. ${cloudflaredInstallHint()}`);
  }
  if (check.status !== 0) {
    const details = (check.stderr || check.stdout || '').trim();
    throw new Error(`cloudflared check failed.${details ? ` ${details}` : ''}`);
  }

  const originUrl = buildCloudflareOriginUrl(config);
  console.log(`\nStarting Cloudflare Tunnel to ${originUrl}...`);

  const child = spawn('cloudflared', ['tunnel', '--url', originUrl], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  let printed = false;

  const stopTunnel = () => {
    if (!child.killed) child.kill();
  };
  process.once('exit', stopTunnel);
  process.once('SIGINT', () => {
    stopTunnel();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    stopTunnel();
    process.exit(0);
  });

  await new Promise((resolve, reject) => {
    const handleOutput = (stream, chunk) => {
      const text = chunk.toString();
      stream.write(text);
      output = (output + text).slice(-8000);

      if (printed) return;
      const publicUrl = findTryCloudflareUrl(output);
      if (!publicUrl) return;

      printed = true;
      config.publicUrl = publicUrl;
      printSetupAccess(config, { ...opts, publicUrl }).then(resolve, reject);
    };

    child.stdout.on('data', (chunk) => handleOutput(process.stdout, chunk));
    child.stderr.on('data', (chunk) => handleOutput(process.stderr, chunk));
    child.on('error', (err) => {
      if (!printed) reject(err);
    });
    child.on('exit', (code, signal) => {
      if (!printed) {
        reject(new Error(`cloudflared stopped before publishing a tunnel URL (${signal || code}).`));
        return;
      }
      console.log(`\ncloudflared stopped (${signal || code}). The Cloudflare URL is no longer active.`);
    });
  });
}

async function startTailscaleFunnel(config, opts) {
  const { spawn, spawnSync } = require('child_process');

  // Verify tailscale CLI is available (fall back to known Windows install path)
  const tailscaleBin = findTailscaleBin();
  if (!tailscaleBin) {
    throw new Error(
      `tailscale was not found. ${tailscaleInstallHint()}\n` +
      `If you just installed it, open a new terminal window and try again.`
    );
  }

  // Get the stable MagicDNS hostname — the URL is known before serve starts
  const statusCheck = spawnSync(tailscaleBin, ['status', '--json'], { encoding: 'utf8' });
  if (statusCheck.status !== 0 || !statusCheck.stdout.trim()) {
    throw new Error('tailscale status failed. Is Tailscale running and are you logged in?');
  }

  let tsStatus;
  try {
    tsStatus = JSON.parse(statusCheck.stdout);
  } catch {
    throw new Error('Could not parse tailscale status output.');
  }

  const backendState = tsStatus.BackendState;
  if (backendState && backendState !== 'Running') {
    throw new Error(`Tailscale is not running (state: ${backendState}). Start Tailscale and log in first.`);
  }

  const dnsName = tsStatus.Self?.DNSName;
  if (!dnsName) {
    throw new Error(
      'Tailscale MagicDNS hostname not available.\n' +
      'Enable MagicDNS at: https://login.tailscale.com/admin/dns'
    );
  }

  const hostname = dnsName.replace(/\.$/, ''); // strip trailing DNS dot
  const publicUrl = `https://${hostname}`;
  const port = config.port || 3000;

  console.log(`\nStarting Tailscale Serve on port ${port}...`);
  console.log('Access is restricted to devices on your tailnet.\n');

  const child = spawn(tailscaleBin, ['serve', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  let settled = false;

  const stopServe = () => {
    if (!child.killed) child.kill();
    // Best-effort: clear the serve rule when the server stops
    spawnSync(tailscaleBin, ['serve', 'reset'], { encoding: 'utf8', timeout: 5000 });
  };
  process.once('exit', stopServe);
  process.once('SIGINT', () => { stopServe(); process.exit(0); });
  process.once('SIGTERM', () => { stopServe(); process.exit(0); });

  await new Promise((resolve, reject) => {
    const relay = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      output = (output + text).slice(-4000);
    };

    child.stdout.on('data', relay);
    child.stderr.on('data', relay);

    // Give the command 10 s to fail; if still running assume serve is active
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(); }
    }, 10000);

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error(`tailscale serve error: ${err.message}`)); }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        if (code === 0) {
          // Stateful mode: command configured serve and exited cleanly
          resolve();
        } else {
          const notLoggedIn = output.toLowerCase().includes('log in') || output.toLowerCase().includes('not logged');
          const hint = notLoggedIn
            ? '\n\nLog in to Tailscale first:\n  tailscale login'
            : '\n\nMake sure Tailscale is running and you are logged in.';
          reject(new Error(`tailscale serve exited with code ${code}.${hint}\n${output.slice(-400)}`));
        }
      }
    });
  });

  config.publicUrl = publicUrl;
  await printSetupAccess(config, { ...opts, publicUrl });
}

function findTailscaleBin() {
  const { spawnSync } = require('child_process');
  const check = spawnSync('tailscale', ['--version'], { encoding: 'utf8' });
  if (!check.error) return 'tailscale';
  if (process.platform === 'win32') {
    const fs = require('fs');
    const candidates = [
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function tailscaleInstallHint() {
  if (process.platform === 'win32') return 'Download from: https://tailscale.com/download/windows';
  if (process.platform === 'darwin') return 'Install with: brew install tailscale';
  return 'Install from: https://tailscale.com/download/linux';
}

function normalizePublicUrl(value) {
  if (!value) return null;
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('--public-url must use http:// or https://');
  }
  return parsed.toString().replace(/\/$/, '');
}

function findTryCloudflareUrl(text) {
  const match = text.match(/\bhttps:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  return match ? match[0] : null;
}

function buildCloudflareOriginUrl(config) {
  const host = config.host === '0.0.0.0' || config.host === '::'
    ? '127.0.0.1'
    : config.host || '127.0.0.1';
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${hostname}:${config.port}`;
}

function cloudflaredInstallHint() {
  if (process.platform === 'win32') {
    return 'Install it first with: winget install --id Cloudflare.cloudflared';
  }
  if (process.platform === 'darwin') {
    return 'Install it first with: brew install cloudflared';
  }
  return 'Install it first from: https://developers.cloudflare.com/tunnel/downloads/';
}

function buildAccessUrl(config) {
  const host = config.host === '0.0.0.0' || config.host === '::'
    ? findLanAddress() || '127.0.0.1'
    : config.host;
  return `http://${host}:${config.port}`;
}

function findLanAddress() {
  const os = require('os');
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

program.parse(process.argv);
