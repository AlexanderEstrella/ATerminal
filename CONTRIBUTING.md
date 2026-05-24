# Contributing

## Run locally

```bash
git clone https://github.com/alexestrella/aterminal
cd aterminal
npm install
npm run setup         # first run: creates ~/.aterminal/server.json and prompts for admin password
npm run dev           # starts the server with nodemon
```

Open `http://localhost:3000` and sign in with the admin credentials you chose during setup.

## Project structure

- `bin/aterminal.js` — CLI entry point (commander)
- `src/server/` — Express + Socket.IO server, auth, agent gateway
- `src/agent/` — PTY manager and agent connector (runs on the machine that hosts shell sessions)
- `src/config.js` — server init, config read/write to `~/.aterminal/`
- `public/` — xterm.js frontend (vanilla JS, no build step)

## Pull requests

- Keep changes focused — one logical change per PR.
- Run `npm test` if tests exist; otherwise describe how you verified the change.
- Match the existing code style — no linter is enforced, just be consistent.
- For significant changes, open an issue first to discuss the approach.

## License

By contributing, you agree your changes will be licensed under [AGPL-3.0-or-later](LICENSE).
