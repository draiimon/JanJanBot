const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

const baseEnv = {
  DISCORD_TOKEN: 'discord-test-token',
  DATABASE_URL: 'postgres://example.invalid/test',
  GROQ_API_KEY1: 'gsk_test_key_one',
};

test('loads required settings and stable defaults without probing providers', () => {
  const config = loadConfig({ ...baseEnv });

  assert.deepEqual(config.missing, []);
  assert.equal(config.port, 3000);
  assert.equal(config.webEnabled, false);
  assert.equal(config.groqStartupProbeEnabled, false);
  assert.equal(config.nodeEnv, 'production');
});

test('normalizes and deduplicates Groq key slots, ignoring invalid formats', () => {
  const config = loadConfig({
    ...baseEnv,
    GROQ_API_KEY1: ' "gsk_same_key" ',
    GROQ_API_KEY2: 'gsk_same_key',
    GROQ_API_KEY3: 'not-a-groq-key',
    GROQ_API_KEY: 'gsk_other_key',
  });

  assert.deepEqual(config.groqKeys, ['gsk_same_key', 'gsk_other_key']);
});

test('reports missing required bot configuration without revealing values', () => {
  const config = loadConfig({});

  assert.deepEqual(config.missing, [
    'DISCORD_TOKEN',
    'DATABASE_URL',
    'GROQ_API_KEY (or GROQ_API_KEY1..GROQ_API_KEY6)',
  ]);
  assert.equal(JSON.stringify(config.missing).includes('secret'), false);
});

test('uses strict port parsing and supported boolean forms', () => {
  const invalidPort = loadConfig({ ...baseEnv, PORT: '5000junk', WEB_ENABLED: 'off' });
  const outOfRangePort = loadConfig({ ...baseEnv, PORT: '70000' });
  const invalidBoolean = loadConfig({ ...baseEnv, WEB_ENABLED: 'maybe' });
  const valid = loadConfig({
    ...baseEnv,
    PORT: '5000',
    WEB_ENABLED: 'yes',
    SELF_PING_ENABLED: 'off',
    GROQ_STARTUP_PROBE_ENABLED: 'true',
  });

  assert.equal(invalidPort.port, 3000);
  assert.equal(invalidPort.webEnabled, false);
  assert.equal(invalidBoolean.webEnabled, false);
  assert.equal(outOfRangePort.port, 3000);
  assert.equal(valid.port, 5000);
  assert.equal(valid.webEnabled, true);
  assert.equal(valid.selfPingEnabled, false);
  assert.equal(valid.groqStartupProbeEnabled, true);
});
