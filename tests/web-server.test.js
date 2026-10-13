const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createWebServer } = require('../src/server/createWebServer');

const ACCESS_KEY = 'test-listen-access-key';
const SESSION_SECRET = 'test-session-signing-secret-123456';

function createFixture({ authEnabled = true, discordReady = true, databaseConnected = true } = {}) {
  let joinCount = 0;
  let upgradeCount = 0;
  const channel = {
    id: '123456789012345678',
    name: 'voice',
    type: 2,
    guild: {
      id: '234567890123456789',
      name: 'test-guild',
      voiceAdapterCreator: {},
    },
  };
  const server = createWebServer({
    config: {
      port: 0,
      nodeEnv: 'test',
      listenPasskey: authEnabled ? ACCESS_KEY : '',
      sessionSecret: authEnabled ? SESSION_SECRET : '',
    },
    runtimeState: {
      service: { name: 'test-service', bootedAt: new Date().toISOString() },
      discord: { lastLoginError: null },
      database: { configured: true, connected: databaseConnected, lastError: 'private-db-error' },
      voice: { savedState: { channelId: 'private-channel-id' } },
      keepAlive: {},
      process: {},
    },
    client: {
      isReady: () => discordReady,
      ws: { ping: 10 },
      guilds: { cache: { size: 1 } },
      users: { cache: { size: 2 } },
      channels: { cache: { get: (id) => (id === channel.id ? channel : undefined) } },
    },
    getDiagnostics: () => ({ marker: 'private-diagnostic' }),
    liveVoiceStream: {
      getStatus: () => ({ active: true, guildName: 'test-guild' }),
      handleUpgrade: () => { upgradeCount++; },
    },
    onJoinChannel: async () => { joinCount++; },
  });

  return {
    server,
    get joinCount() { return joinCount; },
    get upgradeCount() { return upgradeCount; },
  };
}

async function startFixture(fixture) {
  const server = await fixture.server.start();
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => fixture.server.close(),
  };
}

test('public health is a minimal liveness check; detailed readiness and diagnostics are protected', async () => {
  const fixture = createFixture({ discordReady: false, databaseConnected: false });
  const running = await startFixture(fixture);
  try {
    const healthResponse = await fetch(`${running.baseUrl}/health`);
    const health = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(health.status, 'ok');
    assert.equal(JSON.stringify(health).includes('private-db-error'), false);
    assert.equal(JSON.stringify(health).includes('private-channel-id'), false);

    const readyResponse = await fetch(`${running.baseUrl}/ready`);
    const ready = await readyResponse.json();
    assert.equal(readyResponse.status, 503);
    assert.deepEqual(ready.checks, { discord: false, database: false, shuttingDown: false });

    const diagnosticsResponse = await fetch(`${running.baseUrl}/diagnostics`);
    assert.equal(diagnosticsResponse.status, 401);
  } finally {
    await running.close();
  }
});

test('server-side authentication protects diagnostics, stream status, and channel control', async () => {
  const fixture = createFixture();
  const running = await startFixture(fixture);
  try {
    const listenPage = await fetch(`${running.baseUrl}/listen`);
    const html = await listenPage.text();
    assert.equal(listenPage.status, 200);
    assert.equal(html.includes('12345'), false);
    assert.equal(html.includes("fetch('/listen/auth'"), true);

    assert.equal((await fetch(`${running.baseUrl}/diagnostics`)).status, 401);
    assert.equal((await fetch(`${running.baseUrl}/voice-status`)).status, 401);
    assert.equal((await fetch(`${running.baseUrl}/join-channel`)).status, 401);
    assert.equal(fixture.joinCount, 0);

    const badLogin = await fetch(`${running.baseUrl}/listen/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey: 'incorrect' }),
    });
    assert.equal(badLogin.status, 401);
    assert.deepEqual(await badLogin.json(), { error: 'Authentication failed.' });

    const login = await fetch(`${running.baseUrl}/listen/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey: ACCESS_KEY }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.doesNotMatch(setCookie, /test-listen-access-key/);
    const cookie = setCookie.split(';')[0];

    const diagnosticsResponse = await fetch(`${running.baseUrl}/diagnostics`, {
      headers: { Cookie: cookie },
    });
    assert.equal(diagnosticsResponse.status, 200);
    assert.equal((await diagnosticsResponse.json()).diagnostics.marker, 'private-diagnostic');

    const statusResponse = await fetch(`${running.baseUrl}/voice-status`, {
      headers: { Cookie: cookie },
    });
    assert.equal(statusResponse.status, 200);

    const legacyGet = await fetch(`${running.baseUrl}/join-channel?channelId=123456789012345678`, {
      headers: { Cookie: cookie },
    });
    assert.equal(legacyGet.status, 405);
    assert.equal(fixture.joinCount, 0);

    const joinResponse = await fetch(`${running.baseUrl}/join-channel`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: '123456789012345678' }),
    });
    assert.equal(joinResponse.status, 200);
    assert.equal(fixture.joinCount, 1);
  } finally {
    await running.close();
  }
});

test('listener stays disabled unless both access secrets meet minimum lengths', async () => {
  const fixture = createFixture({ authEnabled: false });
  const running = await startFixture(fixture);
  try {
    const pageResponse = await fetch(`${running.baseUrl}/listen`);
    assert.equal(pageResponse.status, 503);

    const authResponse = await fetch(`${running.baseUrl}/listen/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey: ACCESS_KEY }),
    });
    assert.equal(authResponse.status, 503);
    assert.equal((await fetch(`${running.baseUrl}/diagnostics`)).status, 503);
  } finally {
    await running.close();
  }
});

test('bounds login request bodies and rejects malformed JSON', async () => {
  const fixture = createFixture();
  const running = await startFixture(fixture);
  try {
    const malformed = await fetch(`${running.baseUrl}/listen/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(malformed.status, 400);

    const oversized = await fetch(`${running.baseUrl}/listen/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey: 'x'.repeat(5000) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await running.close();
  }
});

test('rejects unauthenticated WebSocket upgrades', async () => {
  const fixture = createFixture();
  const running = await startFixture(fixture);
  const port = Number(new URL(running.baseUrl).port);
  try {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('WebSocket upgrade test timed out.'));
      }, 2000);
      socket.on('connect', () => {
        socket.write(
          'GET /voice-stream HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        );
      });
      socket.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    assert.equal(fixture.upgradeCount, 0);
  } finally {
    await running.close();
  }
});
