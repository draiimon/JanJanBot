function toErrorPayload(source, error) {
  if (error instanceof Error) {
    return {
      source,
      message: error.message,
      stack: error.stack || null,
      at: new Date().toISOString()
    };
  }

  return {
    source,
    message: typeof error === 'string' ? error : JSON.stringify(error),
    stack: null,
    at: new Date().toISOString()
  };
}

function registerProcessLifecycle({ runtimeState, shutdown }) {
  const handleUnhandled = (source) => (error) => {
    const payload = toErrorPayload(source, error);
    runtimeState.process.lastUnhandledError = payload;
    console.error(`[PROCESS] ${source}:`, payload.message);
    if (payload.stack) {
      console.error(payload.stack);
    }
  };

  const onUnhandledRejection = handleUnhandled('unhandledRejection');
  const onUncaughtException = handleUnhandled('uncaughtException');

  let shuttingDown = false;

  const handleSignal = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    runtimeState.process.shuttingDown = true;
    runtimeState.process.shutdownSignal = signal;

    console.log(`[PROCESS] Received ${signal}. Shutting down gracefully...`);

    try {
      await shutdown(signal);
    } catch (error) {
      const payload = toErrorPayload(`shutdown:${signal}`, error);
      runtimeState.process.lastUnhandledError = payload;
      console.error(`[PROCESS] Shutdown error: ${payload.message}`);
      if (payload.stack) {
        console.error(payload.stack);
      }
    } finally {
      process.exit(0);
    }
  };

  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  return () => {
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('uncaughtException', onUncaughtException);
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  };
}

module.exports = {
  registerProcessLifecycle
};
