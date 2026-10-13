const {
  createHmac,
  randomBytes,
  timingSafeEqual,
} = require('node:crypto');

const COOKIE_NAME = 'listen_session';
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer);
}

function cookieValue(cookieHeader) {
  for (const entry of String(cookieHeader || '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === COOKIE_NAME) {
      return entry.slice(separator + 1).trim();
    }
  }
  return '';
}

function createListenAuth({
  passkey,
  sessionSecret,
  secureCookies = true,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now = Date.now,
}) {
  const configuredPasskey = String(passkey || '');
  const signingSecret = String(sessionSecret || '');
  const enabled = configuredPasskey.length >= 16 && signingSecret.length >= 32;

  function signature(payload) {
    return createHmac('sha256', signingSecret)
      .update(payload)
      .digest('base64url');
  }

  function issueSessionCookie() {
    const expiresAt = now() + ttlSeconds * 1000;
    const payload = `${expiresAt}.${randomBytes(24).toString('base64url')}`;
    const value = `${payload}.${signature(payload)}`;
    const secureAttribute = secureCookies ? '; Secure' : '';
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttlSeconds}${secureAttribute}`;
  }

  function isAuthorized(request) {
    if (!enabled) return false;
    const value = cookieValue(request?.headers?.cookie);
    const parts = value.split('.');
    if (parts.length !== 3 || !/^\d+$/.test(parts[0])) return false;

    const expiresAt = Number(parts[0]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) return false;

    const payload = `${parts[0]}.${parts[1]}`;
    return safeEqual(parts[2], signature(payload));
  }

  return {
    enabled,
    verifyPasskey(candidate) {
      return enabled && safeEqual(configuredPasskey, candidate);
    },
    issueSessionCookie,
    isAuthorized,
    clearSessionCookie() {
      const secureAttribute = secureCookies ? '; Secure' : '';
      return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureAttribute}`;
    },
  };
}

module.exports = { createListenAuth };
