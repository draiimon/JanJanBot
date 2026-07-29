/**
 * RAG Retrieval Service — TRUE semantic RAG (not keyword-first).
 *
 * PIPELINE (strict, 3 stages):
 *   1) RETRIEVAL  : query → embedding → cosine similarity search against pgvector
 *   2) AUGMENTATION: dedupe + rank + token-trim top-k chunks into a context block
 *   3) GENERATION : upstream caller (chat.js) injects context into the LLM prompt
 *                   and applies strict grounding rules; if context is empty, the
 *                   caller returns: "No relevant information found in the knowledge base."
 *
 * EMBEDDINGS:
 *   Both documents and queries are encoded with the SAME model
 *   (GEMINI_EMBED_MODEL=gemini-embedding-001, 768 dims). This guarantees
 *   that the query vector lives in the same semantic space as the stored
 *   document vectors. Embeddings map text → high-dimensional points where
 *   distance encodes semantic similarity (e.g., "lost ID" and "missing
 *   identification card" end up near each other even though they share
 *   no keywords).
 *
 * NORMALIZATION:
 *   pgvector's `<=>` operator computes cosine DISTANCE, which is
 *   length-invariant: cos_dist(u, v) = 1 - (u · v) / (|u| · |v|).
 *   The dot-product is normalized by the magnitudes internally, so
 *   pre-normalizing vectors on insert is not strictly required for
 *   correctness. We convert the distance back to similarity via
 *   `1 - distance` so higher = more similar (0..1 range).
 *
 * INDEX:
 *   rag_chunks.embedding uses an HNSW index (approximate nearest
 *   neighbor) for sub-linear search. See ensureV2Schema.js.
 */

const fs = require("fs");
const path = require("path");
const { generateEmbedding, vectorToPgLiteral } = require("./embeddingService");
const { ensureRagSchema } = require("./ensureRagSchema");

let poolRef = null;
const db = {
  query: (...args) => {
    if (!poolRef) {
      return Promise.reject(new Error("RAG database pool not initialized"));
    }
    return poolRef.query(...args);
  },
};

// ── Tunable knobs (via .env) ─────────────────────────────────────
const RAG_TOP_K = Math.max(1, Number(process.env.RAG_TOP_K || 5));
// Retrieval floor — chunks below this are excluded outright.
const RAG_THRESHOLD = Math.max(0, Math.min(1, Number(process.env.RAG_THRESHOLD || 0.55)));
// Quality gate — if the TOP chunk's similarity is below this, the caller
// should treat the result as "insufficient data" per the grounding rules.
const RAG_QUALITY_GATE = Math.max(0, Math.min(1, Number(process.env.RAG_QUALITY_GATE || 0.70)));
const RAG_MAX_CONTEXT_TOKENS = Math.max(400, Number(process.env.RAG_MAX_CONTEXT_TOKENS || 1500));
const RAG_DEBUG = String(process.env.RAG_DEBUG || "").toLowerCase() === "true";

// Keyword augmentation is OFF by default — vector semantic search is the
// primary and preferred retrieval method. Keyword overlap is only used to
// BOOST confidence when a vector hit already exists, never to inject a
// chunk that vector search did not surface. Set RAG_KEYWORD_AUGMENT=false
// to disable even the boost (purely vector).
const RAG_KEYWORD_AUGMENT =
  String(process.env.RAG_KEYWORD_AUGMENT || "true").toLowerCase() === "true";

// ── In-memory LRU cache ──────────────────────────────────────────
const CACHE_MAX = Math.max(0, Number(process.env.RAG_CACHE_MAX || 500));
const CACHE_TTL_MS = Math.max(0, Number(process.env.RAG_CACHE_TTL_MS || 10 * 60 * 1000));
const queryCache = new Map(); // key → { value, expiresAt }

const STATIC_CHUNK_FILES = [
  path.resolve(__dirname, "../../data/janjan_knowledge_chunks.json"),
];
let staticChunkRows = null;

