const { GoogleGenAI } = require("@google/genai");

const EMBED_MODEL = String(process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001").trim();
const EMBED_DIMENSIONS = Math.max(64, Number(process.env.GEMINI_EMBED_DIMENSIONS || 768));

function buildEmbedPool() {
  const entries = [];
  const keys = [
    ["GOOGLE_API_KEY_10", process.env.GOOGLE_API_KEY_10],
    ["GOOGLE_API_KEY_11", process.env.GOOGLE_API_KEY_11],
    ["GEMINI_API_KEY", process.env.GEMINI_API_KEY],
    ["GOOGLE_API_KEY", process.env.GOOGLE_API_KEY],
  ];
  const seen = new Set();
  for (const [name, raw] of keys) {
    const key = String(raw || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push({ name, key, cooldownUntil: 0, client: null });
  }
  if (entries.length) {
    console.log(`[embed-pool] loaded ${entries.length} embed credential slot(s): ${entries.map((e) => e.name).join(", ")}`);
  } else {
    console.warn("[embed-pool] No Gemini embedding credentials configured in the environment.");
  }
  return entries;
}

const embedPool = buildEmbedPool();

function getEmbedClient(entry) {
  if (!entry.client) entry.client = new GoogleGenAI({ apiKey: entry.key });
  return entry.client;
}

function isRateLimit(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const msg = String(error?.message || "").toLowerCase();
  return status === 429 || /resource_exhausted|rate.?limit|quota|too many requests|usage limit/i.test(msg);
}

function isAuthError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const msg = String(error?.message || "").toLowerCase();
  return (
    status === 401 ||
    status === 403 ||
    /invalid api key|api key not valid|permission.denied|unauthorized|forbidden|leaked/i.test(msg)
  );
}

const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

async function runWithEmbedFallback(fn) {
  if (!embedPool.length) {
    throw new Error(
      "No Gemini embedding credentials configured in the environment.",
    );
  }

  const now = Date.now();
  let lastError = null;

  for (const entry of embedPool) {
    if (entry.cooldownUntil > now) {
      console.warn(`[embed-pool] ${entry.name} is cooling down, skipping.`);
      continue;
    }

    try {
      const client = getEmbedClient(entry);
      const result = await fn(client);
      return result;
    } catch (err) {
      lastError = err;
      if (isRateLimit(err)) {
        entry.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        console.warn(`[embed-pool] ${entry.name} rate-limited, cooling down ${RATE_LIMIT_COOLDOWN_MS / 1000}s. Trying next key.`);
      } else if (isAuthError(err)) {
        entry.cooldownUntil = Date.now() + 6 * 60 * 60 * 1000;
        console.error(`[embed-pool] ${entry.name} rejected by provider, disabling for 6h.`);
      } else {
        throw err;
      }
    }
  }

  throw lastError || new Error("All embed keys are rate-limited or unavailable.");
}

function preprocessText(text) {
  return String(text || "")
    .replace(/[/\\|]+/g, " ")
    .replace(/[–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

async function generateEmbedding(text) {
  const input = preprocessText(text);
  if (!input) return null;

  const result = await runWithEmbedFallback((client) =>
    client.models.embedContent({
      model: EMBED_MODEL,
      contents: input,
      config: { outputDimensionality: EMBED_DIMENSIONS },
    })
  );

  const values =
    (result && result.embeddings && result.embeddings[0] && result.embeddings[0].values) ||
    (result && result.embedding && result.embedding.values) ||
    null;

  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Gemini embedding response had no values.");
  }
  return values;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function embedChunksBatched(chunks, { batchSize = 10, pauseMs = 1000, onProgress } = {}) {
  const out = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const embedded = await Promise.all(
      batch.map(async (chunk) => {
        const vec = await generateEmbedding(chunk.content || "");
        return { ...chunk, embedding: vec };
      })
    );
    out.push(...embedded);
    if (typeof onProgress === "function") {
      onProgress(Math.min(i + batchSize, chunks.length), chunks.length);
    }
    if (i + batchSize < chunks.length) {
      await sleep(pauseMs);
    }
  }
  return out;
}

function vectorToPgLiteral(vec) {
  if (!Array.isArray(vec) || !vec.length) return null;
  return `[${vec.join(",")}]`;
}

module.exports = {
  generateEmbedding,
  embedChunksBatched,
  vectorToPgLiteral,
  EMBED_MODEL,
};
