async function pingUrl(url, runtimeState) {
  runtimeState.keepAlive.lastPingAt = new Date().toISOString();

  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(10000)
  });

  runtimeState.keepAlive.lastPingStatus = response.status;
  runtimeState.keepAlive.lastPingError = null;

  if (!response.ok) {
    throw new Error(`Self-ping returned ${response.status}`);
  }
}

function startSelfPing({ config, runtimeState }) {
  if (!config.selfPingEnabled || !config.publicBaseUrl) {
    return () => {};
  }

  const targetUrl = new URL('/ping', config.publicBaseUrl).toString();
  console.log(`[KEEPALIVE] Self-ping enabled -> ${targetUrl} every ${Math.round(config.selfPingIntervalMs / 60000)} minute(s)`);

  const timer = setInterval(async () => {
    try {
      await pingUrl(targetUrl, runtimeState);
      console.log(`[KEEPALIVE] Ping ok (${runtimeState.keepAlive.lastPingStatus})`);
    } catch (error) {
      runtimeState.keepAlive.lastPingError = error.message;
      console.error('[KEEPALIVE] Ping failed:', error.message);
    }
  }, config.selfPingIntervalMs);

  timer.unref?.();

  return () => clearInterval(timer);
}

module.exports = {
  startSelfPing
};
