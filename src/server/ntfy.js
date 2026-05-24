'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const https = require('https');
const http = require('http');
// Fire-and-forget POST to an ntfy topic.
// Reads NTFY_URL and NTFY_TOKEN from env at call time, unless overridden by ntfyConfig.
// Does nothing if NTFY_URL is not set.
function notifySessionExit(sessionName, exitCode, ntfyConfig) {
    const url = ntfyConfig?.url || process.env.NTFY_URL;
    if (!url)
        return;
    const success = exitCode === 0;
    const body = `Session "${sessionName}" finished (exit ${exitCode})`;
    const headers = {
        'Title': 'ATerminal',
        'Priority': success ? 'default' : 'high',
        'Tags': success ? 'white_check_mark' : 'warning',
        'Content-Type': 'text/plain',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    };
    const token = ntfyConfig?.token || process.env.NTFY_TOKEN;
    if (token)
        headers['Authorization'] = `Bearer ${token}`;
    try {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname,
            method: 'POST',
            headers,
        });
        req.on('error', () => { });
        req.end(body, 'utf8');
    }
    catch (_) {
        // invalid URL or network error — never crash the server
    }
}
module.exports = { notifySessionExit };
