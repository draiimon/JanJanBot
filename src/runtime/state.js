function createRuntimeState(config) {
  return {
    service: {
      name: 'janjan-discord-ai-bot',
      bootedAt: new Date().toISOString(),
      node: process.version,
      pid: process.pid,
      environment: config.nodeEnv
    },
    discord: {
      ready: false,
      readyAt: null,
      lastLoginError: null
    },
    database: {
      configured: Boolean(config.databaseUrl),
      connected: false,
      connectedAt: null,
      lastError: null
    },
    voice: {
      savedState: null,
      connectionStatus: 'idle',
      reconnectAttempts: 0,
      lastReadyAt: null,
      lastRejoinReason: null,
      lastRejoinAttemptAt: null,
      nextRejoinAt: null
    },
    keepAlive: {
      enabled: config.selfPingEnabled,
      target: config.publicBaseUrl,
      lastPingAt: null,
      lastPingStatus: null,
      lastPingError: null
    },
    process: {
      shuttingDown: false,
      shutdownSignal: null,
      lastUnhandledError: null
    }
  };
}

module.exports = {
  createRuntimeState
};
