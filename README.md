# ATerminal

You're at a coffee shop. Your build is running on your home machine. You want to check it from your phone.

ATerminal is a self-hosted terminal server that runs on your machine and exposes a full xterm.js shell to any browser — no cloud, no subscriptions, just your machine behind your own access control. Works over LAN, Tailscale (recommended — stable HTTPS URL that never changes), or any Cloudflare tunnel. Installs as a PWA on iPhone and Android. Supports multiple named terminal agents across multiple machines.

## One-Command Setup

From a GitHub checkout on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

From a GitHub checkout on macOS/Linux:

```bash
npm install && npm start
```

From npm after publish:

```bash
npm install -g @aterminal/aterminal
aterminal server setup
```

For same-network phone access, use LAN mode:

```bash
aterminal server setup --lan
```

For a stable private HTTPS URL via Tailscale (recommended — URL never changes, only reachable by devices on your tailnet):

**Both the server computer and any client devices must have Tailscale installed and be logged in to the same account.**

Install Tailscale on Windows:
```powershell
winget install Tailscale.Tailscale
```

Then start ATerminal with Tailscale Serve:
```bash
aterminal server setup --tailscale
```

Or from this checkout:
```bash
npm run setup:tailscale
```

This reads your machine's stable `https://<name>.ts.net` hostname from `tailscale status`, starts `tailscale serve` to proxy port 3000 with HTTPS, then prints the URL and QR code. The URL is permanent — it is your machine's Tailscale hostname and does not change between restarts. Any device on your tailnet can open it in Safari and use **Add to Home Screen** to install it as a PWA.

Access is private — only devices logged in to your Tailscale account can reach it. Tailscale must be installed and running on the server machine.

For an automatic secure Cloudflare quick tunnel:

```powershell
winget install --id Cloudflare.cloudflared
```

On macOS, install `cloudflared` with `brew install cloudflared`.

```bash
aterminal server setup --cloudflare
```

From this checkout, you can also run:

```bash
npm run setup:cloudflare
```

This starts `cloudflared tunnel --url http://127.0.0.1:<port>`, waits for the `https://*.trycloudflare.com` URL, then prints that link and a QR code. The quick tunnel URL is temporary and changes when the tunnel restarts.

For a stable custom Cloudflare Tunnel hostname, Tailscale, reverse proxy, or other public HTTPS URL:

```bash
aterminal server setup --public-url https://terminal.example.com
```

`server setup` initializes the server if needed, starts it, prints the web URL, and prints a QR code in the terminal. After signing in, use **Pair Device** in the web UI to scan QRs for opening the UI on a phone and enrolling terminal agents.

## Open The Web UI From A Phone

1. Start the server with a URL the phone can reach, such as `aterminal server setup --lan`.
2. Sign in and click **Pair Device**.
3. Scan the **Send Web UI Link** QR or copy/share that link to the phone.

## Connect An Agent (Another Machine)

An **agent** is ATerminal running on a second machine — the one that will actually host the shell sessions. Your phone's browser connects to the server; the server proxies to whichever agent you pick.

The local machine is auto-enrolled as an agent on first run, so you only need this section when adding a second machine (a remote server, a dev box, a CI runner, etc.).

### Option A — Pairing link (easiest)

1. Start the server with a URL the agent machine can reach (e.g. `--tailscale` or `--public-url`).
2. Sign in → **Pair Device** → **Generate Pairing Link**.
3. Copy the link or QR to the agent machine and open it.
4. It shows two commands — run them:

```bash
npm install -g @aterminal/aterminal
aterminal agent enroll --server https://your-server-url --token <one-time-token>
aterminal agent start
```

### Option B — CLI directly (scripting / automation)

Generate a one-time token in the UI (**Pair Device** → **Generate Pairing Link** → copy the token from the URL), then on the agent machine:

```bash
npm install -g @aterminal/aterminal
aterminal agent enroll --server https://your-server-url --token <token>
aterminal agent start
```

### Option C — Approval flow (no token)

On the agent machine, run without a token and approve the request in the web UI:

```bash
aterminal agent enroll --server https://your-server-url
# → Waiting for admin approval in the ATerminal UI...
# Approve in UI → then:
aterminal agent start
```

Enrollment tokens are one-time use and stored hashed on the server. Remote agents require HTTPS. For local development over plain HTTP, set `ATERMINAL_ALLOW_INSECURE_REMOTE=1` before enrolling.
