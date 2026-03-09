function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig(env = process.env) {
  const publicBaseUrl = env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || env.RENDER_URL || null;
  const groqKeys = [
    env.GROQ_API_KEY1,
    env.GROQ_API_KEY2,
    env.GROQ_API_KEY
  ].filter(Boolean);

  const missing = [];

  if (!env.DISCORD_TOKEN) {
    missing.push('DISCORD_TOKEN');
  }

  if (!env.DATABASE_URL) {
    missing.push('DATABASE_URL');
  }

  if (groqKeys.length === 0) {
    missing.push('GROQ_API_KEY (or GROQ_API_KEY1/GROQ_API_KEY2)');
  }

  return {
    missing,
    discordToken: env.DISCORD_TOKEN || '',
    databaseUrl: env.DATABASE_URL || '',
    groqKeys,
    port: parseInteger(env.PORT, 3000),
    publicBaseUrl,
    selfPingEnabled: parseBoolean(env.SELF_PING_ENABLED, Boolean(publicBaseUrl)),
    selfPingIntervalMs: parseInteger(env.SELF_PING_INTERVAL_MS || env.SELF_PING_INTERVAL, 14 * 60 * 1000),
    nodeEnv: env.NODE_ENV || 'production'
  };
}

module.exports = {
  loadConfig
};
