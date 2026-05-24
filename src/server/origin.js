'use strict';

function normalizeOrigin(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function configuredOrigins(config) {
  const origins = [];

  if (config.publicUrl) {
    const publicOrigin = normalizeOrigin(config.publicUrl);
    if (publicOrigin) origins.push(publicOrigin);
  }

  if (Array.isArray(config.allowedOrigins)) {
    for (const origin of config.allowedOrigins) {
      const normalized = normalizeOrigin(origin);
      if (normalized) origins.push(normalized);
    }
  }

  return origins;
}

function requestHost(req) {
  const forwardedHost = req.headers['x-forwarded-host'];
  if (typeof forwardedHost === 'string' && forwardedHost.trim()) {
    return forwardedHost.split(',')[0].trim();
  }
  return req.headers.host;
}

function isAllowedRequestOrigin(req, config) {
  const origin = normalizeOrigin(req.headers.origin);
  if (!origin) return true;

  const host = requestHost(req);
  if (host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host === host) return true;
    } catch {
      return false;
    }
  }

  return configuredOrigins(config).includes(origin);
}

module.exports = { isAllowedRequestOrigin };
