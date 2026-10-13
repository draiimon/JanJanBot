const { randomUUID } = require('node:crypto');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

function getGroqErrorMeta(error) {
  const rawStatus = Number(error?.response?.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus
    : null;
  const rawCode = error?.response?.data?.error?.code;
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode)
    ? rawCode
    : null;

  let category = 'provider_error';
  if (status === 401 || code === 'invalid_api_key') category = 'invalid_credentials';
  else if (status === 403) category = 'forbidden';
  else if (status === 429 || code === 'rate_limit_exceeded') category = 'rate_limited';
  else if (status === 408 || status === 504) category = 'timeout';
  else if (status >= 500) category = 'provider_server_error';
  else if (status >= 400) category = 'provider_bad_request';
  else if (
    error?.code === 'ECONNABORTED' ||
    error?.code === 'ETIMEDOUT' ||
    error?.name === 'TimeoutError' ||
    /timeout/i.test(String(error?.message || ''))
  ) category = 'timeout';
  else if (
    ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(error?.code)
  ) category = 'network_error';

  return { status, code, category, message: category };
}

function retryAfterMs(error, now = Date.now()) {
  const headers = error?.response?.headers;
  const raw = headers?.['retry-after'] ?? headers?.get?.('retry-after');
  if (raw !== undefined && raw !== null) {
    const seconds = Number(raw);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(raw) - now;
    if (Number.isFinite(delay) && delay > 0) {
      return Math.min(delay, MAX_RATE_LIMIT_COOLDOWN_MS);
    }
  }
  return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

function extractGroqContent(responseData) {
  const content = responseData?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

function makeProviderError(message, status, code) {
  const error = new Error(message);
  error.response = { status, data: { error: { code } }, headers: {} };
  return error;
}

function createGroqClient({
  axios,
  keys = [],
  state = { currentKeyIndex: 0, invalidIndices: new Set() },
  timeoutMs = DEFAULT_TIMEOUT_MS,
  apiUrl = GROQ_API_URL,
  logger = () => {},
  now = Date.now,
}) {
  if (!axios || typeof axios.post !== 'function') {
    throw new TypeError('An axios-compatible client is required.');
  }

  const usableKeys = [...new Set((keys || []).filter((key) => typeof key === 'string' && key))];
  const invalidIndices = state.invalidIndices instanceof Set ? state.invalidIndices : new Set();
  state.invalidIndices = invalidIndices;
  state.currentKeyIndex = Number.isInteger(state.currentKeyIndex)
    ? state.currentKeyIndex
    : 0;

  const cooldowns = new Map();
  const emit = (severity, event, details) => {
    try {
      logger({
        timestamp: new Date(now()).toISOString(),
        severity,
        event,
        provider: 'groq',
        environment: process.env.NODE_ENV || 'unknown',
        ...details,
      });
    } catch {
      // Logging must not break provider requests.
    }
  };

  async function request(payload, context = {}) {
    const requestId = context.requestId || randomUUID();
    const route = String(context.route || 'discord').slice(0, 80);
    const model = String(payload?.model || 'unknown').slice(0, 80);
    const startedAt = now();
    const requestFields = { requestId, route, method: 'POST', model, timeoutMs };
    emit('INFO', 'provider_request_started', requestFields);

    if (!usableKeys.length) {
      const error = makeProviderError('No Groq API key configured.', 401, 'invalid_api_key');
      emit('ERROR', 'provider_request_failed', {
        ...requestFields,
        durationMs: Math.max(0, now() - startedAt),
        retryCount: 0,
        outcome: 'failure',
        errorCategory: 'missing_credentials',
      });
      throw error;
    }

    let attempts = 0;
    let lastRateLimitError = null;
    let lastAuthError = null;

    while (attempts < usableKeys.length) {
      if (invalidIndices.size >= usableKeys.length) {
        lastAuthError = makeProviderError(
          'All Groq API keys are invalid.',
          401,
          'invalid_api_key',
        );
        break;
      }

      let index = state.currentKeyIndex % usableKeys.length;
      let inspected = 0;
      while (
        inspected < usableKeys.length &&
        (invalidIndices.has(index) || (cooldowns.get(index) || 0) > now())
      ) {
        index = (index + 1) % usableKeys.length;
        inspected++;
      }

      if (inspected === usableKeys.length) break;

      const key = usableKeys[index];
      state.currentKeyIndex = index;
      attempts++;

      try {
        const response = await axios.post(apiUrl, payload, {
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          timeout: timeoutMs,
        });
        state.currentKeyIndex = index;
        emit('INFO', 'provider_response_received', {
          ...requestFields,
          statusCode: response?.status || 200,
          durationMs: Math.max(0, now() - startedAt),
          retryCount: attempts - 1,
          outcome: 'success',
        });
        return response;
      } catch (error) {
        const meta = getGroqErrorMeta(error);
        if (meta.category === 'invalid_credentials') {
          invalidIndices.add(index);
          lastAuthError = error;
          state.currentKeyIndex = (index + 1) % usableKeys.length;
          continue;
        }
        if (meta.category === 'rate_limited') {
          const delay = retryAfterMs(error, now());
          cooldowns.set(index, now() + delay);
          lastRateLimitError = error;
          state.currentKeyIndex = (index + 1) % usableKeys.length;
          continue;
        }

        emit(meta.status >= 500 ? 'ERROR' : 'WARNING', 'provider_request_failed', {
          ...requestFields,
          statusCode: meta.status,
          errorCategory: meta.category,
          durationMs: Math.max(0, now() - startedAt),
          retryCount: attempts - 1,
          outcome: 'failure',
        });
        throw error;
      }
    }

    const error = invalidIndices.size >= usableKeys.length
      ? lastAuthError || makeProviderError('All Groq API keys are invalid.', 401, 'invalid_api_key')
      : lastRateLimitError || makeProviderError(
        'All Groq API keys are unavailable.',
        429,
        'rate_limit_exceeded',
      );
    const meta = getGroqErrorMeta(error);
    emit(meta.status >= 500 ? 'ERROR' : 'WARNING', 'provider_request_failed', {
      ...requestFields,
      statusCode: meta.status,
      errorCategory: meta.category,
      durationMs: Math.max(0, now() - startedAt),
      retryCount: Math.max(0, attempts - 1),
      outcome: 'failure',
    });
    throw error;
  }

  return {
    request,
    invalidIndices,
    cooldowns,
  };
}

module.exports = {
  createGroqClient,
  getGroqErrorMeta,
  extractGroqContent,
  GROQ_API_URL,
  DEFAULT_TIMEOUT_MS,
};
