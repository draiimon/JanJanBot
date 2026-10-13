const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { getGroqErrorMeta } = require('../ai/groqClient');

/**
 * Groq Whisper STT with same key rotation as chat (401/429).
 */
async function transcribeWithGroq(wavFile, groqKeys, { startIndex = 0, invalidIndices = new Set() } = {}) {
  const keys = (groqKeys || []).filter(Boolean);
  if (!keys.length) {
    throw new Error('No Groq API key configured for STT.');
  }

  let idx = startIndex % keys.length;
  let attempts = 0;

  while (attempts < keys.length) {
    if (invalidIndices.size >= keys.length) {
      throw new Error('All Groq API keys invalid for STT (401).');
    }
    if (invalidIndices.has(idx)) {
      idx = (idx + 1) % keys.length;
      attempts += 1;
      continue;
    }

    const key = keys[idx];
    const form = new FormData();
    form.append('file', fs.createReadStream(wavFile), {
      filename: 'audio.wav',
      contentType: 'audio/wav',
    });
    form.append('model', 'whisper-large-v3-turbo');
    form.append('temperature', '0');
    form.append('response_format', 'text');

    try {
      const resp = await axios.post(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        form,
        {
          headers: { Authorization: `Bearer ${key}`, ...form.getHeaders() },
          timeout: 45000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        },
      );
      return {
        text: (resp.data || '').toString().trim(),
        keyIndex: idx,
      };
    } catch (err) {
      const status = err?.response?.status;
      const isRateLimit = status === 429;
      const isInvalidKey = status === 401;
      if ((isRateLimit || isInvalidKey) && keys.length > 1) {
        if (isInvalidKey) invalidIndices.add(idx);
        console.warn(
          `[STT] Groq key ${idx + 1} ${isInvalidKey ? 'invalid' : 'rate limited'}, rotating...`,
        );
        idx = (idx + 1) % keys.length;
        attempts += 1;
        continue;
      }
      const meta = getGroqErrorMeta(err);
      const safeError = new Error(`Groq transcription failed (${meta.category}).`);
      safeError.code = `GROQ_${meta.category.toUpperCase()}`;
      throw safeError;
    }
  }

  throw new Error('All Groq keys exhausted for STT.');
}

module.exports = { transcribeWithGroq };
