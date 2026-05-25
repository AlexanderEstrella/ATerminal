'use strict';

const https = require('https');
const http = require('http');

// Fire-and-forget POST to an ntfy topic.
// Reads NTFY_URL and NTFY_TOKEN from env at call time, unless overridden by ntfyConfig.
// Does nothing if NTFY_URL is not set.
function notifySessionExit(
  sessionName: string,
  exitCode: number,
  ntfyConfig?: { url?: string; token?: string },
  meta?: { hostname?: string; durationMs?: number; lastLine?: string },
): void {
  const success = exitCode === 0;
  const parts: string[] = [];
  if (meta?.hostname) parts.push(`[${meta.hostname}]`);
  parts.push(`"${sessionName}"`);
  parts.push(success ? 'finished' : 'failed');
  if (meta?.durationMs !== undefined) parts.push(`in ${formatDuration(meta.durationMs)}`);
  parts.push(`(exit ${exitCode})`);
  let body = parts.join(' ');
  if (meta?.lastLine) body += `\n${meta.lastLine}`;
  notifySessionEvent({
    body,
    priority: success ? 'default' : 'high',
    tags: success ? 'white_check_mark' : 'warning',
  }, ntfyConfig);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function notifySessionStopped(sessionName: string, reason: string, ntfyConfig?: { url?: string; token?: string }): void {
  notifySessionEvent({
    body: `Session "${sessionName}" ${reason}`,
    priority: 'high',
    tags: 'warning',
  }, ntfyConfig);
}

function notifySessionEvent(event: { body: string; priority: string; tags: string }, ntfyConfig?: { url?: string; token?: string }): void {
  const url = ntfyConfig?.url || process.env.NTFY_URL;
  if (!url) return;

  const headers: Record<string, string> = {
    'Title': 'ATerminal',
    'Priority': event.priority,
    'Tags': event.tags,
    'Content-Type': 'text/plain',
    'Content-Length': String(Buffer.byteLength(event.body, 'utf8')),
  };

  const token = ntfyConfig?.token || process.env.NTFY_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;

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
    req.on('error', () => {});
    req.end(event.body, 'utf8');
  } catch (_) {
    // invalid URL or network error — never crash the server
  }
}

module.exports = { notifySessionExit, notifySessionStopped };
