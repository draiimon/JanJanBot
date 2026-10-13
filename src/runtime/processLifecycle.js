function toErrorPayload(source, error) {
  const errorCode = typeof error?.code === 'string' &&
    /^[A-Za-z0-9_-]{1,40}$/.test(error.code)
    ? error.code
    : null;
  return {
    source,
    errorType: typeof error?.name === 'string' &&
      /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)
      ? error.name
      : 'Error',
    errorCode,
    at: new Date().toISOString()
  };
}

function registerProcessLifecycle({ runtimeState, shutdown }) {
  const handleUnhandled = (source) => (error) => {
    const payload = toErrorPayload(source, error);
    runtimeState.process.lastUnhandledError = payload;
    console.error(JSON.stringify({
      timestamp: payload.at,
      severity: 'ERROR',
      event: 'process_error',
      source: payload.source,
      errorType: payload.errorType,
      errorCode: payload.errorCode
    }));
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
      console.error(JSON.stringify({
        timestamp: payload.at,
        severity: 'ERROR',
        event: 'process_shutdown_error',
        source: payload.source,
        errorType: payload.errorType,
        errorCode: payload.errorCode
      }));
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
