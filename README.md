# ATerminal

You're at a coffee shop. Your build is running on your home machine. You want to check it from your phone.

ATerminal is a self-hosted terminal server that runs on your machine and exposes a full xterm.js shell to any browser — no cloud, no subscriptions, just your machine behind your own access control. Works over Tailscale (recommended) or your local network. Installs as a PWA on iPhone and Android. Supports multiple named terminal agents across multiple machines.

## Requirements

- [Node.js](https://nodejs.org) 22+
- [Tailscale](https://tailscale.com/download) installed and logged in (recommended for phone access)

## Setup

### Recommended: Tailscale (stable private HTTPS URL)

Tailscale gives you a permanent `https://<your-machine>.ts.net` URL that never changes, is only reachable by devices on your tailnet, and requires no port forwarding or DNS config.

Install Tailscale if you haven't:

```powershell
# Windows
winget install Tailscale.Tailscale
```
```bash
# macOS
brew install tailscale
```

Then install and start ATerminal:

```bash
npm install -g @aterminal/aterminal
aterminal server setup --tailscale
```

Or from a GitHub checkout:

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File setup.ps1
```
```bash
# macOS/Linux
npm install && npm run setup:tailscale
```

This will:
1. Initialize the server on first run (prompts for an admin password)
2. Start the server
3. Start `tailscale serve` to proxy it over HTTPS
4. Auto-enroll your local machine as a terminal agent
5. Print your permanent URL and a QR code

Open the URL, sign in, and scan **Pair Device** → **Send Web UI Link** from your phone to install the PWA.

### Local network only (no Tailscale)

```bash
aterminal server setup --lan
```

Accessible from any device on the same Wi-Fi. No HTTPS — use this for quick local testing, not for leaving up permanently.

### Advanced: custom public URL

If you have your own domain, reverse proxy, or VPN:

```bash
aterminal server setup --public-url https://terminal.yourdomain.com
```

## Open the Web UI From a Phone

1. Start the server with `--tailscale` (or `--lan` for same-network).
2. Sign in and click **Pair Device**.
3. Scan the **Send Web UI Link** QR or copy the link to your phone.
4. On iPhone: tap the share button → **Add to Home Screen** to install as a PWA.

## Push Notifications (ntfy)

Get a phone notification when a terminal session exits. Uses [ntfy](https://ntfy.sh) — free, open source, no account needed for public topics.

Install the ntfy app on your phone, then run:

```bash
aterminal server set-ntfy https://ntfy.sh/your-private-topic
```

Use a hard-to-guess topic name — it's the only secret. For auth-protected topics:

```bash
aterminal server set-ntfy https://ntfy.sh/your-topic --token your-access-token
```

To disable: `aterminal server set-ntfy --disable`

For maximum privacy, run a [self-hosted ntfy server](https://docs.ntfy.sh/install/).

## Connect An Agent (Another Machine)

An **agent** is ATerminal running on a second machine — the one that hosts the shell sessions you see in the UI. Your local machine is auto-enrolled on first run. Only follow this section to add a second machine.

### Option A — Pairing link (easiest)

1. Sign in → **Pair Device** → **Generate Pairing Link**.
2. Send the link to the agent machine and open it.
3. It shows two commands — run them:

```bash
npm install -g @aterminal/aterminal
aterminal agent enroll --server https://your-server-url --token <one-time-token>
aterminal agent start
```

### Option B — CLI directly (scripting / automation)

Copy the token from the pairing link URL, then on the agent machine:

```bash
npm install -g @aterminal/aterminal
aterminal agent enroll --server https://your-server-url --token <token>
aterminal agent start
```

### Option C — Approval flow (no token)

```bash
aterminal agent enroll --server https://your-server-url
# → Waiting for admin approval in the ATerminal UI...
# Approve in the UI, then:
aterminal agent start
```

Enrollment tokens are one-time use and stored hashed on the server. Remote agents require HTTPS.

## Run as a Windows Service (auto-start on boot)

```powershell
# Run as Administrator
powershell -ExecutionPolicy Bypass -File install-service.ps1
```

Requires [NSSM](https://nssm.cc) (installed automatically via winget if not found). Tailscale must be set to start on boot separately (it does by default).
