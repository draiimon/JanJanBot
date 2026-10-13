const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createGroqClient,
  extractGroqContent,
  getGroqErrorMeta,
} = require('../src/ai/groqClient');

function providerError(status, code, message = 'provider error', headers = {}) {
  const error = new Error(message);
  error.response = {
    status,
    data: { error: { code, message } },
    headers,
  };
  return error;
}

test('sends a bounded provider request and returns successful responses', async () => {
  const calls = [];
  const logs = [];
  const axios = {
    async post(url, payload, options) {
      calls.push({ url, payload, options });
      return { status: 200, data: { choices: [{ message: { content: ' answer ' } }] } };
    },
  };
  const client = createGroqClient({
    axios,
    keys: ['gsk_test_private_key'],
    timeoutMs: 12345,
    logger: (entry) => logs.push(entry),
  });

  const response = await client.request({ model: 'test-model', messages: [] });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, 12345);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer gsk_test_private_key');
  assert.deepEqual(logs.map((entry) => entry.event), [
    'provider_request_started',
    'provider_response_received',
  ]);
  assert.equal(JSON.stringify(logs).includes('gsk_test_private_key'), false);
});

test('rotates away from invalid credentials and remembers the invalid key', async () => {
  const calls = [];
  const state = { currentKeyIndex: 0, invalidIndices: new Set() };
  const client = createGroqClient({
    keys: ['gsk_first', 'gsk_second'],
    state,
    axios: {
      async post(_url, _payload, options) {
        calls.push(options.headers.Authorization);
        if (calls.length === 1) throw providerError(401, 'invalid_api_key', 'gsk_first leaked');
        return { status: 200, data: {} };
      },
    },
  });

  await client.request({ model: 'test-model' });

  assert.deepEqual(calls, ['Bearer gsk_first', 'Bearer gsk_second']);
  assert.deepEqual([...state.invalidIndices], [0]);
  assert.equal(state.currentKeyIndex, 1);
});

test('rotates on 429 and honors Retry-After cooldown before reusing a key', async () => {
  let now = 1_800_000_000_000;
  const calls = [];
  const client = createGroqClient({
    keys: ['gsk_first', 'gsk_second'],
    now: () => now,
    axios: {
      async post(_url, _payload, options) {
        calls.push(options.headers.Authorization);
        if (calls.length === 1) throw providerError(429, 'rate_limit_exceeded', 'limited', { 'retry-after': '30' });
        return { status: 200, data: {} };
      },
    },
  });

  await client.request({ model: 'test-model' });
  assert.equal(client.cooldowns.get(0), now + 30000);

  const callsBeforeCooldownRetry = calls.length;
  await client.request({ model: 'test-model' });
  assert.equal(calls.length, callsBeforeCooldownRetry + 1);
  assert.equal(calls.at(-1), 'Bearer gsk_second');

  now += 30001;
  await client.request({ model: 'test-model' });
  assert.equal(calls.at(-1), 'Bearer gsk_second');
});

test('does not automatically retry network timeouts', async () => {
  let calls = 0;
  const logs = [];
  const client = createGroqClient({
    keys: ['gsk_first', 'gsk_second'],
    logger: (entry) => logs.push(entry),
    axios: {
      async post() {
        calls++;
        const error = new Error('request timed out with gsk_first in a simulated message');
        error.code = 'ETIMEDOUT';
        throw error;
      },
    },
  });

  await assert.rejects(client.request({ model: 'test-model' }), (error) => {
    assert.equal(getGroqErrorMeta(error).category, 'timeout');
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(logs).includes('simulated message'), false);
  assert.equal(JSON.stringify(logs).includes('gsk_first'), false);
});

test('stops after all configured keys are rate limited and applies cooldown', async () => {
  let calls = 0;
  const client = createGroqClient({
    keys: ['gsk_only'],
    axios: {
      async post() {
        calls++;
        throw providerError(429, 'rate_limit_exceeded', 'limited');
      },
    },
  });

  await assert.rejects(client.request({ model: 'test-model' }), (error) => {
    assert.equal(getGroqErrorMeta(error).category, 'rate_limited');
    return true;
  });
  await assert.rejects(client.request({ model: 'test-model' }), (error) => {
    assert.equal(getGroqErrorMeta(error).category, 'rate_limited');
    return true;
  });
  assert.equal(calls, 1);
});

test('classifies common provider and network failures without exposing provider text', () => {
  const cases = [
    [400, 'provider_bad_request'],
    [401, 'invalid_credentials'],
    [403, 'forbidden'],
    [408, 'timeout'],
    [413, 'provider_bad_request'],
    [429, 'rate_limited'],
    [500, 'provider_server_error'],
    [599, 'provider_server_error'],
  ];

  for (const [status, expected] of cases) {
    const meta = getGroqErrorMeta(providerError(status, 'safe_code', 'contains private text'));
    assert.equal(meta.status, status);
    assert.equal(meta.category, expected);
    assert.equal(meta.message, expected);
    assert.equal(meta.message.includes('private text'), false);
  }

  const network = new Error('network message');
  network.code = 'ECONNRESET';
  assert.equal(getGroqErrorMeta(network).category, 'network_error');
});

test('parses optional chat content safely', () => {
  assert.equal(extractGroqContent({ choices: [{ message: { content: ' hi ' } }] }), 'hi');
  assert.equal(extractGroqContent({ choices: [] }), '');
  assert.equal(extractGroqContent({ choices: [{ message: { content: null } }] }), '');
  assert.equal(extractGroqContent('not-json'), '');
});
