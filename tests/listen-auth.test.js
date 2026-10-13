const test = require('node:test');
const assert = require('node:assert/strict');
const { createListenAuth } = require('../src/server/listenAuth');

function cookieRequest(cookie) {
  return { headers: { cookie } };
}

test('requires a high-entropy access key and session-signing secret', () => {
  assert.equal(createListenAuth({ passkey: 'short', sessionSecret: 'x'.repeat(40) }).enabled, false);
  assert.equal(createListenAuth({ passkey: 'p'.repeat(16), sessionSecret: 'short' }).enabled, false);
  assert.equal(createListenAuth({ passkey: 'p'.repeat(16), sessionSecret: 's'.repeat(32) }).enabled, true);
});

test('issues HttpOnly, SameSite, Secure cookies and verifies the signed session', () => {
  const auth = createListenAuth({
    passkey: 'p'.repeat(16),
    sessionSecret: 's'.repeat(32),
    secureCookies: true,
  });

  assert.equal(auth.verifyPasskey('p'.repeat(16)), true);
  assert.equal(auth.verifyPasskey('wrong'), false);

  const cookie = auth.issueSessionCookie();
  assert.match(cookie, /^listen_session=[A-Za-z0-9._-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  const pair = cookie.split(';')[0];
  assert.equal(auth.isAuthorized(cookieRequest(pair)), true);
  assert.equal(auth.isAuthorized(cookieRequest(`${pair}tampered`)), false);
});

test('rejects expired sessions', () => {
  let now = 1_800_000_000_000;
  const auth = createListenAuth({
    passkey: 'p'.repeat(16),
    sessionSecret: 's'.repeat(32),
    secureCookies: false,
    ttlSeconds: 1,
    now: () => now,
  });
  const cookie = auth.issueSessionCookie().split(';')[0];
  assert.equal(auth.isAuthorized(cookieRequest(cookie)), true);
  now += 1001;
  assert.equal(auth.isAuthorized(cookieRequest(cookie)), false);
});

test('does not authorize forged, missing, or malformed cookies', () => {
  const auth = createListenAuth({
    passkey: 'p'.repeat(16),
    sessionSecret: 's'.repeat(32),
  });

  assert.equal(auth.isAuthorized(cookieRequest('')), false);
  assert.equal(auth.isAuthorized(cookieRequest('listen_session=1.nonce.bad')), false);
  assert.equal(auth.isAuthorized(cookieRequest('other_cookie=anything')), false);
});
