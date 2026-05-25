# ATerminal — AI Agent Context

Self-hosted remote terminal server. Node.js backend (Express + Socket.IO + WebSocket) with an xterm.js browser frontend. Exposes PTY shell sessions from one or more machines ("agents") to any browser over Tailscale or a local network.

## Architecture

```
Browser (xterm.js)
    ↕  Socket.IO (/ws/browser)
Server (Express)
    ↕  WebSocket (/ws/agent)
Agent (node-pty)  ← runs on the machine with the shell
```

- The **server** is a hub. It does not spawn shells itself.
- Each **agent** connects outbound to the server, spawns PTYs on demand, and streams output back.
- The **browser** connects to the server, which routes I/O between browser and agent.
- One machine can run both server and agent (the default local setup).

## Key files

| Path | What it does |
|------|--------------|
| `bin/aterminal.js` | CLI entry point (`aterminal server setup`, `aterminal agent enroll`, etc.) |
| `src/server/index.ts` | Startup: opens DB, wires HTTP + both WebSocket servers |
| `src/server/http.ts` | Express app, security headers, rate limiting, static files |
| `src/server/browser-ws.ts` | Socket.IO — browser channel (sessions, terminal I/O, file ops) |
| `src/server/agent-gateway.ts` | WebSocket server for agent connections; routes output/exit to browser callbacks |
| `src/server/auth.ts` | JWT login, `requireAuth` middleware |
| `src/server/ntfy.ts` | Push notifications on session exit (fire-and-forget POST) |
| `src/agent/connector.ts` | Agent-side WebSocket client; reconnects on drop |
| `src/agent/pty-manager.ts` | Spawns/resizes/kills PTYs via node-pty |
| `src/config.ts` | Read/write `~/.aterminal/server.json` and `~/.aterminal/agent.json` |
| `src/db.ts` | SQLite schema, migrations, query helpers (better-sqlite3) |
| `public/app.ts` | Browser frontend — compiled to `public/app.js` |

## Data flow: opening a terminal

1. Browser calls `POST /api/sessions` → server inserts a session row, returns `sessionId`.
2. Browser emits `terminal:attach { sessionId }` over Socket.IO.
3. Server calls `agentGateway.sendToAgent(agentId, { type: 'spawn', sessionId, shell })`.
4. Agent spawns a PTY, sends `{ type: 'output', sessionId, data }` messages back.
5. Server fans output to all browsers attached to that session via registered callbacks.
6. Browser sends keystrokes as `terminal:input { sessionId, data }`.

## Config files (runtime, not in repo)

- `~/.aterminal/server.json` — host, port, JWT secret, admin user, ntfy config, DB path
- `~/.aterminal/agent.json` — server URL, agentId, agentSecret
- `~/.aterminal/aterminal.db` — SQLite: users, agents, sessions, session_output, audit_log

## Build

```bash
npm install          # installs deps; node-pty requires native build tools
npm run build        # tsc -p tsconfig.json && tsc -p tsconfig.browser.json
npm run typecheck    # type-check only, no emit
npm run dev          # nodemon: watch .ts, rebuild, restart server
```

Source is `.ts`. Compiled `.js` is committed so `npm install -g` users get a working package without running a build step. **Always edit `.ts`, never `.js` directly.**

## Native dependency note

`node-pty` compiles native code. On a fresh machine you need:
- macOS: `xcode-select --install`
- Linux: `sudo apt install build-essential python3`
- Windows: Visual Studio "Desktop development with C++" workload, or `npm install -g windows-build-tools` (run as Administrator)

## Security model

- Tailscale (`tailscale serve`) provides network-level access control (only tailnet devices can reach the server).
- ATerminal adds application-level auth: bcrypt-hashed password → JWT session token.
- Rate limiting on login (10 req/15 min) and enrollment (5 req/15 min) endpoints.
- CSP, X-Frame-Options, X-Content-Type-Options headers set on all responses.
- Agent secrets are bcrypt-hashed in the DB; enrollment tokens are one-time use.
- Remote agents require HTTPS (enforced in `url-security.ts`).

## Common tasks

**Add a new API endpoint:** add a route in `src/server/browser-ws.ts` (Socket.IO) or `src/server/http.ts` (REST), behind `requireAuth`.

**Add a new agent message type:** handle it in `src/agent/connector.ts` (agent side) and `src/server/agent-gateway.ts` (server side, `ws.on('message')` switch).

**Change the DB schema:** add a migration in `src/db.ts` in the `runMigrations` function. Migrations run automatically on startup.

**Test a change:** `npm run build && npm run setup` (starts server), then open `http://localhost:3000`.
