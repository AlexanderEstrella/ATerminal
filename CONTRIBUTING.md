# Contributing

## Prerequisites

- **Node.js 22+**
- **node-pty** requires native compilation. Install build tools before `npm install`:

  ```bash
  # macOS
  xcode-select --install

  # Ubuntu/Debian
  sudo apt install build-essential python3

  # Windows (run as Administrator)
  npm install --global windows-build-tools
  # or install "Desktop development with C++" from Visual Studio installer
  ```

## Run locally

```bash
git clone https://github.com/AlexanderEstrella/ATerminal
cd ATerminal
npm install
npm run build         # compile TypeScript → JS (required after any .ts change)
npm run setup         # first run: creates ~/.aterminal/server.json and prompts for admin password
npm run dev           # starts the server with nodemon (auto-rebuilds on .ts changes)
```

Open `http://localhost:3000` and sign in with the admin credentials you chose during setup.

## Project structure

```
bin/aterminal.js          CLI entry point (commander) — server and agent subcommands
src/
  server/
    index.ts              startup: opens DB, creates HTTP server + WebSocket servers
    http.ts               Express app, routes, security headers
    auth.ts               JWT login/logout, requireAuth middleware
    browser-ws.ts         Socket.IO — browser ↔ server real-time channel
    agent-gateway.ts      WebSocket server for agent connections, session I/O routing
    enrollment.ts         One-time token enrollment flow
    device-auth.ts        Approval-based enrollment (no token)
    ntfy.ts               Push notifications via ntfy (fire-and-forget HTTP POST)
    audit.ts              Append-only audit log
    origin.ts             Allowed-origin validation
  agent/
    index.ts              Agent startup
    connector.ts          WebSocket client that connects to the server
    pty-manager.ts        Spawns and manages PTY processes (node-pty)
    shell-detect.ts       Detects available shells on the local machine
    fs-browser.ts         File read handler for the download endpoint
  config.ts               Read/write ~/.aterminal/server.json and agent.json
  db.ts                   SQLite schema, migrations, and query helpers
  url-security.ts         Validates server URLs for agent enrollment
public/
  app.ts                  Frontend (xterm.js + Socket.IO) — compiled to app.js
  index.html              SPA shell
  style.css               UI styles
  manifest.json           PWA manifest
types/
  browser-globals.d.ts    Type shims for xterm.js and Socket.IO globals in app.ts
```

## TypeScript workflow

Source files are `.ts`. The compiled `.js` files are committed alongside them so the package works after `npm install -g` without requiring users to run a build step.

- Edit `.ts` files — never edit `.js` directly.
- Run `npm run build` after any change to recompile.
- `npm run dev` uses nodemon to watch `.ts` files and rebuild automatically.
- `npm run typecheck` runs the compiler without emitting to check for errors only.

## Pull requests

- Keep changes focused — one logical change per PR.
- Run `npm run typecheck` before submitting; fix any type errors.
- Match the existing code style — no linter is enforced, just be consistent.
- For significant changes, open an issue first to discuss the approach.

## License

By contributing, you agree your changes will be licensed under [AGPL-3.0-or-later](LICENSE).