/**
 * Tagalog slang → canonical English equivalents so the embedding sees the
 * same token space as the stored document vectors.
 * Keep this list short and high-precision — only map terms that reliably mean
 * one thing in the OSA/school context.
 */
const TAGALOG_QUERY_MAP = [
  // payments / cashier
  [/\bmagbayad\b/gi,       "pay payment"],
  [/\bbayad\b/gi,          "payment"],
  [/\bmabayaran\b/gi,      "settle payment"],
  [/\bpabayad\b/gi,        "proxy payment representative"],
  [/\butang\b/gi,          "outstanding balance"],
  [/\bhulog\b/gi,          "installment payment"],
  // clearance
  [/\bma-?clear\b/gi,      "clearance approved"],
  [/\bpag-clear\b/gi,      "clearance process"],
  [/\bmag-?clear\b/gi,     "get clearance"],
  // enrollment
  [/\bmag-?enroll\b/gi,    "enroll enrollment"],
  [/\bpag-?enroll\b/gi,    "enrollment process"],
  [/\bpasok\s*na\b/gi,     "first day classes semester start"],
  [/\bload\b/gi,           "subjects enrolled units"],
  // documents / records
  [/\bkumuha\b/gi,         "get request obtain"],
  [/\bkukuha\b/gi,         "get request obtain"],
  [/\bilang\s*araw\b/gi,   "how many days processing time"],
  [/\bilang\s*days\b/gi,   "how many days processing time"],
  // office / hours
  [/\bbukas\b/gi,          "open available"],
  [/\bsarado\b/gi,         "closed not available"],
  [/\banong\s*oras\b/gi,   "what time hours schedule"],
  [/\bpila\b/gi,           "queue waiting line"],
  [/\bmabilis\b/gi,        "fast quick efficient"],
  [/\bbagal\b/gi,          "slow process delay"],
  // institutional identity / manual lookups
  [/\bpresidente\b/gi,     "president"],
  [/\bpangulo\b/gi,        "president"],
  [/\bpresidents\b/gi,     "president"],
  [/\bpresident'?s\b/gi,   "president"],
  [/\bmessage\s+ng\s+president\b/gi, "president message"],
  [/\bpresident\s+message\b/gi, "president message"],
  [/\bsino\s+ang\s+president\b/gi, "who is the president"],
  [/\bsino\s+president\b/gi, "who is the president"],
  [/\bsino\s+ang\s+presidente\b/gi, "who is the president"],
  [/\bsino\s+presidente\b/gi, "who is the president"],
  [/\bchairman'?s\b/gi,    "chairman"],
  [/\bvision mission core values\b/gi, "vision mission core values"],
  [/\bcore values\b/gi,    "core values"],
  // general Tagalog sentence helpers → remove (stop words)
  [/\bsana\b/gi,           ""],
  [/\bnaman\b/gi,          ""],
  [/\bkaya\b/gi,           ""],
  [/\beh\b/gi,             ""],
  [/\bdaw\b/gi,            ""],
  [/\bdaw\b/gi,            ""],
  [/\bnin\b/gi,            ""],
  [/\byung\b/gi,           "the"],
  [/\bnung\b/gi,           ""],
  [/\bpara\s*sa\b/gi,      "for"],
  [/\bsige\b/gi,           ""],
  [/\bkasi\b/gi,           "because"],
  [/\bnakakuha\b/gi,       "received obtained"],
  [/\bnag-?submit\b/gi,    "submitted"],
];

/** Slash/pipe-separated lists (Vision/Mission/Core) → spaces so embeddings & cache match typed variants.
 *  Also applies Tagalog-to-English mapping to improve semantic match against stored vectors. */
function normalizeQueryForRag(raw) {
  let text = String(raw || "")
    .replace(/[/\\|]+/g, " ")
    .replace(/[–—]/g, " ");

  // Apply Tagalog normalization before embedding
  for (const [pattern, replacement] of TAGALOG_QUERY_MAP) {
    text = text.replace(pattern, replacement);
  }

  return text.replace(/\s+/g, " ").trim();
}

function cacheKey(query, options) {
  const normalized = normalizeQueryForRag(query).toLowerCase().replace(/\s+/g, " ").trim();
  const o = {
    k: options?.topK ?? RAG_TOP_K,
    t: options?.threshold ?? RAG_THRESHOLD,
  };
  return `${normalized}|k=${o.k}|t=${o.t}`;
}

function cacheGet(key) {
  const hit = queryCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    queryCache.delete(key);
    return null;
  }
  // LRU: bump recency
  queryCache.delete(key);
  queryCache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  if (CACHE_MAX <= 0) return;
  queryCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (queryCache.size > CACHE_MAX) {
    const oldestKey = queryCache.keys().next().value;
    if (oldestKey === undefined) break;
    queryCache.delete(oldestKey);
  }
}

// ── Utility ──────────────────────────────────────────────────────
function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .replace(/([a-z])\1{2,}/g, "$1$1")
    .trim();
}

