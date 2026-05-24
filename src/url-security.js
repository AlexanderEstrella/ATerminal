'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const INSECURE_REMOTE_OVERRIDE = 'ATERMINAL_ALLOW_INSECURE_REMOTE';
function isLocalHostname(hostname) {
    const host = String(hostname || '').toLowerCase();
    return (host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === '127.0.0.1' ||
        host.startsWith('127.') ||
        host === '::1' ||
        host === '[::1]');
}
function assertSecureServerUrl(serverUrl) {
    let parsed;
    try {
        parsed = new URL(serverUrl);
    }
    catch {
        throw new Error('Invalid server URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('Server URL must use http:// or https://');
    }
    if (parsed.protocol === 'https:' || isLocalHostname(parsed.hostname)) {
        return;
    }
    if (process.env[INSECURE_REMOTE_OVERRIDE] === '1') {
        return;
    }
    throw new Error(`Refusing insecure remote server URL. Use HTTPS, localhost, or set ${INSECURE_REMOTE_OVERRIDE}=1 for a private dev tunnel.`);
}
module.exports = { assertSecureServerUrl, isLocalHostname, INSECURE_REMOTE_OVERRIDE };
