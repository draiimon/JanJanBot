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

function normalizeSecret(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  let text = String(value).trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim();
  if (!/^-?\d+$/.test(normalized)) {
    return fallback;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function parsePort(value, fallback = 3000) {
  const parsed = parseInteger(value, fallback);
  return parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function parseHostPort(value, fallbackHost = '', fallbackPort = 2333) {
  const text = String(value || '').trim();
  if (!text) {
    return { host: fallbackHost, port: fallbackPort };
  }

  const normalized = text.replace(/^\w+:\/\//, '');
  const [hostPart, portPart] = normalized.split(':');
  return {
    host: hostPart || fallbackHost,
    port: parseInteger(portPart, fallbackPort)
  };
}

function loadConfig(env = process.env) {
  const publicBaseUrl = env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || env.RENDER_URL || null;
  const groqKeys = [
    env.GROQ_API_KEY1,
    env.GROQ_API_KEY2,
    env.GROQ_API_KEY3,
    env.GROQ_API_KEY4,
    env.GROQ_API_KEY5,
    env.GROQ_API_KEY6,
    env.GROQ_API_KEY,
  ]
    .map(normalizeSecret)
    .filter(Boolean)
    .filter((k) => k.startsWith('gsk_'))
    .filter((k, i, arr) => arr.indexOf(k) === i);

  const missing = [];

  if (!env.DISCORD_TOKEN) {
    missing.push('DISCORD_TOKEN');
  }

  if (!env.DATABASE_URL) {
    missing.push('DATABASE_URL');
  }

  if (groqKeys.length === 0) {
    missing.push('GROQ_API_KEY (or GROQ_API_KEY1..GROQ_API_KEY6)');
  }

  const lavalinkHostPort = parseHostPort(env.LAVALINK_HOSTPORT || env.LAVALINK_URL || '', '', 2333);

  return {
    missing,
    discordToken: env.DISCORD_TOKEN || '',
    databaseUrl: env.DATABASE_URL || '',
    tavilyApiKey: env.TAVILY_API_KEY || '',
    groqKeys,
    leonardoApiKey: env.LEONARDO_API_KEY ? String(env.LEONARDO_API_KEY).trim() : '',
    port: parsePort(env.PORT, 3000),
    webEnabled: parseBoolean(env.WEB_ENABLED, Boolean(env.PORT || publicBaseUrl)),
    publicBaseUrl,
    listenPasskey: normalizeSecret(env.LISTEN_PASSKEY),
    sessionSecret: normalizeSecret(env.SESSION_SECRET),
    groqStartupProbeEnabled: parseBoolean(env.GROQ_STARTUP_PROBE_ENABLED, false),
    selfPingEnabled: parseBoolean(env.SELF_PING_ENABLED, false),
    selfPingIntervalMs: parseInteger(env.SELF_PING_INTERVAL_MS || env.SELF_PING_INTERVAL, 14 * 60 * 1000),
    nodeEnv: env.NODE_ENV || 'production',
    musicEnabled: parseBoolean(env.MUSIC_ENABLED, true),
    musicPrefix: env.MUSIC_PREFIX || 'j!',
    musicBackend: String(env.MUSIC_BACKEND || 'direct').trim().toLowerCase(),
    musicPublicLavalinkPool: parseBoolean(env.MUSIC_PUBLIC_LAVALINK_POOL, false),
    lavalinkNodesRaw: env.LAVALINK_NODES_JSON || '',
    lavalink: {
      host: env.LAVALINK_HOST || lavalinkHostPort.host || '',
      port: parseInteger(env.LAVALINK_PORT, lavalinkHostPort.port),
      password: env.LAVALINK_PASSWORD || '',
      secure: parseBoolean(env.LAVALINK_SECURE, false),
      version: String(env.LAVALINK_VERSION || 'v3').trim().toLowerCase(),
      allowInsecureTls: parseBoolean(env.LAVALINK_ALLOW_INSECURE_TLS, false)
    },
    ragEnabled: parseBoolean(env.RAG_ENABLED, true)
  };
}

module.exports = {
  loadConfig
};