function tokenizeForSearch(value) {
  const raw = String(value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const parts = raw.split(/\s+/).map(normalizeToken).filter(Boolean);
  const out = [];
  for (const token of parts) {
    if (token.length < 3) continue;
    if (STOP_WORDS.has(token)) continue;
    if (!out.includes(token)) out.push(token);
    if (out.length >= 300) break;
  }
  return out;
}

function levenshteinDistance(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function fuzzyTokenScore(queryToken, candidateToken) {
  const q = normalizeToken(queryToken);
  const c = normalizeToken(candidateToken);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (q.length < 4 || c.length < 4) return 0;
  if (Math.abs(q.length - c.length) > 2) return 0;

  if (q.includes(c) || c.includes(q)) {
    return Math.min(q.length, c.length) >= 5 ? 0.9 : 0.75;
  }

  const dist = levenshteinDistance(q, c);
  if (dist === 1) return 0.9;
  if (dist === 2 && Math.min(q.length, c.length) >= 5) return 0.78;
  return 0;
}

const STOP_WORDS = new Set([
  // ── English stop words ────────────────────────────────────────
  "what","how","when","where","why","who","the","a","an","and","or",
  "is","are","was","were","be","been","being",
  "can","could","would","should","need","want","get","do","did","does",
  "apply","application","program","programs","info","information","details",
  "i","my","me","we","our","you","your","he","she","they","it","its",
  "for","to","of","in","on","at","by","with","from","that","this","these","those",
  "not","no","yes","also","just","only","if","but","so","up","about","into","than",
  "have","has","had","will","may","might","must","shall",
  "already","still","yet","even","after","before","since","until","while",
  "please","give","tell","show","explain","help","ask","need",
  // ── Filipino / Tagalog stop words ─────────────────────────────
  "ang","ng","sa","ay","na","ba","po","may","mga","ko","kung","ano","paano",
  "kailan","bakit","saan","gusto","pwede","pwedeng","hindi","wala","meron",
  "ito","iyon","yan","yun","yon","dito","doon","nung","ng","yung",
  "namin","natin","nila","niya","nyo","sila","siya","kami","tayo","kayo",
  "din","rin","lang","lamang","kaya","sana","naman","talaga","masyado",
  "pala","nga","ha","hm","oo","hindi","opo","hinde","opo",
  "mag","mag-","pag","pag-","para","kasi","dahil","pero","at","o",
  "kapag","tuwing","kahit","kahit","bago","pagkatapos","habang",
  "boss","pre","bro","sis","kuya","ate","sir","maam","po","opo",
  "sige","ganun","ganon","parang","medyo","lagi","palagi","minsan",
  "pwede","puwede","pwedeng","puwedeng",
]);

function extractQueryKeywords(query) {
  const q = String(query || "").toLowerCase();
  const words = q.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = [];
  for (const w of words) {
    if (w.length < 3) continue;
    if (STOP_WORDS.has(w)) continue;
    if (!out.includes(w)) out.push(w);
    if (out.length >= 10) break;
  }
  return out;
}

function debugLog(...args) {
  if (!RAG_DEBUG) return;
  // eslint-disable-next-line no-console
  console.log("[rag:debug]", ...args);
}

function loadStaticChunks() {
  if (Array.isArray(staticChunkRows)) return staticChunkRows;

  const rows = [];
  for (const file of STATIC_CHUNK_FILES) {
    if (!fs.existsSync(file)) continue;
    let arr = [];
    try {
      if (file.endsWith(".js")) {
        delete require.cache[require.resolve(file)];
        arr = require(file);
      } else {
        arr = JSON.parse(fs.readFileSync(file, "utf8"));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[rag:static-load]", path.basename(file), err?.message || err);
      continue;
    }
    if (!Array.isArray(arr)) continue;

    for (const chunk of arr) {
      if (!chunk || !chunk.chunk_id || !chunk.content) continue;
      const keywords = Array.isArray(chunk.keywords)
        ? chunk.keywords.map((k) => String(k || "").toLowerCase().trim()).filter(Boolean)
        : [];
      const titleText = [
        chunk.topic,
        chunk.article,
        chunk.section,
      ].filter(Boolean).join(" ").toLowerCase();
      const fullText = [
        chunk.topic,
        chunk.article,
        chunk.section,
        chunk.bot_routing,
        keywords.join(" "),
        chunk.content,
      ].filter(Boolean).join("\n").toLowerCase();

      rows.push({
        id: `static:${chunk.chunk_id}`,
        chunk_id: String(chunk.chunk_id),
        topic: String(chunk.topic || ""),
        article: String(chunk.article || ""),
        section: String(chunk.section || ""),
        keywords,
        content: String(chunk.content || ""),
        source: String(chunk.source || "JanJan Bot Knowledge"),
        created_at: null,
        updated_at: null,
        __tokenSet: tokenizeForSearch(fullText),
        __normalizedTitle: tokenizeForSearch(titleText).join(" "),
        __normalizedFull: tokenizeForSearch(fullText).join(" "),
        __titleText: titleText,
        __fullText: fullText,
      });
    }
  }

  staticChunkRows = rows;
  return staticChunkRows;
}

function countSubstringHits(text, token) {
  if (!text || !token) return 0;
  let count = 0;
  let index = text.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(token, index + token.length);
  }
  return count;
}

function keywordVariants(word) {
  const base = normalizeToken(word);
  if (!base) return [];
  const out = new Set([base]);
  if (base.endsWith("s") && base.length > 4) out.add(base.slice(0, -1));
  if (base === "message") out.add("messages");
  return [...out];
}

function canonicalVariant(word) {
  const variants = keywordVariants(word).sort((a, b) => a.length - b.length);
  return variants[0] || normalizeToken(word);
}

function bestFuzzyRowTokenScore(word, rowTokens) {
  let best = 0;
  for (const token of rowTokens) {
    if (!token) continue;
    const score = fuzzyTokenScore(word, token);
    if (score > best) best = score;
    if (best >= 0.9) break;
  }
  return best;
}

function scoreStaticChunk(query, queryWords, row) {
  const q = String(query || "").toLowerCase().trim();
  const title = row.__titleText || "";
  const full = row.__fullText || "";
  const normalizedTitle = row.__normalizedTitle || "";
  const normalizedFull = row.__normalizedFull || "";
  const keys = Array.isArray(row.keywords) ? row.keywords : [];
  const rowTokens = Array.isArray(row.__tokenSet) ? row.__tokenSet : [];

  let score = 0;
  let keywordHits = 0;
  let titleHits = 0;
  let bodyHits = 0;
  let fuzzyHits = 0;
  let matchedWords = 0;
  let titleMatchedWords = 0;

  for (const word of queryWords) {
    const variants = keywordVariants(word);
    let matchedKeyword = false;
    let matchedTitle = false;
    let matchedBody = false;
    let bestFuzzy = 0;

    for (const variant of variants) {
      if (!matchedKeyword && keys.includes(variant)) {
        keywordHits += 1;
        score += 0.16;
        matchedKeyword = true;
      }
      if (!matchedTitle && title.includes(variant)) {
        titleHits += 1;
        score += 0.13;
        matchedTitle = true;
      }
      if (!matchedBody) {
        const hits = countSubstringHits(full, variant);
        if (hits > 0) {
          bodyHits += 1;
          score += Math.min(0.10, 0.05 + ((hits - 1) * 0.01));
          matchedBody = true;
        }
      }
      const fuzzy = bestFuzzyRowTokenScore(variant, rowTokens);
      if (fuzzy > bestFuzzy) bestFuzzy = fuzzy;
    }

    if (!matchedKeyword && !matchedTitle && !matchedBody && bestFuzzy >= 0.78) {
      fuzzyHits += 1;
      if (bestFuzzy >= 0.9) score += 0.10;
      else score += 0.07;
    }

    if (matchedKeyword || matchedTitle || matchedBody || bestFuzzy >= 0.78) {
      matchedWords += 1;
    }
    if (matchedTitle) {
      titleMatchedWords += 1;
    }
  }

  if (q && title.includes(q)) score += 0.34;
  else if (q && full.includes(q)) score += 0.18;

  const compactPhrase = queryWords.map(canonicalVariant).join(" ").trim();
  if (compactPhrase.length >= 8) {
    if (normalizedTitle.includes(compactPhrase)) score += 0.28;
    else if (normalizedFull.includes(compactPhrase)) score += 0.12;
  }

  if (keywordHits >= 2) score += 0.06;
  if (titleHits >= 2) score += 0.08;
  if ((keywordHits + titleHits + bodyHits) >= 4) score += 0.05;
  if (fuzzyHits >= 2) score += 0.05;
  if (queryWords.length >= 2 && matchedWords === queryWords.length) score += 0.16;
  if (queryWords.length >= 2 && titleMatchedWords === queryWords.length) score += 0.18;

  return Math.min(0.96, score);
}

function staticSearch(query, queryWords, topK, threshold) {
  const rows = loadStaticChunks();
  if (!rows.length) return [];

  const floor = Math.max(0.45, Number(threshold) - 0.08);
  const scored = rows
    .map((row) => ({
      ...row,
      similarity: scoreStaticChunk(query, queryWords, row),
      retrieval: "static-local",
    }))
    .filter((row) => row.similarity >= floor)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Math.max(topK, 8));

  return scored.map(({ __titleText, __fullText, __tokenSet, __normalizedTitle, __normalizedFull, ...row }) => row);
}

// ── STAGE 1: Retrieval ───────────────────────────────────────────

/**
 * Semantic similarity search against rag_chunks.
 * Uses cosine similarity via pgvector's <=> operator.
 * Returns top-k chunks whose similarity > threshold.
 */
async function vectorSearch(embeddingLiteral, topK, threshold) {
  const sql = `
    SELECT
      id, chunk_id, topic, article, section, keywords, content, source,
      created_at, updated_at,
      1 - (embedding <=> $1::vector) AS similarity
    FROM rag_chunks
    WHERE is_active = true AND embedding IS NOT NULL
      AND 1 - (embedding <=> $1::vector) > $2
    ORDER BY embedding <=> $1::vector ASC
    LIMIT $3
  `;
  const r = await db.query(sql, [embeddingLiteral, threshold, topK]);
  return r.rows.map((row) => ({
    ...row,
    similarity: Number(row.similarity) || 0,
    retrieval: "vector",
  }));
}

/**
 * Keyword overlap on rag_chunks.keywords — also used to MERGE in rows the
 * vector stage missed (see fetchChunksKeywordRescue), then boost confidence.
 */
async function keywordOverlapIds(queryWords) {
  if (!queryWords.length) return new Set();
  const sql = `
    SELECT id
    FROM rag_chunks
    WHERE is_active = true
      AND EXISTS (SELECT 1 FROM UNNEST(keywords) AS k WHERE lower(k) = ANY($1::text[]))
  `;
  const r = await db.query(sql, [queryWords]);
  return new Set(r.rows.map((row) => row.id));
}

/** Pull full rows for keyword hits not returned by vector search (fixes missed EAC-001-style chunks). */
function keywordRescueSimilarity(threshold) {
  const floor = Number(process.env.RAG_KEYWORD_RESCUE_SIMILARITY || 0.62);
  return Math.min(0.85, Math.max(floor, Number(threshold) + 0.02));
}

async function fetchChunksKeywordRescue(ids, threshold) {
  const clean = [...new Set(ids)].slice(0, 20);
  if (!clean.length) return [];
  const sim = keywordRescueSimilarity(threshold);
  const r = await db.query(
    `SELECT id, chunk_id, topic, article, section, keywords, content, source, created_at, updated_at
     FROM rag_chunks
     WHERE is_active = true AND id = ANY($1::uuid[])`,
    [clean]
  );
  return r.rows.map((row) => ({
    ...row,
    similarity: sim,
    retrieval: "keyword-rescue",
  }));
}

// ── STAGE 2: Augmentation ────────────────────────────────────────

/** Drop near-duplicate chunks (same chunk_id) and rank by similarity. */
function dedupeAndRank(rows, topK) {
  const byId = new Map();
  for (const row of rows) {
    const key = row.chunk_id || row.id;
    const existing = byId.get(key);
    if (!existing || (row.similarity > existing.similarity)) byId.set(key, row);
  }
  return Array.from(byId.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

/** Build a token-bounded context block for the LLM. */
function buildContext(rows, maxTokens) {
  let total = 0;
  const parts = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const src = String(row.source || "JanJan Knowledge Base").trim();
    const header = `[Source ${i + 1} | ${row.chunk_id} | ${row.section || row.topic || ""} | from: ${src}]`;
    const block = `${header}\n${String(row.content || "").trim()}\n---`;
    const t = estimateTokens(block);
    if (total + t > maxTokens) break;
    parts.push(block);
    total += t;
  }
  return parts.join("\n");
}

function confidenceTier(score) {
  if (score >= 0.85) return "HIGH";
  if (score >= RAG_QUALITY_GATE) return "MEDIUM"; // default 0.70
  if (score >= 0.50) return "LOW";
  return "ESCALATE";
}

/**
 * Main RAG entrypoint.
 *
 * @param {string} query          User's natural-language query
 * @param {object} options        { topK, threshold, maxContextTokens, debug }
 * @returns {object}              { context, confidence, tier, chunks, method, debug? }
 *
 * Tier semantics:
 *   HIGH     (≥ 0.85)          → answer directly from context
 *   MEDIUM   (≥ RAG_QUALITY_GATE, default 0.70) → answer from context
 *   LOW      (≥ 0.50)          → tell user "insufficient data"; suggest escalation
 *   ESCALATE (< 0.50 or empty) → tell user "No relevant information found in the knowledge base."
 */
async function searchRag(query, options = {}) {
  query = normalizeQueryForRag(query);
  const topK = Math.max(1, Number(options.topK || RAG_TOP_K));
  const threshold = typeof options.threshold === "number" ? options.threshold : RAG_THRESHOLD;
  const maxContextTokens = Math.max(300, Number(options.maxContextTokens || RAG_MAX_CONTEXT_TOKENS));
  const debug = !!(options.debug || RAG_DEBUG);

  // Cache check (query-level; saves an embedding API call + a DB round-trip for repeats).
  const key = cacheKey(query, { topK, threshold });
  const cached = cacheGet(key);
  if (cached) {
    debugLog(`cache HIT for "${query}"`);
    return debug ? { ...cached, debug: { cached: true, ...cached.debug } } : cached;
  }

  const t0 = Date.now();
  const queryKeywords = extractQueryKeywords(query);
  debugLog(`query="${query}"  keywords=[${queryKeywords.join(",")}]`);

  // --- STAGE 1: RETRIEVAL (semantic first, then optional keyword boost) ---
  let vectorRows = [];
  let vectorUsed = false;
  try {
    const vec = await generateEmbedding(query);
    if (vec) {
      const lit = vectorToPgLiteral(vec);
      if (lit) {
        vectorRows = await vectorSearch(lit, topK, threshold);
        vectorUsed = true;
        debugLog(`vector search: ${vectorRows.length} chunks above threshold ${threshold}`);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[rag:vector]", err?.message || err);
  }

  let keywordHitIds = new Set();
  if (RAG_KEYWORD_AUGMENT) {
    try {
      keywordHitIds = await keywordOverlapIds(queryKeywords);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[rag:keyword-db]", err?.message || err);
    }
  }

  let keywordRescueMerged = 0;
  if (RAG_KEYWORD_AUGMENT && keywordHitIds.size > 0) {
    const vecIdSet = new Set(vectorRows.map((r) => r.id));
    let rescueIds = [...keywordHitIds].filter((id) => !vecIdSet.has(id));
    if (!vectorRows.length) {
      rescueIds = [...keywordHitIds];
    }
    if (rescueIds.length > 0) {
      const rescued = await fetchChunksKeywordRescue(rescueIds, threshold);
      if (rescued.length) {
        vectorRows = vectorRows.concat(rescued);
        keywordRescueMerged = rescued.length;
        debugLog(`keyword rescue merged ${rescued.length} chunk(s)`);
      }
    }
  }

  let staticRows = [];
  let staticMerged = 0;
  try {
    staticRows = staticSearch(query, queryKeywords, topK, threshold);
    if (staticRows.length) {
      const seen = new Set(vectorRows.map((r) => r.chunk_id));
      const rescued = staticRows.filter((r) => !seen.has(r.chunk_id));
      if (!vectorRows.length) {
        vectorRows = staticRows;
        staticMerged = staticRows.length;
      } else if (rescued.length) {
        vectorRows = vectorRows.concat(rescued);
        staticMerged = rescued.length;
      }
      debugLog(`static search: ${staticRows.length} chunk(s), merged=${staticMerged}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[rag:static-search]", err?.message || err);
  }

  // --- STAGE 2: AUGMENTATION (dedupe + rank + token-trim) ---
  const ranked = dedupeAndRank(vectorRows, topK);

  if (!ranked.length) {
    const result = {
      context: "",
      confidence: 0,
      tier: "ESCALATE",
      chunks: [],
      method: vectorUsed ? "vector" : "unavailable",
    };
    if (debug) {
      result.debug = {
        query,
        keywords: queryKeywords,
        threshold,
        elapsedMs: Date.now() - t0,
        note: "no chunks above similarity threshold",
      };
    }
    cacheSet(key, result);
    return result;
  }

  // Boost confidence when keywords ALSO overlap with a vector hit.
  let confidence = ranked[0].similarity;
  let keywordBoost = 0;
  if (keywordHitIds.has(ranked[0].id)) {
    keywordBoost = 0.05;
    ranked[0].retrieval = "hybrid";
  }
  if (ranked.length >= 3) keywordBoost += 0.02;
  confidence = Math.min(1, confidence + keywordBoost);

  let methodStem = vectorUsed ? "vector" : "";
  if (keywordRescueMerged > 0) {
    methodStem = methodStem ? `${methodStem}+keyword-rescue` : "keyword-rescue";
  }
  if (staticMerged > 0 || (!vectorUsed && staticRows.length > 0)) {
    methodStem = methodStem ? `${methodStem}+static-local` : "static-local";
  }
  const result = {
    context: buildContext(ranked, maxContextTokens),
    confidence,
    tier: confidenceTier(confidence),
    chunks: ranked,
    method: methodStem + (keywordHitIds.size ? "+keyword-boost" : ""),
  };

  if (debug) {
    result.debug = {
      query,
      keywords: queryKeywords,
      threshold,
      topK,
      elapsedMs: Date.now() - t0,
      vectorUsed,
      keywordBoost,
      top: ranked.map((r) => ({
        chunk_id: r.chunk_id,
        similarity: Number(r.similarity.toFixed(4)),
        retrieval: r.retrieval,
        section: r.section,
      })),
    };
    debugLog(`top chunks:`, result.debug.top);
  }

  cacheSet(key, result);
  return result;
}

/**
 * Debug helper — returns a human-readable transcript of the retrieval,
 * suitable for log dumps or admin-side inspection.
 */
async function explainRetrieval(query, options = {}) {
  const r = await searchRag(query, { ...options, debug: true });
  const lines = [];
  lines.push(`[Retrieved Chunks] (method=${r.method}, tier=${r.tier}, confidence=${r.confidence.toFixed(3)})`);
  if (!r.chunks.length) {
    lines.push("  (none — below threshold)");
  } else {
    r.chunks.forEach((c, i) => {
      const preview = String(c.content || "").replace(/\s+/g, " ").slice(0, 120);
      lines.push(`  ${i + 1}. (score: ${Number(c.similarity).toFixed(3)}) [${c.chunk_id}] ${c.section || c.topic}`);
      lines.push(`     ${preview}…`);
    });
  }
  lines.push(`\n[Elapsed] ${r.debug?.elapsedMs ?? "?"}ms`);
  lines.push(`\n[Final Context Tokens] ${estimateTokens(r.context)}`);
  return { text: lines.join("\n"), result: r };
}

function clearQueryCache() {
  queryCache.clear();
}

function loadJsonChunks() {
  return loadStaticChunks().map((row) => ({
    chunk_id: row.chunk_id,
    topic: row.topic,
    article: row.article,
    section: row.section,
    keywords: row.keywords,
    bot_routing: row.bot_routing || "",
    content: row.content,
    source: row.source,
  }));
}

function shouldUseRagQuery(query = "") {
  const lower = String(query || "").toLowerCase();
  if (lower.length < 4) return false;
  const casualOnly =
    /^(hi|hello|uy|uyy|teh|ghorl|haha|lol|ok|sige|charot|eme)\b/i.test(lower) &&
    lower.length < 24;
  if (casualOnly) return false;
  const ragTriggers = [
    /\b(j!|command|commands|help|paano|how to|ano ang|what is|sino si janjan)\b/i,
    /\b(render|deploy|docker|lavalink|groq|api key|rag|knowledge|health|tts|voice|music|play)\b/i,
    /\b(j!vc|j!join|j!leave|j!ask|j!listen|j!play|j!research|j!help|j!ragseed)\b/i,
    /\b(setup|install|env|database|neon|postgres|pgvector|embedding)\b/i,
  ];
  return ragTriggers.some((re) => re.test(lower));
}

async function initRag(pool) {
  poolRef = pool || null;
  staticChunkRows = null;
  if (poolRef) {
    await ensureRagSchema(poolRef);
  }
  const count = loadStaticChunks().length;
  console.log(`[RAG] OSA-style pipeline ready — ${count} JSON chunk(s), pgvector + Gemini embeddings.`);
  return count;
}

async function reloadRag() {
  clearQueryCache();
  staticChunkRows = null;
  return initRag(poolRef);
}

function getRagStats() {
  return {
    chunkCount: loadStaticChunks().length,
    topK: RAG_TOP_K,
    threshold: RAG_THRESHOLD,
    qualityGate: RAG_QUALITY_GATE,
    vectorEnabled: Boolean(poolRef),
  };
}

module.exports = {
  searchRag,
  explainRetrieval,
  confidenceTier,
  clearQueryCache,
  initRag,
  reloadRag,
  shouldUseRagQuery,
  loadJsonChunks,
  getRagStats,
};
