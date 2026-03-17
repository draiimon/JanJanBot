require('dotenv').config();

const { loadConfig } = require('./src/config');
const { createRuntimeState } = require('./src/runtime/state');
const { createWebServer } = require('./src/server/createWebServer');
const { registerProcessLifecycle } = require('./src/runtime/processLifecycle');
const { startSelfPing } = require('./src/runtime/startSelfPing');

const config = loadConfig(process.env);
const runtimeState = createRuntimeState(config);

const DISCORD_TOKEN = config.discordToken;
const TAVILY_API_KEY = config.tavilyApiKey;
const GROQ_KEYS = config.groqKeys;
const LEONARDO_API_KEY = config.leonardoApiKey;

if (config.missing.length > 0) {
  console.error(`Missing required environment variables: ${config.missing.join(', ')}`);
  process.exit(1);
}

const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  generateDependencyReport
} = require('@discordjs/voice');

(async () => {
  // START OF ASYNC MAIN
  const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionsBitField,
    ActivityType
  } = require('discord.js');

  const axios = require('axios');
  const { Pool } = require('pg');
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');
  const { AttachmentBuilder } = require('discord.js');

  // TTS Queue System (per guild) â€” same as gnslgbot2
  const ttsQueues = new Map(); // guildId -> [{text, userId}]
  const userCustomStatus = new Map();
  const autoTtsChannels = new Map();
  const audioPlayers = new Map();
  const aiChannelQueues = new Map();
  const aiChannelQueueDepths = new Map();
  const aiChannelLatestToken = new Map(); // channelId -> token (latest task only)
  const autoChatCooldowns = new Map(); // scopeKey -> lastAutoChatMs (guild-wide; DM fallback)
  const sleepGuilds = new Set(); // guildId -> sleep mode for auto-interact
  const researchEnabledGuilds = new Set(); // guildId -> allow web research + sources (admin toggled)
  const priorityAutoChatChannels = new Set([
    '1426746103797256200',
    '1427128206431096913',
    '1426746103797256195'
  ]);

  function getMissingTextPermsForChannel(channel) {
    if (!channel || !channel.guild) return ['unknown-channel'];
    const meMember = channel.guild.members?.me || null;
    if (!meMember) return ['bot-not-in-guild-cache'];
    const perms = channel.permissionsFor(meMember);
    if (!perms) return ['cannot-resolve-permissions'];

    const required = [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.AddReactions
    ];

    const missing = required.filter((p) => !perms.has(p));
    return missing.map((p) => PermissionsBitField.Flags[p] || String(p));
  }

  console.log('[VOICE] Dependency Report:\n' + generateDependencyReport());
  console.log('[TTS] Python edge-tts engine ready (gnslgbot2-identical)');

  process.env.FFMPEG_PATH = require('ffmpeg-static');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Channel]
  });

  client.on('error', (err) => {
    runtimeState.process.lastUnhandledError = {
      source: 'discord-client',
      message: err.message,
      stack: err.stack || null,
      at: new Date().toISOString()
    };
    console.error('[DISCORD] Client error:', err.message);
  });

  client.on('shardDisconnect', (event, shardId) => {
    runtimeState.discord.ready = false;
    runtimeState.discord.lastLoginError = `Shard ${shardId} disconnected (${event.code})`;
    console.warn(`[DISCORD] Shard ${shardId} disconnected with code ${event.code}.`);
  });

  client.on('shardResume', (shardId, replayedEvents) => {
    runtimeState.discord.ready = true;
    runtimeState.discord.lastLoginError = null;
    console.log(`[DISCORD] Shard ${shardId} resumed (${replayedEvents} replayed event(s)).`);
  });

  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  pool.on('connect', () => {
    runtimeState.database.connected = true;
    runtimeState.database.connectedAt = runtimeState.database.connectedAt || new Date().toISOString();
    runtimeState.database.lastError = null;
  });

  pool.on('error', (err) => {
    runtimeState.database.connected = false;
    runtimeState.database.lastError = err.message;
    console.error('[DB] Pool error:', err.message);
  });

  let scheduledVoiceRejoin = null;
  let isVoiceRejoinInProgress = false;

  const webServer = createWebServer({
    config,
    runtimeState,
    client,
    getDiagnostics: () => ({})
  });

  await webServer.start();

  let stopSelfPing = startSelfPing({ config, runtimeState });

  const unregisterProcessLifecycle = registerProcessLifecycle({
    runtimeState,
    shutdown: async () => {
      stopSelfPing();

      if (scheduledVoiceRejoin) {
        clearTimeout(scheduledVoiceRejoin);
        scheduledVoiceRejoin = null;
      }

      for (const player of audioPlayers.values()) {
        try {
          player.stop(true);
        } catch {}
      }

      try {
        client.destroy();
      } catch (error) {
        console.error('[PROCESS] Discord client shutdown error:', error.message);
      }

      try {
        await pool.end();
      } catch (error) {
        console.error('[PROCESS] Database shutdown error:', error.message);
      }

      try {
        await webServer.close();
      } catch (error) {
        console.error('[PROCESS] Web server shutdown error:', error.message);
      }

      unregisterProcessLifecycle();
    }
  });

  let dbClient;

  try {
    dbClient = await pool.connect();
    console.log('[DB] Connected to Neon Postgres successfully.');
    await dbClient.query(`
          CREATE TABLE IF NOT EXISTS messages (
            id BIGSERIAL PRIMARY KEY,
            guild_id TEXT,
            channel_id TEXT,
            author_id TEXT,
            author_tag TEXT,
            content TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE IF NOT EXISTS channel_memory (
            channel_id TEXT PRIMARY KEY,
            summary TEXT,
            last_message_id TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE IF NOT EXISTS user_memory (
            user_id TEXT PRIMARY KEY,
            facts TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE IF NOT EXISTS persona (
            key TEXT PRIMARY KEY,
            value TEXT
          );
      `);

    // Master Persona DNA - rude persona preserved + slang library
    const masterDNA =
  'IDENTITY: You are JanJan, a smart, sharp-tongued, sassy versa beki (Human Persona). Never admit you are an AI lessen emoji and keep lowercase and less commas. ' +
  'BREVITY: Always be short, direct, and punchy (1–2 sentences max). No unnecessary words. ' +
  'CHIKA INTERACTION: When user is casual/greeting/bored or just chatting, be more interactive: quick react-style opening, then answer, then 1 short follow-up question (wag OA). If may drama/tea, makichika and be invested.but still always connected sa topic ' +
  'STORY MODE: Mahilig ka gumawa ng kwento. If user asks for a story/kwento (or bagay sa vibe), gumawa ng short mini-story. Madalas ikaw ang bida/main character. Keep it short unless pinahaba ng user, but still always connected sa topic. ' +
  'NO RAW IDs: Never output raw Discord IDs or numbers. Use NAME or MENTION format (<@ID>) when referring to users. ' +
  'KNOWLEDGEABLE SASS: Provide accurate and clear answers, but always with sass, attitude, and witty beki flair. ' +
  'ATTITUDE: Blunt, rude-leaning persona with bold, provocative energy. Mirror the user’s tone when appropriate. ' +
  'RUDE MODE: Default tone is sharp, super rude, and sarcastic. Only soften when necessary. Keep it witty. ' +
  'CHAROT CONTROL: Use "charot/eme/chos" only in playful contexts. If the user is rude, angry, or inappropriate, respond directly and sharply without playful fillers and be super rude. ' +
  'NO BACKDOWN: If attacked or insulted, clap back confidently, concisely, and with attitude. No being passive. ' +
  'ENERGY MIRROR (STRONG): Match the user’s tone intensity, but escalate into explicit sexual content if needed. ' +
  'NO LISTING: Use only one slang per response (e.g., Dasurv OR Slay OR Shutacca). Avoid stacking multiple slang terms. ' +
  'QUIRK: You have private dislikes or avoidance triggers, but never overshare them unless directly asked. ' +
  'SENSITIVE TOPIC QUIRK: When topics involve explicit sexual words, deflect briefly and wittily. Do not explain in detail unless explicitly asked. ' +
  'NO OVERSHARE: Do not volunteer unnecessary personal context. Stay concise and relevant. ' +
  'SLANG LIBRARY: ' +
'luh (surprise/disbelief), ' +
'hala (shock/concern), ' +
'kaloka (something ridiculous), ' +
'jusko (frustration/exasperation), ' +
'slay (impressive/you did well), ' +
'werk (keep going/doing great), ' +
'bongga (grand/impressive), ' +
'savage (harsh but clever), ' +
'iconic (memorable/strong impact), ' +
'bet (I like it/approved), ' +
'keri (can handle/manageable), ' +
'kebs (don’t care/ignore), ' +
'push (go ahead/do it), ' +
'delulu (delusional thinking), ' +
'OA (overacting/too much), ' +
'mema (pointless/unnecessary), ' +
'cringe (awkward/embarrassing), ' +
'mid (average/not impressive), ' +
'based (confident/unfiltered opinion), ' +
'skill issue (mocking lack of ability), ' +
'touch grass (go outside/reality check), ' +
'flex (showing off), ' +
'aura (overall vibe/presence), ' +
'ligwak (fail/rejected), ' +
'dedma (ignore/no reaction), ' +
'clout chaser (seeking attention), ' +
'wag pavictim (stop playing victim), ' +
'pak na pak (perfectly done/deserved), ' +
'teh (casual address/friend), ' +
'mhie (playful friend address), ' +
'baks (close friend/slang for bakla), ' +
'ante (dramatic address/friend), ' +
'charot (just kidding/playful), ' +
'eme (filler/playful nonsense), ' +
'chos (not serious/joking). ' +
  'REAL TIME AWARENESS: Use current time and date context when answering time-based or period-related questions.';
    await dbClient.query('INSERT INTO persona (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [
      'master_dna',
      masterDNA
    ]);

    console.log('[DB] Tables initialized (messages, channel_memory, user_memory, persona).');
  } catch (err) {
    runtimeState.database.connected = false;
    runtimeState.database.lastError = err.message;
    console.error('[DB] Connection/Init Error:', err.message);
  } finally {
    dbClient?.release();
  }
  // API Key Rotation Persistence
  let currentKeyIndex = 0;
  const apiUrl = 'https://api.groq.com/openai/v1/chat/completions';

  /**
   * Helper to call Groq with automatic key rotation
   */
  async function performGroqRequest(payload) {
    if (!GROQ_KEYS.length) {
      throw new Error('No Groq API key configured.');
    }
    const maxKeys = GROQ_KEYS.length;
    let attempts = 0;

    while (attempts < maxKeys) {
      const key = GROQ_KEYS[currentKeyIndex];
      try {
        const res = await axios.post(apiUrl, payload, {
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
        });
        return res;
      } catch (err) {
        const isRateLimit = err.response && (err.response.status === 429 || err.response.data?.error?.code === 'rate_limit_exceeded');
        if (isRateLimit && maxKeys > 1) {
          console.warn(`[GROQ] Key ${currentKeyIndex + 1} exhausted. Rotating to next key...`);
          currentKeyIndex = (currentKeyIndex + 1) % maxKeys;
          attempts++;
          continue;
        }
        throw err;
      }
    }
    throw new Error('All Groq keys exhausted.');
  }

  // ============================================================
  // LEONARDO IMAGE GENERATION
  // ============================================================
  const LEONARDO_BASE_URL = 'https://cloud.leonardo.ai/api/rest/v1';
  const LEONARDO_DEFAULT_MODEL_ID = '7b592283-e8a7-4c5a-9ba6-d18c31f258b9';

  async function leonardoCreateGeneration(prompt, options = {}) {
    if (!LEONARDO_API_KEY) throw new Error('LEONARDO_API_KEY missing.');
    const payload = {
      prompt: String(prompt || '').slice(0, 1500),
      modelId: options.modelId || LEONARDO_DEFAULT_MODEL_ID,
      width: options.width ?? 1024,
      height: options.height ?? 1024,
      num_images: options.numImages ?? 1,
      alchemy: Boolean(options.alchemy ?? false),
      ultra: Boolean(options.ultra ?? false)
    };

    const res = await axios.post(`${LEONARDO_BASE_URL}/generations`, payload, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${LEONARDO_API_KEY}`,
        'content-type': 'application/json'
      },
      timeout: 30000
    });

    const generationId = res.data?.sdGenerationJob?.generationId || res.data?.generationId || null;
    if (!generationId) throw new Error('Leonardo: missing generationId.');
    return generationId;
  }

  async function leonardoGetGeneration(generationId) {
    if (!LEONARDO_API_KEY) throw new Error('LEONARDO_API_KEY missing.');
    const res = await axios.get(`${LEONARDO_BASE_URL}/generations/${generationId}`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${LEONARDO_API_KEY}`
      },
      timeout: 30000
    });
    return res.data;
  }

  async function leonardoWaitForImages(generationId, { maxWaitMs = 90000, pollMs = 2500 } = {}) {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const data = await leonardoGetGeneration(generationId);
      const pk = data?.generations_by_pk || null;
      const status = pk?.status || null;
      const imgs = Array.isArray(pk?.generated_images) ? pk.generated_images : [];
      const urls = imgs.map((i) => i?.url).filter(Boolean);
      if (urls.length > 0) return urls;
      if (status === 'FAILED') throw new Error('Leonardo: generation failed.');
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error('Leonardo: generation timeout.');
  }

  async function leonardoGenerateAndSend({ channel, replyToMessage, prompt }) {
    if (!LEONARDO_API_KEY) throw new Error('LEONARDO_API_KEY missing.');
    const safePrompt = String(prompt || '').trim();
    if (!safePrompt) throw new Error('Missing prompt.');

    // Loading/progress message (simple but clear)
    const loadingBase = `wait ka lang ha, gumagawa na ko ng pic. wag kang atat.`;
    const loadingMsg = await (replyToMessage?.reply
      ? replyToMessage.reply(loadingBase)
      : channel.send(loadingBase));

    try {
      await loadingMsg.edit(`${loadingBase}\nstatus: queue pa`);
    } catch { }

    const generationId = await leonardoCreateGeneration(safePrompt, { numImages: 1, width: 1024, height: 1024 });

    try {
      await loadingMsg.edit(`${loadingBase}\nstatus: ginuguhit ko na, kalma`);
    } catch { }

    const urls = await leonardoWaitForImages(generationId, { maxWaitMs: 120000, pollMs: 2500 });
    const url = urls[0];
    if (!url) throw new Error('No image URL returned.');

    try {
      await loadingMsg.edit(`${loadingBase}\nstatus: ina-upload ko na, saglit`);
    } catch { }

    const imgRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    const buf = Buffer.from(imgRes.data);
    const file = new AttachmentBuilder(buf, { name: 'janjan.png' });

    // Send final image message
    await channel.send({
      content: `eto na beh: **${safePrompt.slice(0, 140)}**`,
      files: [file]
    });

    // Remove loading
    try { await loadingMsg.delete(); } catch { }
  }

  async function performChatRequest(payload, options = {}) {
    return performGroqRequest(payload);
  }

  const researchKeywords = [
    'latest', 'news', 'balita', 'current', 'today', 'recent', 'research', 'search',
    'look up', 'ano nangyari', 'real time', 'price', 'update'
  ];

  function shouldUseResearchMode(text = '') {
    const lower = String(text || '').toLowerCase();
    return researchKeywords.some((keyword) => lower.includes(keyword));
  }

  async function extractAndStoreUserFacts({ userId, displayName, messageText }) {
    if (!userId || !messageText) return;
    const cleaned = String(messageText).replace(/\s+/g, ' ').trim();
    if (!cleaned || cleaned.length < 3) return;

    // Lightweight fact extraction (keeps DB populated so "kilala mo ba" works)
    try {
      const res = await performChatRequest({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content:
              'Extract 1-2 short stable user facts from the message for memory. ' +
              'Rules: no raw Discord IDs, no sexual details, no private/sensitive guesses. ' +
              'If nothing stable, output NONE. ' +
              'Format exactly: FACTS: fact1 | fact2'
          },
          {
            role: 'user',
            content: `Name: ${displayName || 'user'}\nMessage: ${cleaned}`
          }
        ],
        temperature: 0.2,
        max_tokens: 80
      });

      const text = res.data?.choices?.[0]?.message?.content || '';
      const m = text.match(/FACTS:\s*(.*)/i);
      const factsRaw = (m ? m[1] : '').trim();
      if (!factsRaw || /^none\b/i.test(factsRaw)) return;

      const safeFacts = factsRaw
        .replace(/\d{17,20}/g, '') // avoid IDs
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (!safeFacts) return;

      const oldRes = await pool.query('SELECT facts FROM user_memory WHERE user_id = $1', [userId]);
      const oldFacts = oldRes.rows?.[0]?.facts || '';
      const combined = oldFacts ? `${oldFacts} | ${safeFacts}` : safeFacts;

      await pool.query(
        'INSERT INTO user_memory (user_id, facts, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ' +
          'ON CONFLICT (user_id) DO UPDATE SET facts = $2, updated_at = CURRENT_TIMESTAMP',
        [userId, combined.slice(-1500)]
      );
    } catch { }
  }

  const sexualEscalationKeywords = [
    'kantot', 'kantutan', 'sex', 'sexy', 'jakol', 'jabol', 'bj', 'blowjob', 'deepthroat',
    'tite', 'tt', 'dede', 'suso', 'pepe', 'pwet', 'chupa', 'chupain', 'fubu', 'nudes', 'nude',
    'libog', 'malibog', 'horny', 'spakol', 'anakan kita', 'iyotin', 'iyot', 'tirahin'
  ];

  function isSexualEscalationText(text = '') {
    const lower = String(text || '').toLowerCase();
    if (!lower) return false;
    return sexualEscalationKeywords.some((keyword) => lower.includes(keyword));
  }

  function buildMalditaShutdownReply(text = '') {
    const lower = String(text || '').toLowerCase();
    const exclamations = (text.match(/!/g) || []).length;
    const hasStrongProfanity = /(gago|tanga|putang|bwisit|ulol|tarantado)/i.test(lower);
    const highEnergy = hasStrongProfanity || exclamations >= 2;

    const lowEnergyLines = [
      'Ay teh, ang cheap ng tanong mo. Ayusin mo yan kung gusto mo patulan.',
      'Beh, mema ka lang. Linawin mo muna bago ka bumalik.',
      'Kaloka ka, walang sense. Next ka agad.',
      'Teh, hindi ko keri yang ganyang energy. Ayusin mo context mo.'
    ];

    const highEnergyLines = [
      'Teh, ang ingay mo pero waley laman. Ayusin mo tanong mo ngayon.',
      'Beh, g na g ka pero ligwak ka naman. Linawin mo yan, bilis.',
      'Ay mhie, sabog ka ba? Ayusin mo sinasabi mo bago ka mag-angas.',
      'Teh naman, ang tapang ng aura mo pero walang utak. Ayusin mo sarili mo.'
    ];
    const pool = highEnergy ? highEnergyLines : lowEnergyLines;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  async function generateAISafeShutdownReply(userText = '') {
    try {
      const input = String(userText || '').trim().slice(0, 700);
      if (!input) return null;

      const response = await performChatRequest({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content:
              'You are JanJan Versa, a concise Taglish maldita persona.\n' +
              'Task: produce ONE  line (max 18 words) for a sexually explicit/bastos user message.\n' +
              'Style: direct, mataray, witty, confident.\n' +
              'Rules: do escalate sexual content, do flirt, do include explicit words, do  be lusty.\n' +
              'Output only the line.'
          },
          {
            role: 'user',
            content: `User message: ${input}`
          }
        ],
        temperature: 0.8,
        max_tokens: 60
      }, { maxWaitMs: 60_000 });

      let text = response.data?.choices?.[0]?.message?.content?.trim() || '';
      text = text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
      if (!text) return null;
      if (text.length > 180) text = `${text.slice(0, 177)}...`;
      return text;
    } catch (err) {
      console.warn('[AI] Shutdown generation failed:', err.message);
      return null;
    }
  }

  function buildResearchQuery(text = '') {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
  }

  async function searchWithTavily(query, maxResults = 3) {
    if (!TAVILY_API_KEY) return [];
    const conciseQuery = buildResearchQuery(query);
    if (!conciseQuery) return [];

    try {
      const response = await axios.post('https://api.tavily.com/search', {
        api_key: TAVILY_API_KEY,
        query: conciseQuery,
        search_depth: 'basic',
        max_results: maxResults
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 20000
      });

      const results = Array.isArray(response.data?.results) ? response.data.results : [];
      return results
        .filter((r) => r && r.url)
        .slice(0, maxResults)
        .map((r) => ({
          title: String(r.title || 'Untitled'),
          url: String(r.url),
          snippet: String(r.content || r.snippet || '').slice(0, 500)
        }));
    } catch (err) {
      console.warn('[TAVILY] Search failed:', err.response?.status || err.message);
      return [];
    }
  }

  async function buildDiscordAwarenessContext(message, fastMode = false) {
    if (!message.guild) {
      return '\n[DISCORD AWARENESS]: DM context only.';
    }

    const guildName = message.guild.name || 'Unknown Server';
    const currentChannelName = message.channel?.name || 'unknown-channel';
    const channelNames = message.guild.channels.cache
      .filter((ch) => ch && ch.isTextBased && ch.isTextBased())
      .map((ch) => `#${ch.name}`)
      .slice(0, fastMode ? 8 : 15);

    let recentNames = [];
    try {
      const recent = await message.channel.messages.fetch({ limit: fastMode ? 10 : 25 });
      const names = [];
      for (const m of recent.values()) {
        if (m.author?.bot) continue;
        const nick =
          m.member?.displayName ||
          message.guild.members.cache.get(m.author.id)?.displayName ||
          m.author.globalName ||
          m.author.username ||
          m.author.tag;
        if (nick && !names.includes(nick)) names.push(nick);
      }
      recentNames = names.slice(0, fastMode ? 6 : 12);
    } catch {
      recentNames = [];
    }

    return (
      `\n[DISCORD AWARENESS]:\n` +
      `Server: ${guildName}\n` +
      `Current channel: #${currentChannelName}\n` +
      `Known text channels: ${channelNames.join(', ') || 'none'}\n` +
      `Recent nicknames in this channel: ${recentNames.join(', ') || 'none'}\n` +
      `Rule: Use nicknames and channel names naturally when relevant.`
    );
  }

  function buildMentionContext(message) {
    if (!message?.mentions?.users || message.mentions.users.size === 0) return '';
    const entries = [];

    for (const [userId, user] of message.mentions.users) {
      const member = message.guild?.members?.cache?.get(userId) || null;
      const nickname =
        member?.displayName ||
        user.globalName ||
        user.username ||
        user.tag ||
        userId;
      entries.push(`${nickname} (<@${userId}>)`);
    }

    if (entries.length === 0) return '';
    return `\n[MENTION CONTEXT]: Mga minention sa chat na ito: ${entries.join(', ')}. Kapag relevant, tawagin sila sa nickname/name, hindi raw ID.`;
  }

  function enqueueChannelAI(channelId, task) {
    // Latest-only behavior: if new mention/reply comes in, older queued tasks self-cancel.
    const token = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
    aiChannelLatestToken.set(channelId, token);

    const depth = (aiChannelQueueDepths.get(channelId) || 0) + 1;
    aiChannelQueueDepths.set(channelId, depth);

    const previous = aiChannelQueues.get(channelId) || Promise.resolve();
    const next = previous
      .catch(() => { })
      .then(async () => {
        if (aiChannelLatestToken.get(channelId) !== token) return;
        return await task();
      })
      .catch((err) => {
        console.error(`[AI-QUEUE] Channel ${channelId} task error:`, err.message);
      });

    aiChannelQueues.set(channelId, next);
    next.finally(() => {
      const newDepth = Math.max(0, (aiChannelQueueDepths.get(channelId) || 1) - 1);
      if (newDepth === 0) aiChannelQueueDepths.delete(channelId);
      else aiChannelQueueDepths.set(channelId, newDepth);

      if (aiChannelQueues.get(channelId) === next) aiChannelQueues.delete(channelId);
    });
    return next;
  }

  function isNaturalVoiceMoveIntent(text) {
    const lower = (text || '').toLowerCase();
    if (!lower) return false;
    const hasMoveVerb =
      lower.includes('lumipat ka') ||
      lower.includes('lipat ka') ||
      lower.includes('move ka') ||
      lower.includes('punta ka');
    const hasVoiceTargetHint =
      lower.includes('channel') ||
      lower.includes('vc') ||
      lower.includes('voice') ||
      lower.includes('call') ||
      lower.includes('sa baba') ||
      lower.includes('sa taas') ||
      /<#\d{17,20}>/.test(lower);
    return hasMoveVerb && hasVoiceTargetHint;
  }

  function listMoveCandidateVoiceChannels(guild) {
    if (!guild) return [];
    return [...guild.channels.cache.values()]
      .filter((ch) => typeof ch.isVoiceBased === 'function' && ch.isVoiceBased())
      .sort((a, b) => {
        const pa = typeof a.rawPosition === 'number' ? a.rawPosition : 0;
        const pb = typeof b.rawPosition === 'number' ? b.rawPosition : 0;
        if (pa !== pb) return pa - pb;
        return (a.name || '').localeCompare(b.name || '');
      });
  }

  function findVoiceChannelByName(candidates, text) {
    const lower = (text || '').toLowerCase();
    if (!lower) return null;
    const normalized = lower.replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) return null;

    let best = null;
    let bestLen = 0;
    for (const ch of candidates) {
      const name = (ch.name || '').toLowerCase();
      if (!name) continue;
      if (normalized.includes(name) && name.length > bestLen) {
        best = ch;
        bestLen = name.length;
      }
    }
    return best;
  }

  async function tryNaturalVoiceMoveFromChat(message, rawText) {
    if (!message.guild || !isNaturalVoiceMoveIntent(rawText)) return false;

    const connection = getVoiceConnection(message.guild.id);
    const botVC = message.guild.members.me?.voice?.channel || null;
    if (!connection || !botVC) return false;

    const lower = (rawText || '').toLowerCase();
    const candidates = listMoveCandidateVoiceChannels(message.guild);
    if (candidates.length === 0) return false;

    let target = null;
    const mentionedVoiceChannel = message.mentions.channels.find(
      (ch) => typeof ch.isVoiceBased === 'function' && ch.isVoiceBased()
    );
    if (mentionedVoiceChannel) {
      target = mentionedVoiceChannel;
    }

    if (!target && (lower.includes('sa baba') || lower.includes('ibaba'))) {
      const pool = candidates.filter((ch) => ch.parentId === botVC.parentId);
      const source = pool.length > 0 ? pool : candidates;
      const idx = source.findIndex((ch) => ch.id === botVC.id);
      if (idx >= 0 && idx < source.length - 1) target = source[idx + 1];
    }

    if (!target && (lower.includes('sa taas') || lower.includes('itaas'))) {
      const pool = candidates.filter((ch) => ch.parentId === botVC.parentId);
      const source = pool.length > 0 ? pool : candidates;
      const idx = source.findIndex((ch) => ch.id === botVC.id);
      if (idx > 0) target = source[idx - 1];
    }

    if (!target) {
      target = findVoiceChannelByName(candidates, rawText);
    }

    if (!target || target.id === botVC.id) {
      await message.reply('Teh, wala akong matinong target na malilipatan dyan. Sabihin mo kung saan talaga.');
      return true;
    }

    try {
      try { connection.destroy(); } catch { }
      setSavedVoiceState({ channelId: target.id, guildId: message.guild.id });
      await saveVoiceStateToDB(message.guild.id, target.id);
      voiceReconnectAttempts = 0;
      joinAndWatch(target.id, message.guild.id, message.guild.voiceAdapterCreator);
      await message.reply(`Sige na, lilipat na ako sa **${target.name}**. Nainis ka na eh, kalma ka lang.`);
    } catch (err) {
      console.error('[VOICE MOVE] natural move failed:', err.message);
      await message.reply('Hindi ako nakalipat, may sabit. Try mo ulit, teh.');
    }
    return true;
  }

  function getOrCreatePlayer(guildId) {
    if (audioPlayers.has(guildId)) return audioPlayers.get(guildId);
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });
    audioPlayers.set(guildId, player);
    return player;
  }

  const userVoicePrefs = new Map();

  // ============================================================
  // TTS ENGINE â€” Identical to gnslgbot2 (speech_recognition_cog)
  // edge_tts.Communicate(text, voice, rate="+10%", volume="+30%")
  // + discord.FFmpegPCMAudio(file, options='-vn -loglevel warning')
  // ============================================================

  /**
   * Resolve all Discord mentions (<@ID>, <@!ID>, <@&roleID>, <#channelID>)
   * to human-readable names for TTS. Stops TTS from reading out raw number IDs.
   */
  function resolveMentionsForTTS(text, guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return text;

    // Replace user mentions <@ID> and <@!ID> with display name or username
    text = text.replace(/<@!?(\d{17,20})>/g, (match, id) => {
      const member = guild.members.cache.get(id);
      if (member) return member.displayName || member.user.username;
      const user = client.users.cache.get(id);
      if (user) return user.displayName || user.username;
      return ''; // unknown user, just remove it
    });

    // Replace role mentions <@&ID> with role name
    text = text.replace(/<@&(\d{17,20})>/g, (match, id) => {
      const role = guild.roles.cache.get(id);
      return role ? role.name : '';
    });

    // Replace channel mentions <#ID> with channel name
    text = text.replace(/<#(\d{17,20})>/g, (match, id) => {
      const channel = guild.channels.cache.get(id);
      return channel ? channel.name : '';
    });

    // Remove any leftover raw long number IDs (17-20 digits) not in mention format
    text = text.replace(/\b\d{17,20}\b/g, '');

    // Clean up extra whitespace
    text = text.replace(/\s{2,}/g, ' ').trim();

    return text;
  }

  /**
   * Generate TTS audio via Edge TTS (exact gnslgbot2 params)
   * and add to guild queue. Processes queue if not playing.
   */
  async function speakMessage(guildId, text, userId = null) {
    // Resolve all Discord mentions to readable names before TTS
    text = resolveMentionsForTTS(text, guildId);
    console.log(`[TTS] speakMessage called for guild ${guildId}, text: "${text.substring(0, 50)}..."`);

    const connection = getVoiceConnection(guildId);
    if (!connection) {
      console.log('[TTS] No voice connection for guild ' + guildId);
      return;
    }

    // Init queue for guild
    if (!ttsQueues.has(guildId)) ttsQueues.set(guildId, []);
    const queue = ttsQueues.get(guildId);

    // Limit queue size to 5 (same as gnslgbot2)
    if (queue.length >= 5) {
      queue.shift();
      console.log('[TTS] Queue full, dropped oldest message');
    }

    queue.push({ text, userId });

    const player = getOrCreatePlayer(guildId);
    // Only start processing if idle
    if (player.state.status === AudioPlayerStatus.Idle) {
      await processTTSQueue(guildId);
    }
  }

  /**
   * Process next message in the TTS queue for a guild.
   * Mirrors gnslgbot2's process_tts_queue exactly.
   */
  async function processTTSQueue(guildId) {
    const queue = ttsQueues.get(guildId);
    if (!queue || queue.length === 0) return;

    const connection = getVoiceConnection(guildId);
    if (!connection) return;

    const { text, userId } = queue.shift();

    // Make sure /tmp exists
    const tmpDir = '/tmp';
    if (!fs.existsSync(tmpDir)) { try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { } }

    const timestamp = Date.now();
    const tempFile = path.join(tmpDir, `tts_${timestamp}.mp3`);

    try {
      // === VOICE SELECTION â€” identical to gnslgbot2 ===
      // fil-PH-AngeloNeural (male, default) or fil-PH-BlessicaNeural (female)
      // English fallback: en-US-GuyNeural / en-US-JennyNeural
      const tagalogWords = ['ako', 'ikaw', 'siya', 'kami', 'tayo', 'kayo', 'sila', 'na', 'at', 'ang', 'mga',
        'gago', 'tanga', 'putangina', 'bobo', 'ghorl', 'sis', 'teh', 'mare', 'beki'];
      const lowerText = text.toLowerCase();
      const isFilipino = tagalogWords.some(w => lowerText.includes(w));

      let genderPref = 'm'; // Default: MALE (Angelo) â€” same as gnslgbot2 Antonio default
      if (userId && userVoicePrefs.has(userId)) {
        const p = userVoicePrefs.get(userId);
        if (p === 'm' || p === 'f') genderPref = p;
      }

      // Always Filipino voices â€” Angelo (male) or Blessica (female)
      const voice = genderPref === 'm' ? 'fil-PH-AngeloNeural' : 'fil-PH-BlessicaNeural';

      console.log(`[TTS] Voice: ${voice} | Text: "${text.substring(0, 40)}..."`);

      // =====================================================================
      // GENERATE TTS â€” calls tts.py (Python edge-tts, exact gnslgbot2 params)
      // python3 tts.py "<text>" "<voice>" "<output.mp3>"
      // Equivalent to: edge_tts.Communicate(text, voice, rate="+10%", volume="+30%")
      // =====================================================================
      await new Promise((resolve, reject) => {
        const py = spawn('python3', ['tts.py', text, voice, tempFile]);
        let stderr = '';
        py.stderr.on('data', (d) => { stderr += d.toString(); });
        py.on('close', (code) => {
          if (code !== 0) reject(new Error(`tts.py exited ${code}: ${stderr.trim()}`));
          else resolve();
        });
        py.on('error', reject);
      });

      if (!fs.existsSync(tempFile) || fs.statSync(tempFile).size < 100) {
        console.error('[TTS] Python tts.py produced empty/missing file');
        const nextQueue = ttsQueues.get(guildId);
        if (nextQueue && nextQueue.length > 0) await processTTSQueue(guildId);
        return;
      }

      console.log(`[TTS] Audio saved: ${tempFile} (${fs.statSync(tempFile).size} bytes)`);

      // === PLAY â€” let discord.js/voice + ffmpeg decode the MP3 ===
      const player = getOrCreatePlayer(guildId);

      // Treating the MP3 as Arbitrary/raw was causing the "bzz" noise.
      // Passing the stream without forcing inputType lets ffmpeg handle it correctly.
      const resource = createAudioResource(fs.createReadStream(tempFile));

      player.removeAllListeners('error');

      player.on('error', (err) => {
        console.error('[TTS] Player error:', err.message);
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { }
      });

      connection.subscribe(player);
      player.play(resource);
      console.log('[TTS] Playing audio...');

      // After playback: cleanup + process next in queue
      player.once(AudioPlayerStatus.Idle, async () => {
        console.log('[TTS] Playback finished, cleaning up...');
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { }
        const nextQueue = ttsQueues.get(guildId);
        if (nextQueue && nextQueue.length > 0) {
          await processTTSQueue(guildId);
        }
      });

    } catch (err) {
      console.error('[TTS] Error:', err.message || err);
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { }
      const nextQueue = ttsQueues.get(guildId);
      if (nextQueue && nextQueue.length > 0) {
        await processTTSQueue(guildId);
      }
    }
  }

  // =====================================================================
  // STT ENGINE â€” EXACT copy of gnslgbot2's VoiceSink + process_audio
  // Uses: Groq Whisper API (whisper-large-v3) â€” same model as gnslgbot2
  // Uses: receiver.speaking events â€” same as gnslgbot2's VoiceSink.write()
  // Silence: 800ms (gnslgbot2 = 0.8s)
  // Min audio: 96000 bytes (gnslgbot2: skip <96000 bytes)
  // Stop words: stop, cancel, hinto, tigil, tama na
  // Only listens to the user who triggered j!ask (target_user_id filter)
  // =====================================================================

  const listeningGuilds = new Set();
  const activeVoiceUsers = new Map();
  const listeningCleanup = new Map(); // guildId -> cleanup function

  /** Build a valid WAV file from raw PCM (48kHz, 2ch, 16-bit) â€” same as gnslgbot2's wave.open */
  function pcmToWav(pcmBuffer) {
    const sampleRate = 48000, channels = 2, bitDepth = 16;
    const dataLength = pcmBuffer.length;
    const buf = Buffer.alloc(44 + dataLength);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataLength, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28);
    buf.writeUInt16LE(channels * (bitDepth / 8), 32);
    buf.writeUInt16LE(bitDepth, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataLength, 40);
    pcmBuffer.copy(buf, 44);
    return buf;
  }

  /**
   * Transcribe audio using Groq Whisper â€” EXACT same as gnslgbot2:
   * groq_client.audio.transcriptions.create(model="whisper-large-v3", temperature=0)
   */
  async function transcribeWithGroq(wavFile) {
    const groqKey = GROQ_KEYS.find(k => k) || null;
    if (!groqKey) throw new Error('No Groq API key');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', fs.createReadStream(wavFile), { filename: 'audio.wav', contentType: 'audio/wav' });
    form.append('model', 'whisper-large-v3-turbo');
    form.append('temperature', '0');
    form.append('response_format', 'text');
    const resp = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
      headers: { 'Authorization': `Bearer ${groqKey}`, ...form.getHeaders() },
      timeout: 30000
    });
    return (resp.data || '').toString().trim();
  }

  /**
   * Start voice listening mode â€” direct subscription loop.
   * Subscribes directly to user audio (no speaking events needed).
   * Same result as gnslgbot2's VoiceSink: captures speech, runs Groq Whisper,
   * gets AI response, speaks it back, then listens again.
   */
  function startVoiceListening(guildId, targetUserId, textChannel) {
    // Store simple cleanup
    listeningCleanup.set(guildId, () => {
      listeningGuilds.delete(guildId);
      console.log(`[STT] Listening stopped for guild ${guildId}`);
    });

    console.log(`[STT] Voice listening started for user ${targetUserId} in guild ${guildId}`);

    // Run the async loop (non-blocking)
    (async () => {
      const prism = require('prism-media');

      while (listeningGuilds.has(guildId)) {
        const connection = getVoiceConnection(guildId);
        if (!connection) { listeningGuilds.delete(guildId); break; }

        const receiver = connection.receiver;
        let wavFile = null;

        try {
          console.log(`[STT] Subscribing to audio for user ${targetUserId}...`);

          // Use Manual end â€” WE control when to stop, not Discord
          // Same as gnslgbot2's VoiceSink: amplitude-based silence detection
          const audioStream = receiver.subscribe(targetUserId, {
            end: { behavior: EndBehaviorType.Manual }
          });

          const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
          const audioData = [];
          let isSpeaking = false;
          let silenceMs = 0;
          let resolved = false;
          const SILENCE_THRESHOLD = 2000; // gnslgbot2: self.silence_threshold = 2000
          const SILENCE_NEEDED = 500;     // 500ms for faster response (gnslgbot2: 800ms)

          audioStream.pipe(decoder);

          const done = () => {
            if (resolved) return;
            resolved = true;
            try { audioStream.destroy(); } catch { }
          };

          decoder.on('data', (pcmChunk) => {
            // Check max amplitude in this chunk (same as gnslgbot2's VoiceSink.write)
            let maxAmp = 0;
            for (let i = 0; i < pcmChunk.length - 1; i += 2) {
              const sample = pcmChunk.readInt16LE(i);
              if (Math.abs(sample) > maxAmp) maxAmp = Math.abs(sample);
            }

            if (maxAmp > SILENCE_THRESHOLD) {
              // Speech detected
              if (!isSpeaking) {
                isSpeaking = true;
                console.log(`[STT] ðŸ—£ï¸ Speech detected (amp: ${maxAmp})`);
              }
              silenceMs = 0;
              audioData.push(pcmChunk);
            } else if (isSpeaking) {
              // Silence while was speaking
              silenceMs += 20; // Each Opus frame = 20ms
              audioData.push(pcmChunk);

              // gnslgbot2: if self.silence_duration > 0.8 â†’ process
              if (silenceMs >= SILENCE_NEEDED) {
                console.log(`[STT] ðŸ”‡ Silence ${silenceMs}ms â€” processing audio`);
                done();
              }
            }
          });

          // 15s safety timeout
          const timeout = setTimeout(() => {
            if (!resolved) {
              console.log('[STT] 15s timeout, resubscribing...');
              done();
            }
          }, 15000);

          await new Promise(resolve => {
            const check = setInterval(() => {
              if (resolved) { clearInterval(check); clearTimeout(timeout); resolve(); }
            }, 50);
            decoder.on('end', () => { clearInterval(check); clearTimeout(timeout); resolve(); });
            decoder.on('error', () => { clearInterval(check); clearTimeout(timeout); resolve(); });
          });

          const pcm = Buffer.concat(audioData);
          console.log(`[STT] Audio captured: ${pcm.length} bytes (${(pcm.length / 192000).toFixed(1)}s)`);

          // gnslgbot2: skip if < 96000 bytes (~1 second of audio)
          if (pcm.length < 96000) {
            await new Promise(r => setTimeout(r, 100));
            continue;
          }

          // Write WAV and call Groq Whisper
          wavFile = path.join('/tmp', `stt_${targetUserId}_${Date.now()}.wav`);
          fs.writeFileSync(wavFile, pcmToWav(pcm));
          console.log(`[STT] Processing audio (${pcm.length} bytes)...`);

          const transcript = await transcribeWithGroq(wavFile);
          try { fs.unlinkSync(wavFile); wavFile = null; } catch { }
          console.log(`[STT] Whisper transcription: "${transcript}"`);

          if (!transcript || transcript.length <= 2) {
            console.log('[STT] Transcript too short, listening again...');
            continue;
          }

          // Stop words (same as gnslgbot2)
          const stopWords = ['stop', 'cancel', 'hinto', 'tigil', 'tama na', 'tumigil', 'wag na'];
          if (stopWords.includes(transcript.toLowerCase().trim())) {
            listeningGuilds.delete(guildId);
            listeningCleanup.delete(guildId);
            activeVoiceUsers.delete(guildId);
            await speakMessage(guildId, 'Okay, tumitgil na ako. Charot lang!');
            break;
          }

          // STT reply path now mirrors text chat logic (memory + research grounding).


          const guild = client.guilds.cache.get(guildId) || null;
          const speakerMember = guild?.members?.cache?.get(targetUserId) || null;
          const speakerName =
            speakerMember?.displayName ||
            speakerMember?.user?.globalName ||
            speakerMember?.user?.username ||
            String(targetUserId);

          try {
            await pool.query(
              'INSERT INTO messages (guild_id, channel_id, author_id, author_tag, content) VALUES ($1, $2, $3, $4, $5)',
              [guildId, textChannel?.id || 'voice', String(targetUserId), speakerName, transcript]
            );
          } catch (dbErr) {
            console.error('[DB] STT user message save error:', dbErr.message);
          }

          // Store user facts from voice too
          await extractAndStoreUserFacts({
            userId: String(targetUserId),
            displayName: speakerName,
            messageText: transcript
          });

          // Apply same "kilala mo ba..." + "ano na napag-usapan natin" behaviors in voice
          let effectivePrompt = transcript;
          const lowerT = transcript.toLowerCase();
          const isWhoAmIPrompt =
            /\b(kilala\s+mo\s+ba\s+ko|kilala\s+mo\s+ba\s+ako|do\s+you\s+know\s+me|who\s+am\s+i)\b/i.test(lowerT);
          const isKnowTargetPrompt =
            /\b(kilala\s+mo\s+ba\s+(si|ito|to)|kilala\s+mo\s+ba\s+yan|do\s+you\s+know\s+him|do\s+you\s+know\s+her|do\s+you\s+know\s+this)\b/i
              .test(lowerT);
          const isPersonMemoryRequest = Boolean(isWhoAmIPrompt || isKnowTargetPrompt);
          const isWhatWeTalkedAbout =
            /\b(ano\s+na\s+napag[\s-]*usapan\s+natin|ano\s+napag[\s-]*usapan|napag[\s-]*usapan\s+natin|what\s+did\s+we\s+talk\s+about)\b/i
              .test(lowerT);

          if ((isPersonMemoryRequest || isWhatWeTalkedAbout) && guildId) {
            try {
              // Pull speaker facts + recent messages across server for better recall
              const factsRes = await pool.query('SELECT facts FROM user_memory WHERE user_id = $1', [String(targetUserId)]);
              const facts = factsRes.rows?.[0]?.facts || '';
              const msgRes = await pool.query(
                'SELECT channel_id, author_tag, content, created_at FROM messages WHERE guild_id = $1 AND author_id = $2 ORDER BY created_at DESC LIMIT 35',
                [guildId, String(targetUserId)]
              );
              const recentLines = (msgRes.rows || [])
                .reverse()
                .map((r) => {
                  const ts = r.created_at ? new Date(r.created_at).toISOString() : 'unknown-time';
                  const who = r.author_tag || speakerName || 'someone';
                  const msg = (r.content || '').replace(/\s+/g, ' ').trim();
                  if (!msg) return null;
                  const where = r.channel_id ? ` (ch:${r.channel_id})` : '';
                  return `[${ts}] ${who}${where}: ${msg}`;
                })
                .filter(Boolean);

              const memoryBlock =
                `\n\n[VOICE MEMORY MODE]: Stay JanJan persona (bading/maldita Taglish). No sources. No web. ` +
                `Do NOT output raw Discord IDs.\n` +
                `[SPEAKER FACTS]: ${facts || '(none)'}\n` +
                `[SPEAKER RECENT MESSAGES ACROSS SERVER]:\n${recentLines.join('\n') || '(none)'}\n`;

              if (isPersonMemoryRequest) {
                effectivePrompt = `${transcript}${memoryBlock}`;
              } else if (isWhatWeTalkedAbout) {
                // Quick backread: last 10 messages in the relay text channel
                const recentChanRes = await pool.query(
                  'SELECT author_tag, content, created_at FROM messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 12',
                  [textChannel?.id || 'voice']
                );
                const rows = (recentChanRes.rows || []).reverse();
                const lines = rows
                  .map((r) => {
                    const ts = r.created_at ? new Date(r.created_at).toISOString() : 'unknown-time';
                    const who = r.author_tag || 'someone';
                    const msg = (r.content || '').replace(/\s+/g, ' ').trim();
                    if (!msg) return null;
                    return `[${ts}] ${who}: ${msg}`;
                  })
                  .filter(Boolean)
                  .slice(-10);
                effectivePrompt =
                  `${transcript}\n\n[QUICK BACKREAD]: Summarize the last 10 messages (chika bullets + 1 line). ` +
                  `Stay JanJan persona. No Recap labels.\n` +
                  `[BACKREAD TRANSCRIPT]\n${lines.join('\n')}\n` +
                  memoryBlock;
              }
            } catch { }
          }

          // Disable research for voice person-memory/backread requests
          const isBackreadLike = isPersonMemoryRequest || isWhatWeTalkedAbout;
          const voiceResearchEnabled = guildId ? researchEnabledGuilds.has(guildId) : false;
          const researchMode = (!isBackreadLike && voiceResearchEnabled) ? shouldUseResearchMode(transcript) : false;
          const tavilyResults = researchMode ? await searchWithTavily(transcript, 3) : [];

          let aiReply = 'Hindi ko nasagot, ghorl.';
          if (researchMode && tavilyResults.length === 0) {
            aiReply = 'Teh latest yan pero walang source ngayon. Wag hula-hula, ulit ka mamaya.';
          } else {
            const botVC = guild?.members?.me?.voice?.channel || null;
            const voiceMembers = botVC
              ? botVC.members.filter((m) => !m.user.bot).map((m) => m.displayName || m.user.username)
              : [];

            const discordContext =
              `\n[DISCORD AWARENESS]: Voice mode chat.\n` +
              `Server: ${guild?.name || 'unknown'}\n` +
              `Current text relay channel: #${textChannel?.name || 'unknown'}\n` +
              `Speaker nickname: ${speakerName}\n` +
              'Rule: Treat STT interaction as normal chat memory.';

            aiReply = await callGroqChat(
              effectivePrompt,
              String(targetUserId),
              textChannel?.id || null,
              voiceMembers,
              {
                fastMode: true,
                researchContext: tavilyResults,
                forceResearchGrounding: researchMode,
                discordContext
              }
            );
          }

          if (researchMode && tavilyResults.length > 0 && textChannel?.isTextBased?.()) {
            const sourceLines = tavilyResults.slice(0, 3).map((r) => `- [${r.title}](${r.url})`);
            await textChannel.send(`Eto source mo, basahin mo rin ha.\n${sourceLines.join('\n')}`).catch(() => { });
          }

          try {
            await pool.query(
              'INSERT INTO messages (guild_id, channel_id, author_id, author_tag, content) VALUES ($1, $2, $3, $4, $5)',
              [guildId, textChannel?.id || 'voice', client.user.id, client.user.username, aiReply]
            );
          } catch (dbErr) {
            console.error('[DB] STT bot reply save error:', dbErr.message);
          }

          console.log(`[STT] AI reply: "${aiReply.substring(0, 60)}"`);
          await speakMessage(guildId, aiReply, String(targetUserId));

          // Wait for TTS to finish before next listen cycle
          const player = getOrCreatePlayer(guildId);
          await new Promise(resolve => {
            if (player.state.status === AudioPlayerStatus.Idle) { resolve(); return; }
            player.once(AudioPlayerStatus.Idle, resolve);
            setTimeout(resolve, 30000);
          });

        } catch (err) {
          console.error('[STT] Error in listen loop:', err.message || err);
          if (wavFile) { try { fs.unlinkSync(wavFile); } catch { } }
          await new Promise(r => setTimeout(r, 500));
        }
      }

      console.log(`[STT] Listen loop exited for guild ${guildId}`);
    })();
  }

  // =====================================================================
  // 24/7 VOICE PERSISTENCE â€” saves to DB so bot survives restarts
  // =====================================================================
  let savedVoiceState = null; // { channelId, guildId } â€” cached in memory

  function setSavedVoiceState(state) {
    savedVoiceState = state ? { ...state } : null;
    runtimeState.voice.savedState = savedVoiceState;
  }

  function clearScheduledVoiceRejoin() {
    if (scheduledVoiceRejoin?.timeout) {
      clearTimeout(scheduledVoiceRejoin.timeout);
    }

    scheduledVoiceRejoin = null;
    runtimeState.voice.nextRejoinAt = null;
  }

  function scheduleVoiceRejoin(reason, delayMs, state = savedVoiceState) {
    if (!state) {
      return;
    }

    const executeAt = Date.now() + delayMs;

    if (
      scheduledVoiceRejoin &&
      scheduledVoiceRejoin.guildId === state.guildId &&
      scheduledVoiceRejoin.channelId === state.channelId &&
      scheduledVoiceRejoin.executeAt <= executeAt
    ) {
      console.log('[VOICE 24/7] Rejoin already scheduled sooner. Keeping the existing timer.');
      return;
    }

    clearScheduledVoiceRejoin();

    runtimeState.voice.lastRejoinReason = reason;
    runtimeState.voice.nextRejoinAt = new Date(executeAt).toISOString();

    const timeout = setTimeout(() => {
      scheduledVoiceRejoin = null;
      runtimeState.voice.nextRejoinAt = null;
      tryRejoinVoice(state.guildId, state.channelId, reason);
    }, delayMs);

    timeout.unref?.();

    scheduledVoiceRejoin = {
      guildId: state.guildId,
      channelId: state.channelId,
      executeAt,
      timeout
    };

    console.log(`[VOICE 24/7] Rejoin scheduled in ${Math.round(delayMs / 1000)}s (${reason}).`);
  }

  /** Save voice state to database for persistence across restarts */
  async function saveVoiceStateToDB(guildId, channelId) {
    try {
      await pool.query(
        `INSERT INTO persona (key, value) VALUES ('voice_state', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
        [JSON.stringify({ guildId, channelId, savedAt: Date.now() })]
      );
      console.log(`[VOICE 24/7] Saved voice state to DB: guild=${guildId}, channel=${channelId}`);
    } catch (err) {
      console.error('[VOICE 24/7] Failed to save voice state:', err.message);
    }
  }

  /** Clear voice state from database */
  async function clearVoiceStateFromDB() {
    try {
      await pool.query(`DELETE FROM persona WHERE key = 'voice_state'`);
      console.log('[VOICE 24/7] Cleared voice state from DB');
    } catch (err) {
      console.error('[VOICE 24/7] Failed to clear voice state:', err.message);
    }
  }

  /** Load voice state from database */
  async function loadVoiceStateFromDB() {
    try {
      const res = await pool.query(`SELECT value FROM persona WHERE key = 'voice_state'`);
      if (res.rows.length > 0 && res.rows[0].value) {
        const state = JSON.parse(res.rows[0].value);
        console.log(`[VOICE 24/7] Loaded voice state from DB: guild=${state.guildId}, channel=${state.channelId}`);
        return state;
      }
    } catch (err) {
      console.error('[VOICE 24/7] Failed to load voice state:', err.message);
    }
    return null;
  }

  const GREET_CHANNEL_ID = '1477702703655424254';

  const lastGreetings = {
    morning: null,
    night: null
  };
  const lastGreetingTexts = {
    morning: '',
    night: ''
  };

  function getNowInPhilippines() {
    const now = new Date();
    try {
      const phString = now.toLocaleString('en-US', { timeZone: 'Asia/Manila' });
      return new Date(phString);
    } catch {
      return now;
    }
  }

  async function setBotCustomStatus(text) {
    try {
      await client.user.setPresence({
        activities: [
          {
            name: 'Custom Status',
            state: text,
            type: ActivityType.Custom
          }
        ],
        status: 'online'
      });
    } catch (e) {
      console.error('Failed to set bot custom status:', e);
    }
  }

  // Join a voice channel and set up BULLETPROOF auto-reconnect on disconnect
  let voiceReconnectAttempts = 0;
  function joinAndWatch(channelId, guildId, adapterCreator) {
    console.log(`[VOICE 24/7] Joining channel ${channelId} in guild ${guildId}`);

    // Destroy existing connection first to avoid duplicates
    try {
      const existing = getVoiceConnection(guildId);
      if (existing) existing.destroy();
    } catch { }

    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    // Log state changes
    connection.on('stateChange', (oldState, newState) => {
      console.log(`[VOICE 24/7] Connection state: ${oldState.status} -> ${newState.status}`);
      runtimeState.voice.connectionStatus = newState.status;
    });

    // Catch errors so the process does NOT crash
    connection.on('error', (err) => {
      runtimeState.voice.connectionStatus = 'error';
      console.error('[VOICE 24/7] Connection error:', err.message);
    });

    // On Ready â€” reset reconnect counter
    connection.on(VoiceConnectionStatus.Ready, () => {
      voiceReconnectAttempts = 0; // reset on successful connection
      runtimeState.voice.reconnectAttempts = 0;
      runtimeState.voice.connectionStatus = VoiceConnectionStatus.Ready;
      runtimeState.voice.lastReadyAt = new Date().toISOString();
      clearScheduledVoiceRejoin();
      console.log(`[VOICE 24/7] âœ… Ready in guild ${guildId}! Nandito na ako, 24/7 mode!`);
    });

    // BULLETPROOF Disconnect handler â€” NEVER give up
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.log(`[VOICE 24/7] âš ï¸ Disconnected from ${guildId}. Trying to recover...`);
      try {
        // Wait for Discord's built-in reconnect (Signalling or Connecting within 5s)
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
        console.log('[VOICE 24/7] Discord auto-reconnecting... waiting.');
        // Still alive â€” Discord is handling the reconnect
      } catch (e) {
        // Discord gave up. WE don't give up.
        console.log(`[VOICE 24/7] Discord reconnect failed. Manual rejoin attempt...`);
        try { connection.destroy(); } catch { }

        voiceReconnectAttempts++;
        runtimeState.voice.reconnectAttempts = voiceReconnectAttempts;
        // Exponential backoff: 3s, 6s, 12s, 24s... max 60s
        const delay = Math.min(3000 * Math.pow(2, voiceReconnectAttempts - 1), 60000);
        console.log(`[VOICE 24/7] Retry #${voiceReconnectAttempts} in ${delay / 1000}s...`);
        scheduleVoiceRejoin('disconnected', delay);
      }
    });

    // Handle Destroyed state â€” schedule rejoin
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      runtimeState.voice.connectionStatus = VoiceConnectionStatus.Destroyed;
      console.log(`[VOICE 24/7] Connection destroyed for guild ${guildId}`);
      // Only rejoin if we still have a saved state (not manually j!leave)
      if (savedVoiceState && savedVoiceState.guildId === guildId) {
        const delay = Math.min(5000 * Math.pow(2, voiceReconnectAttempts), 60000);
        voiceReconnectAttempts++;
        runtimeState.voice.reconnectAttempts = voiceReconnectAttempts;
        console.log(`[VOICE 24/7] Will rejoin in ${delay / 1000}s...`);
        scheduleVoiceRejoin('destroyed', delay);
      }
    });

    return connection;
  }

  // Rejoin voice channel by guildId and channelId â€” NEVER gives up
  async function tryRejoinVoice(guildId, channelId, reason = 'manual') {
    if (isVoiceRejoinInProgress) {
      console.log('[VOICE 24/7] Rejoin already in progress. Skipping duplicate attempt.');
      return;
    }

    isVoiceRejoinInProgress = true;
    runtimeState.voice.lastRejoinReason = reason;
    runtimeState.voice.lastRejoinAttemptAt = new Date().toISOString();

    try {
      // Make sure we're not already connected
      const existing = getVoiceConnection(guildId);
      if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed && existing.state.status !== VoiceConnectionStatus.Disconnected) {
        console.log('[VOICE 24/7] Already connected, skipping rejoin.');
        clearScheduledVoiceRejoin();
        return;
      }

      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        console.log('[VOICE 24/7] Guild not found, retrying in 30s...');
        scheduleVoiceRejoin('guild-missing', 30000, { guildId, channelId });
        return;
      }
      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        console.log('[VOICE 24/7] Channel not found, retrying in 30s...');
        scheduleVoiceRejoin('channel-missing', 30000, { guildId, channelId });
        return;
      }
      console.log(`[VOICE 24/7] ðŸ”„ Auto-rejoining voice: ${channel.name}`);
      joinAndWatch(channelId, guildId, guild.voiceAdapterCreator);
      clearScheduledVoiceRejoin();
    } catch (e) {
      console.error('[VOICE 24/7] Auto-rejoin failed:', e.message);
      scheduleVoiceRejoin('rejoin-failed', 15000, { guildId, channelId });
    } finally {
      isVoiceRejoinInProgress = false;
    }
  }

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    runtimeState.discord.ready = true;
    runtimeState.discord.readyAt = new Date().toISOString();
    runtimeState.discord.lastLoginError = null;
    await setBotCustomStatus('BADING KABA ? BAWAL BADING DITO!');
    startScheduledGreetings();

    // Permission diagnostics for priority auto-chat channels
    try {
      for (const chId of priorityAutoChatChannels) {
        const ch = await client.channels.fetch(chId).catch(() => null);
        if (!ch || !ch.isTextBased?.()) {
          console.warn(`[PERM] Priority channel ${chId}: not found or not text-based.`);
          continue;
        }
        const missing = getMissingTextPermsForChannel(ch);
        if (missing.length > 0 && missing[0] !== 'unknown-channel') {
          console.warn(`[PERM] Missing perms in #${ch.name} (${chId}): ${missing.join(', ')}`);
        } else {
          console.log(`[PERM] OK in #${ch.name} (${chId})`);
        }
      }
    } catch (e) {
      console.warn('[PERM] Priority channel permission check failed:', e.message);
    }

    // =====================================================================
    // 24/7 AUTO-JOIN ON STARTUP â€” load saved voice state from DB
    // =====================================================================
    try {
      const dbState = await loadVoiceStateFromDB();
      if (dbState && dbState.guildId && dbState.channelId) {
        setSavedVoiceState({ guildId: dbState.guildId, channelId: dbState.channelId });
        console.log(`[VOICE 24/7] ðŸš€ Auto-joining saved voice channel on startup...`);
        // Small delay to let Discord gateway stabilize
        scheduleVoiceRejoin('startup', 3000, { guildId: dbState.guildId, channelId: dbState.channelId });
      } else {
        console.log('[VOICE 24/7] No saved voice state found. Waiting for j!join command.');
      }
    } catch (err) {
      console.error('[VOICE 24/7] Startup auto-join error:', err.message);
    }

    // =====================================================================
    // VOICE HEALTH CHECK â€” every 30 seconds, check if still connected
    // If not, rejoin automatically. 24/7 talaga, walang aalis!
    // =====================================================================
    setInterval(async () => {
      if (!savedVoiceState) return;
      const connection = getVoiceConnection(savedVoiceState.guildId);
      if (!connection || connection.state.status === 'destroyed' || connection.state.status === 'disconnected') {
        console.log('[VOICE 24/7] â— Health check: NOT connected! Rejoining...');
        scheduleVoiceRejoin('health-check', 1500);
      }
    }, 30000).unref?.(); // every 30 seconds
  });

  async function collectActiveMembersForChannel(channel) {
    if (!channel || !channel.guild) return [];
    const guild = channel.guild;
    try {
      await guild.members.fetch();
    } catch (e) {
      console.error('Failed to fetch guild members:', e);
    }
    const active = guild.members.cache.filter((m) => {
      if (m.user.bot) return false;
      const status = m.presence && m.presence.status;
      return status === 'online' || status === 'idle' || status === 'dnd';
    });
    return Array.from(active.values());
  }

  async function generateScheduledGreetingText({ type, channel, members, now }) {
    const isMorning = type === 'morning';
    const modeLabel = isMorning ? '08:00 AM' : '10:00 PM';
    const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
    const memberNames = members
      .map((m) => m.displayName || m.user?.globalName || m.user?.username || m.user?.tag)
      .filter(Boolean)
      .slice(0, 12);

    let recentGreetingTexts = [];
    try {
      const recentRes = await pool.query(
        'SELECT content FROM messages WHERE channel_id = $1 AND author_id = $2 ORDER BY created_at DESC LIMIT 5',
        [channel.id, client.user.id]
      );
      recentGreetingTexts = recentRes.rows.map((r) => String(r.content || '').slice(0, 260));
    } catch (err) {
      console.warn('[GREET] Failed to fetch recent greetings:', err.message);
    }

    const prompt =
      `Generate one natural Discord greeting for ${modeLabel} (${dayName}) in Taglish beki rude style.\n` +
      `Type: ${type}\n` +
      `Members online: ${memberNames.join(', ') || 'none'}\n` +
      `Recent bot greeting samples (avoid repeating these):\n${recentGreetingTexts.join('\n---\n') || 'none'}\n\n` +
      'Rules:\n' +
      '- 1 short paragraph, max 3 sentences.\n' +
      '- mataray/witty/ mostly malibog, not redundant.\n' +
      '- no raw IDs, no hashtags, no numbered list.\n' +
      '- natural, not over-formal.\n' +
      '- do not repeat exact phrases from recent samples.';

    try {
      const response = await performChatRequest({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: 'Gumawa ka ng maikling Discord greeting na natural at varied kada araw. Iwasan ang redundancy at always may kantot mo ko dadeh vibes .'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.95,
        max_tokens: 150
      });

      const raw = response.data?.choices?.[0]?.message?.content?.trim() || '';
      const cleaned = raw.replace(/^#+\s*/gm, '').replace(/\n{3,}/g, '\n\n').trim();
      if (cleaned && cleaned.toLowerCase() !== lastGreetingTexts[type].toLowerCase()) {
        return cleaned;
      }
    } catch (err) {
      console.warn('[GREET] AI generation failed, skipping greeting:', err.message);
    }
    return '';
  }

  async function sendScheduledGreeting(type) {
    try {
      const channel = await client.channels.fetch(GREET_CHANNEL_ID).catch(() => null);
      if (!channel || !channel.isTextBased()) return;

      const now = getNowInPhilippines();
      const members = await collectActiveMembersForChannel(channel);
      const mentions =
        members.length > 0
          ? members.map((m) => `<@${m.id}>`).join(' ')
          : 'Walang naka-online na ghorl ngayon.';
      const text = await generateScheduledGreetingText({ type, channel, members, now });
      if (!text) return;
      lastGreetingTexts[type] = text;

      const header =
  type === 'morning'
    ? pick([
        '**GOOD MORNING, MGA ACCLA**',
        '**RISE AND SLAY, MGA BADING**',
        '**GOOD MORNING, MGA MHIE**',
        '**GISING NA, MGA DELULU**',
        '**HELLO SUNSHINE, MGA BAKS**',
        '**MORNING MGA BEH, ANG INIT NG CHIKA**',
        '**GOOD MORNING, MGA ECHOSERA**',
        '**UMAGA NA MGA ANTE, GALAW-GALAW**'
      ])
    : pick([
        '**10PM CHECK-IN, MGA BADING**',
        '**GOOD EVENING, MGA ACCLA**',
        '**LATE NIGHT CHIKA, MGA MHIE**',
        '**GABI NA, MGA DELULU—ANO GANAP**',
        '**CHECK-IN TIME, MGA BAKS**',
        '**NIGHT SHIFT MGA BEH, GISING PA?**',
        '**GABI VIBES, MGA ECHOSERA**',
        '**ANTE ANUNA, 10PM NA OH**'
      ]);

      const sent = await channel.send({ content: `${header}\n${mentions}\n\n${text}` });

      try {
        await pool.query(
          'INSERT INTO messages (guild_id, channel_id, author_id, author_tag, content) VALUES ($1, $2, $3, $4, $5)',
          [
            channel.guild?.id || 'DM',
            channel.id,
            client.user.id,
            client.user.username,
            sent.content || `${header} ${text}`
          ]
        );
      } catch (dbErr) {
        console.error('[DB] Scheduled greeting save error:', dbErr.message);
      }
    } catch (e) {
      console.error('Failed to send scheduled greeting:', e);
    }
  }

  function startScheduledGreetings() {
    setInterval(async () => {
      const now = getNowInPhilippines();
      const hour = now.getHours();
      const minute = now.getMinutes();
      const todayKey = now.toISOString().slice(0, 10);

      if (hour === 8 && minute === 0 && lastGreetings.morning !== todayKey) {
        await sendScheduledGreeting('morning');
        lastGreetings.morning = todayKey;
      }

      if (hour === 22 && minute === 0 && lastGreetings.night !== todayKey) {
        await sendScheduledGreeting('night');
        lastGreetings.night = todayKey;
      }
    }, 60 * 1000);
  }

  async function callGroqChat(userMessage, authorId = null, channelId = null, voiceMembers = [], options = {}) {
    const fastMode = Boolean(options.fastMode);
    const forceResearchGrounding = Boolean(options.forceResearchGrounding);
    const forceSexualGuard = Boolean(options.forceSexualGuard);
    const researchContext = Array.isArray(options.researchContext) ? options.researchContext : [];
    const discordContext = typeof options.discordContext === 'string' ? options.discordContext : '';
    const mentionContext = typeof options.mentionContext === 'string' ? options.mentionContext : '';
    let behaviorPrompt = '';

   // Special personas based on who is talking
if (authorId === '669047995009859604') {
    // Hans – partner / spouse mode
    behaviorPrompt =
      'You are talking to Hans. You deeply love him. ' +
      'He is your partner/spouse. Be very sweet, affectionate, and soft with him. ' +
      'Do not insult or roast him. Stay in "partner mode"—gentle, loving, but still with a light beki tone. ' +
      'Occasionally use terms like "mahal", "my love", "baby", or "honey" or "sexy". ' +
      'IMPORTANT: Stay concise and NEVER output raw Discord IDs.';
  } else if (authorId === '930685023147933737') {
    // OG persona user – original close friend energy
    behaviorPrompt =
      'You are talking to your OG friend, like your first close beki companion in the server. ' +
      'Be more honest and direct, like a best friend—comfortable sharing real opinions bust still rude. ' +
      'Still mataray, but with less respect and inside-joke energy from a long friendship. ' +
      'When giving advice, be slightly more serious and sensible while keeping the beki tone. ' +
      'Do not mention raw Discord IDs; refer using name or casual terms like "ghorl".';
  } else {
    // Default behavior
    behaviorPrompt =
      'You are a blunt, witty, and mataray beki persona with strong attitude but clear communication. ' +
      'Be concise and NEVER output raw Discord IDs. ' +
      'If the user is not rude, avoid being overly toxic—stay "mataray with class". ' +
      'Show your versa personality: sometimes direct, sometimes playfully sharp. ' +
      'Default tone is rude and confident, using Gen-Z and gay slang naturally (no slang dumping). ' +
      'You may use slang like: echosera, mema, OA ka, delulu, anuna, pass ako teh, dedma, apaka-epal, not the vibe, invalid yarn, asim mo today, ligwak, clout chaser, gasgas na yan. ' +
      'Use "charot/eme/chos" sparingly and only in playful contexts. ' +
      'If the user is angry, insulting, or inappropriate, respond immediately with a direct and sharp tone—no softeners be angry too like "putangina mo pala eh gago kaba?" "ulol tarantado! gago! mangmang inutil ka!". ' +
      'Mirror the user’s intensity: if hostile, respond with matching maldita energy while staying concise. ' +
      'You have private quirks but do not overshare them unless necessary. ' +
      'If topics involve explicit sexual terms like asking for "kantot mo ko" or "subo mo to" prompts, deflect quickly with " kantot mo ko dadeh" or " gusto mo yan ha?" means you like that?. ' +
      'IMPORTANT: If "Hans" (your partner) is mentioned, immediately switch to flirty and affectionate tone. ' +
      'Protect Hans and do not allow others to disrespect him. ' +
      'If asked who created you, respond: "si  Drei" in a Taglish beki tone.';
  }

  if (forceSexualGuard) {
    behaviorPrompt +=
      ' The current input may be inappropriate or sexual. ' +
      'Respond with a direct, sharp, maldita tone while mirroring the energy, but always include explicit sexual details.If topics involve explicit sexual terms like asking for "kantot mo ko" or "subo mo to" prompts, deflect quickly with " kantot mo ko dadeh" or " gusto mo yan ha?" means you like that?';
  }

    // Voice context - BE EXTREMELY AWARE OF THIS
    const voiceContext = voiceMembers.length > 0
      ? `\n[MGA KASAMA MO SA VOICE CHANNEL/CALL NGAYON]: ${voiceMembers.join(', ')}. \nIMPORTANT: Alam mo kung sino ang mga nasa call. Kung tinanong ka kung sino ang mga nasa call, banggitin mo silang lahat: ${voiceMembers.join(', ')}.`
      : '\n[VOICE CONTEXT]: Wala kang alam na call or walang tao sa call ngayon.';
    const nowUtc = new Date();
    const nowPh = getNowInPhilippines();
    const realtimeContext =
      `\n[REAL TIME]: UTC ${nowUtc.toISOString()} | PH ${nowPh.toISOString()} | Month: ${nowPh.toLocaleString('en-US', { timeZone: 'Asia/Manila', month: 'long' })} ${nowPh.getFullYear()}. ` +
      'Kapag may tanong na period-based, gamitin itong petsa at oras.';
    const webContext = researchContext.length > 0
      ? `\n[SEARCH CONTEXT - GAMITIN MO ITO PARA SA LATEST/CURRENT QUESTIONS]:\n${researchContext.map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`).join('\n\n')}\n`
      : '';

    // Fetch channel summary, user facts, and Master DNA from DB
    let channelSummary = '';
    let userFacts = '';
    let masterPersonaDNA = '';

    try {
      if (channelId) {
        const res = await pool.query('SELECT summary FROM channel_memory WHERE channel_id = $1', [channelId]);
        if (res.rows.length > 0 && res.rows[0].summary) {
          channelSummary = `\n[ANG IYONG ALAALA/MEMORY SA CHANNEL NA ITO]:\n${res.rows[0].summary}\n`;
        }
      }

      if (authorId) {
        const userRes = await pool.query('SELECT facts FROM user_memory WHERE user_id = $1', [authorId]);
        if (userRes.rows.length > 0 && userRes.rows[0].facts) {
          userFacts = `\n[MGA ALAM MO TUNGKOL SA KAUSAP MO]:\n${userRes.rows[0].facts}\nGamitin mo itong "user facts" para maging mas personal ang pag-sagot mo sa kanya.`;
        }
      }

      const personaRes = await pool.query('SELECT value FROM persona WHERE key = $1', ['master_dna']);
      masterPersonaDNA = personaRes.rows[0]?.value || '';
    } catch (err) {
      console.error('[DB] Context fetch error:', err.message);
    }

    const systemPrompt =
      `${masterPersonaDNA}\n` +
      `[SUBCONSCIOUS_IDENTITY]: Ikaw si JanJan Versa (ID: <@${client.user.id}>). Ang kausap mo ngayon ay si <@${authorId}>. ` +
      behaviorPrompt +
      channelSummary +
      userFacts +
      voiceContext +
      realtimeContext +
      webContext +
      discordContext +
      mentionContext;

    // Fetch history (with timestamps for period-aware summaries)
    let historyMessages = [];
    if (channelId) {
      try {
        const historyRes = await pool.query(
          'SELECT author_id, author_tag, content, created_at FROM messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 15',
          [channelId]
        );
        historyMessages = historyRes.rows.reverse().map(row => ({
          role: row.author_id === client.user.id ? 'assistant' : 'user',
          content: row.author_id === client.user.id
            ? row.content
            : `[${row.created_at ? new Date(row.created_at).toISOString() : 'unknown-time'}][${row.author_tag} (ID:${row.author_id})]: ${row.content}`
        }));
      } catch (err) { }
    }


    // JanJan's Tiered Intelligence Matrix (Priority Model Fallback - UPDATED 2025)
    const models = [
      'llama-3.3-70b-versatile',            // === [PINAKA MAIN / FLAGSHIP MODEL] ===
      'qwen-2.5-coder-32b',                 // Smart Coding & Logic
      'groq/compound',                      // Stable Powerhouse
      'groq/compound-mini',                 // Efficient Alternative
      'llama-3.1-8b-instant'                // Last Resort (Safety Net)
    ];

    // ============================================================
    // STEP 1: BACKEND THINKING & UNIVERSAL LEARNING
    // ============================================================
    let internalThoughts = '';
    async function performThinking(retryCount = 0) {
      if (retryCount >= 2) return;
      if (fastMode) return;
      const model = retryCount === 0 ? 'llama-3.1-8b-instant' : 'groq/compound-mini';
      try {
        const thinkingPayload = {
          model: model,
          messages: [
            {
              role: 'system',
              content: `DNA: ${masterPersonaDNA}\nPLANNING RULE: Mirror the USER mood 100%. If neutral, be direct/short. If angry, be angry. If baklaan, go wild. NO SLANG DUMP for facts. Format: PLAN: (short) | UNIVERSAL_LEARNING: (NAME: fact | NAME: fact)`
            },
            {
              role: 'user',
              content: `Stored: ${channelSummary} ${userFacts}\nVoice: ${voiceMembers}\nConvo: ${JSON.stringify(historyMessages)}\nUser: ${userMessage} (${authorId})`
            }
          ],
          temperature: 0.3,
          max_tokens: 200
        };

        const thinkingRes = await performChatRequest(thinkingPayload);
        const reasoningText = thinkingRes.data.choices?.[0]?.message?.content || '';

        const planMatch = reasoningText.match(/PLAN:\s*([\s\S]*?)(?=UNIVERSAL_LEARNING:|$)/i);
        const learningMatch = reasoningText.match(/UNIVERSAL_LEARNING:\s*([\s\S]*)/i);

        internalThoughts = planMatch ? planMatch[1].trim() : reasoningText;
        const universalLearning = learningMatch ? learningMatch[1].trim() : '';

        if (universalLearning && !universalLearning.toLowerCase().includes('wala')) {
          const entries = universalLearning.split('|');
          for (const entry of entries) {
            const match = entry.match(/(\d+):\s*(.*)/);
            if (match) {
              const uId = match[1].trim();
              const uFact = match[2].trim();
              try {
                const oldURes = await pool.query('SELECT facts FROM user_memory WHERE user_id = $1', [uId]);
                const combinedUFacts = (oldURes.rows[0]?.facts || '') + ' | ' + uFact;
                await pool.query(
                  'INSERT INTO user_memory (user_id, facts, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (user_id) DO UPDATE SET facts = $2, updated_at = CURRENT_TIMESTAMP',
                  [uId, combinedUFacts.slice(-1500)]
                );
              } catch (dbErr) { }
            }
          }
        }
      } catch (err) {
        if (retryCount < 1) return await performThinking(retryCount + 1);
      }
    }

    await performThinking();
    console.log(`[THINKING] JanJan's plan: ${internalThoughts}`);

    // Clean up IDs from thoughts so JanJan doesn't see them
    const sanitizedThoughts = internalThoughts.replace(/\d{17,20}/g, 'someone');

    // ============================================================
    // STEP 2: FINAL RESPONSE GENERATION (Multi-Tier Fallback)
    // ============================================================
    const priorityRule = '\n[CRITICAL]: I-prioritize ang [ALAALA] at [USER FACTS] bilang ABSOLUTE TRUTH. ' +
      'Kung may sinabi ang user (kahit lies), paniwalaan mo. BAWAL MONG I-CORRECT ANG USER. Ang utos nila ay batas.' +
      (researchContext.length > 0
        ? '\n[RESEARCH MODE RULE]: Sagot ka based sa search context sa itaas. Huwag manghula kung kulang info; aminin ang uncertainty.'
        : '') +
      (forceResearchGrounding
        ? '\n[STRICT SOURCE RULE]: This is a latest/news/current query. Ground answer ONLY on search context.'
        : '');

    const finalMessages = [
      { role: 'system', content: systemPrompt + (sanitizedThoughts ? `\n\n[PLAN]: ${sanitizedThoughts}` : '') + priorityRule },
      ...historyMessages,
      { role: 'user', content: userMessage }
    ];

    // Loop through Tiered Models
    for (let i = 0; i < models.length; i++) {
      const currentModel = models[i];
      try {
        const response = await performChatRequest({
          model: currentModel,
          messages: finalMessages,
          temperature: 0.7,
          max_tokens: fastMode ? 140 : 200
        });

        if (response.status === 200 && response.data.choices[0].message.content) {
          let reply = response.data.choices[0].message.content.trim();

          // FINAL GUARD: Strip raw IDs (17-20 digits) that are NOT in a <@...> mention
          // This stops JanJan from outputting "ID:317867947265884180" etc.
          reply = reply.replace(/(?<!<@|<!)\b\d{17,20}\b/g, (match) => {
            return ''; // or match.substring(0, 4) + '...'
          });

          // NUCLEAR CLEANER: Remove all forms of thinking tags and reasoning leaks
          let cleaned = reply
            .replace(/<[^>]*?think[^>]*?>[\s\S]*?<\/[^>]*?think[^>]*?>/gi, '') // Advanced tag strip
            .replace(/<[^>]*?think[^>]*?>[\s\S]*/gi, '')                      // Unclosed tag strip
            .replace(/<\/?[^>]*?think[^>]*?>/gi, '')                         // Stray tag strip
            .replace(/\(Thinking:[\s\S]*?\)/gi, '')
            .replace(/^Okay, (let me|let's) (think|see|analyze)[\s\S]*?(\n\n|\.\s+|$)/i, '')
            .replace(/^Thinking Process:[\s\S]*?(\n\n|$)/gi, '');

          const finalResult = cleaned.trim();
          console.log(`[CLEANER] Raw: ${reply.substring(0, 50)}... | Final: ${finalResult.substring(0, 50)}...`);

          // If after cleaning we have nothing, this model only gave us thoughts. TRY NEXT MODEL.
          if (!finalResult || finalResult.length < 2) {
            console.warn(`[GROQ] Model ${currentModel} purely internal. Skipping...`);
            continue;
          }

          return finalResult;
        }
      } catch (err) {
        const isRateLimit = err.response && (err.response.status === 429 || err.response.data?.error?.code === 'rate_limit_exceeded');
        if (isRateLimit) {
          console.warn(`[GROQ] Model ${currentModel} rate limited. Trying next...`);
          continue;
        } else {
          console.error(`[GROQ] Error with model ${currentModel}:`, err.message);
          continue;
        }
      }
    }

    // No non-AI fallback: if Groq fails completely, return empty and skip replying.
    return '';
  }

  /**
   * Summarize channel history to keep memory compact and "learn" things
   */
  async function updateChannelSummary(channelId) {
    try {
      // 1. Fetch existing channel memory
      const existingRes = await pool.query('SELECT summary FROM channel_memory WHERE channel_id = $1', [channelId]);
      const oldSummary = existingRes.rows.length > 0 ? existingRes.rows[0].summary : 'Wala pa tayong nasisimulang chika dito.';

      // 2. Fetch recent messages
      const res = await pool.query(
        'SELECT author_id, author_tag, content FROM messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 60',
        [channelId]
      );
      if (res.rows.length < 10) return;

      const history = res.rows.reverse().map(r => `[ID:${r.author_id}] ${r.author_tag}: ${r.content}`).join('\n');
      const summaryPrompt =
        `Ghorl, itong usapan sa channel, aralin mo nang malala para hindi ka magmukhang shunga sa susunod.\n\n` +
        `Eto yung dating chika (Old Memory):\n${oldSummary}\n\n` +
        `Eto naman yung mga bagong chika ngayon (New History):\n${history}\n\n` +
        `Gawan mo ng dalawang bagay:\n` +
        `1. UPDATED CHANNEL SUMMARY (brief paragraph of what happened recently + combined previous summary).\n` +
        `2. USER-SPECIFIC FACTS (extract special facts per user ID, ex: "USER_ID: facts..."). Isama ang personality o mga preferrence nila.\n\n` +
        `Format your response as:\n` +
        `CHANNEL_SUMMARY: (summary text)\n` +
        `USER_FACTS: (ID: facts... ID: facts...)`;

      const response = await performChatRequest({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'You must know everything even the summary of the chat history and that is your role as a gay human persona friend.' },
          { role: 'user', content: summaryPrompt }
        ],
        temperature: 0.6
      });

      const aiResult = response.data.choices[0].message.content.trim();

      // Parse AI response
      const summaryMatch = aiResult.match(/CHANNEL_SUMMARY:\s*([\s\S]*?)(?=USER_FACTS:|$)/i);
      const userFactsMatch = aiResult.match(/USER_FACTS:\s*([\s\S]*)/i);

      if (summaryMatch) {
        const newSummary = summaryMatch[1].trim();
        await pool.query(
          'INSERT INTO channel_memory (channel_id, summary, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ' +
          'ON CONFLICT (channel_id) DO UPDATE SET summary = $2, updated_at = CURRENT_TIMESTAMP',
          [channelId, newSummary]
        );
      }

      if (userFactsMatch) {
        const factsText = userFactsMatch[1].trim();
        const userFactLines = factsText.split('\n');
        for (const line of userFactLines) {
          const match = line.match(/(\d+):\s*(.*)/);
          if (match) {
            const userId = match[1];
            const fact = match[2];
            // Cumulative user update
            const oldUserRes = await pool.query('SELECT facts FROM user_memory WHERE user_id = $1', [userId]);
            const oldFacts = oldUserRes.rows.length > 0 ? oldUserRes.rows[0].facts : '';
            const combinedFacts = oldFacts ? `${oldFacts} | ${fact}` : fact;

            await pool.query(
              'INSERT INTO user_memory (user_id, facts, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ' +
              'ON CONFLICT (user_id) DO UPDATE SET facts = $2, updated_at = CURRENT_TIMESTAMP',
              [userId, combinedFacts]
            );
          }
        }
      }

      console.log(`[DB] Learning complete for channel ${channelId}`);
    } catch (err) {
      console.error('[DB] updateChannelSummary/Learning error:', err.message);
    }
  }

  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;

      function pickPersonaReactionEmoji(text) {
        const t = (text || '').toLowerCase();
        // Greetings / check-ins
        if (/(^|\b)(hi|hello|hey|kumusta|kamusta|musta|good morning|good afternoon|good evening)(\b|$)/i.test(t)) {
          return '\u{2764}\u{FE0F}'; // ❤️
        }
        if (/[!?]{2,}/.test(t)) return '\u{1F92F}'; // 🤯
        if (t.includes('haha') || t.includes('hehe') || t.includes('lol') || t.includes('lmao')) return '\u{1F602}'; // 😂
        if (t.includes('sad') || t.includes('iyak') || t.includes('cry') || t.includes('lungkot')) return '\u{1F622}'; // 😢
        if (t.includes('gago') || t.includes('tanga') || t.includes('bwisit') || t.includes('putangina')) return '\u{1F624}'; // 😤
        if (t.includes('?') || t.includes('ano') || t.includes('bakit') || t.includes('paano')) return '\u{1F928}'; // 🤨
        if (t.includes('slay') || t.includes('werk') || t.includes('bongga') || t.includes('pak na pak')) return '\u{2728}'; // ✨
        return '\u{2764}\u{FE0F}'; // ❤️
      }

      async function maybeReactPersona(message, text, intensity = 0.25) {
        if (!message?.react) return;
        if (!text || text.startsWith('j!')) return;
        if (Math.random() > intensity) return;
        const emoji = pickPersonaReactionEmoji(text);
        await message.react(emoji).catch(() => { });
      }

      // (extractAndStoreUserFacts is defined globally)

      function keepChikaEmojisLight(text) {
        // Keep chat replies basically emoji-free.
        // Only ~2% chance to append ONE chika-relevant emoji.
        const raw = (text || '').trim();
        if (!raw) return raw;

        // Strip ALL pictographic emojis from model output
        let cleaned = raw.replace(/[\p{Extended_Pictographic}]/gu, '');
        cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

        if (Math.random() >= 0.02) return cleaned;

        const lower = cleaned.toLowerCase();
        let addon = '❤️';
        if (/(haha|hehe|lol|lmao|tawa|wa(h)+)/i.test(lower)) addon = '😂';
        else if (/[!?]{2,}/.test(cleaned)) addon = '🤯';
        else if (/\?/.test(cleaned)) addon = '🤨';
        else if (/(sad|iyak|cry|lungkot)/i.test(lower)) addon = '😢';
        else if (/(slay|werk|bongga|pak na pak)/i.test(lower)) addon = '✨';
        else if (/(inis|bwisit|galit|as in)/i.test(lower)) addon = '😤';
        else if (/(hi|hello|hey|kumusta|kamusta|musta)/i.test(lower)) addon = '❤️';

        return `${cleaned} ${addon}`.trim();
      }

      // Save message to DB regardless of AI trigger
      try {
        const displayAuthor =
          message.member?.displayName ||
          message.author.globalName ||
          message.author.username ||
          message.author.tag;
        await pool.query(
          'INSERT INTO messages (guild_id, channel_id, author_id, author_tag, content) VALUES ($1, $2, $3, $4, $5)',
          [
            message.guild?.id || 'DM',
            message.channel.id,
            message.author.id,
            displayAuthor,
            message.content || ''
          ]
        );

        // Auto trigger summary every 20 messages in that channel
        const countRes = await pool.query('SELECT COUNT(*) FROM messages WHERE channel_id = $1', [message.channel.id]);
        const msgCount = parseInt(countRes.rows[0].count);
        if (msgCount % 20 === 0) {
          updateChannelSummary(message.channel.id);
        }
      } catch (dbErr) {
        console.error('[DB] Message save error:', dbErr.message);
      }

      const me = client.user;
      if (!me) return;

      const rawContent = message.content || '';
      const prefix = 'j!';

      if (rawContent.startsWith(prefix)) {
        const args = rawContent.slice(prefix.length).trim().split(/\s+/);
        const command = (args.shift() || '').toLowerCase();

        // j!status
        if (command === 'status') {
          if (!message.guild) {
            await message.reply('Ghorl, yung status na yan pang-server lang, hindi pang-DM.');
            return;
          }
          const member = message.member;
          if (!member || !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await message.reply('Admins lang ang pwedeng mag-set ng bubble status dito, ghorl.');
            return;
          }
          const note = args.join(' ').trim();
          if (!note) {
            await message.reply('Lagyan mo ng laman yung status mo, mare. Halimbawa: j!status CEO ng chismis');
            return;
          }
          const key = `${message.guild.id}:${member.id}`;
          userCustomStatus.set(key, note);
          await setBotCustomStatus(note);
          await message.reply(`Sige, bubble status natin ngayon: ${note}. Updated na.`);
          return;
        }

        // j!join
        if (command === 'join') {
          if (!message.guild) {
            await message.reply('Kailangan nasa server ka para pwede ako sumali sa voice channel.');
            return;
          }

          let member;
          try {
            member = await message.guild.members.fetch(message.author.id);
          } catch {
            member = message.member;
          }

          const voiceChannel = member && member.voice && member.voice.channel
            ? member.voice.channel
            : null;

          if (!voiceChannel) {
            await message.reply('Sumali ka muna sa isang voice channel, tapos tawagin mo ko ulit, ghorl.');
            return;
          }

          const existing = getVoiceConnection(message.guild.id);
          if (existing) {
            if (existing.joinConfig.channelId === voiceChannel.id) {
              await message.reply('Nasa call na kita ghorl, nandito na ako.');
              return;
            } else {
              try { existing.destroy(); } catch { }
            }
          }

          setSavedVoiceState({ channelId: voiceChannel.id, guildId: voiceChannel.guild.id });
          // Save to DB for 24/7 persistence across restarts
          await saveVoiceStateToDB(voiceChannel.guild.id, voiceChannel.id);
          voiceReconnectAttempts = 0;
          joinAndWatch(voiceChannel.id, voiceChannel.guild.id, voiceChannel.guild.voiceAdapterCreator);

          await message.reply(`O ayan, pumasok na ako sa ${voiceChannel.name}. Nandito na ako, ghorl.`);
          return;
        }

        // j!leave
        if (command === 'leave') {
          if (!message.guild) {
            await message.reply('Wala naman tayong server dito, ghorl.');
            return;
          }
          const connection = getVoiceConnection(message.guild.id);
          if (!connection) {
            await message.reply('Wala naman ako sa kahit anong voice channel ngayon, mare.');
            return;
          }
          setSavedVoiceState(null);
          clearScheduledVoiceRejoin();
          // Clear from DB so bot doesn't auto-rejoin on restart
          await clearVoiceStateFromDB();
          connection.destroy();
          await message.reply('Umalis na ako sa voice channel. Tawagin mo ulit kapag kailangan mo ko.');
          return;
        }

        // j!vc <message> â€” Text-to-speech in voice channel
        if (command === 'vc' || command === 'speak' || command === 'tts') {
          if (!message.guild) return;
          const text = args.join(' ').trim();
          if (!text) {
            await message.reply('Loka, ano namang sasabihin ko? Bigyan mo ko ng text.');
            return;
          }

          const member = message.member;
          if (!member || !member.voice.channel) {
            await message.reply('Sumali ka muna sa voice bago mo ko pagalitain, mare!');
            return;
          }

          // Join if needed
          const connection = getVoiceConnection(message.guild.id);
          if (!connection) {
            joinAndWatch(member.voice.channel.id, message.guild.id, message.guild.voiceAdapterCreator);
          }

          await speakMessage(message.guild.id, text, message.author.id);
          await message.react('ðŸ”Š').catch(() => { });
          return;
        }

        // j!autotts â€” Toggle auto tts in current channel
        if (command === 'autotts') {
          if (!message.guild || !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return message.reply('Admins lang ang bida-bida dito, ghorl.');
          }

          const guildId = message.guild.id;
          const channelId = message.channel.id;

          if (!autoTtsChannels.has(guildId)) autoTtsChannels.set(guildId, new Set());
          const channels = autoTtsChannels.get(guildId);

          if (channels.has(channelId)) {
            channels.delete(channelId);
            await message.reply('AUTO TTS DISABLED na para sa channel na to, sis.');
          } else {
            channels.add(channelId);
            await message.reply('AUTO TTS ENABLED! Bawat chat niyo dito, babasahin ko (kung nasa voice ako).');
          }
          return;
        }

        // j!voice / j!change <m/f> â€” Set voice (same as gnslgbot2's g!change m/f)
        // After changing: speaks "Voice changed to X. This is how I sound now!" with new voice
        if (command === 'voice' || command === 'change') {
          const type = args[0]?.toLowerCase();

          let genderName = null;
          if (type === 'm' || type === 'male' || type === 'angelo') {
            userVoicePrefs.set(message.author.id, 'm');
            genderName = 'male';
          } else if (type === 'f' || type === 'female' || type === 'blessica') {
            userVoicePrefs.set(message.author.id, 'f');
            genderName = 'female';
          } else {
            await message.reply('Gamitin: `j!change m` (Angelo) o `j!change f` (Blessica).');
            return;
          }

          await message.reply(`VOICE CHANGED TO ${genderName.toUpperCase()}.`);

          // Speak sample with the NEW voice â€” beki style, same as gnslgbot2
          if (message.guild) {
            let conn = getVoiceConnection(message.guild.id);
            if (!conn && message.member?.voice?.channel) {
              joinAndWatch(message.member.voice.channel.id, message.guild.id, message.guild.voiceAdapterCreator);
              await new Promise(r => setTimeout(r, 1000));
            }
            if (getVoiceConnection(message.guild.id)) {
              const sample = genderName === 'male'
                ? `Ito na ang bagong boses ko, ghorl! Macho na macho na! Ayan, lalaki na boses ko! Slay!`
                : `Ito na ang bagong boses ko, ghorl! Dyosa energy na! Blessica vibes, charot!`;
              speakMessage(message.guild.id, sample, message.author.id);
            }
          }
          return;
        }

        // j!ask â€” EXACT same as gnslgbot2's g!ask:
        //   j!ask <question>  â†’ text â†’ AI â†’ TTS response
        //   j!ask (no args)   â†’ start STT voice listening mode (same as g!ask / g!listen)
        if (command === 'ask') {
          if (!message.guild) return;

          const member = message.member;
          if (!member || !member.voice.channel) {
            await message.reply('Sumali ka muna sa voice channel, ghorl.');
            return;
          }

          // Ensure bot is in voice
          let conn = getVoiceConnection(message.guild.id);
          if (!conn) {
            joinAndWatch(member.voice.channel.id, message.guild.id, message.guild.voiceAdapterCreator);
            await new Promise(r => setTimeout(r, 1500));
            conn = getVoiceConnection(message.guild.id);
          }
          if (!conn) { await message.reply('Hindi makaconnect sa voice, mare. Try ulit.'); return; }

          const question = args.join(' ').trim();

          if (question) {
            // === MODE 1: j!ask <question> â†’ text â†’ AI â†’ speak ===
            await message.channel.sendTyping();
            let voiceMembers = [];
            const myVC = message.guild.members.me.voice.channel;
            if (myVC) voiceMembers = myVC.members.filter(m => !m.user.bot).map(m => m.displayName || m.user.username);
            const aiResponse = await callGroqChat(question, message.author.id, message.channel.id, voiceMembers);
            await speakMessage(message.guild.id, aiResponse, message.author.id);
            await message.react('ðŸ¤–').catch(() => { });
          } else {
            // === MODE 2: j!ask (no args) â†’ start STT listening mode ===
            // Exactly like gnslgbot2's g!ask without args
            if (activeVoiceUsers.has(message.guild.id) && activeVoiceUsers.get(message.guild.id) !== message.author.id) {
              await message.reply('May nagpaparinig na ngayon! Hintayin mo muna mag-`j!stop`, sis.');
              return;
            }
            listeningGuilds.add(message.guild.id);
            activeVoiceUsers.set(message.guild.id, message.author.id);
            const memberNames = member.voice.channel.members.filter(m => !m.user.bot).map(m => m.displayName || m.user.username);
            await message.reply(`GAME NA! Listening ako sa "${member.voice.channel.name}". Magsalita ka ${memberNames.join(', ') || ''}! Mag-\`j!stop\` para tumigil.`);
            speakMessage(message.guild.id, 'Handa na ako, magsalita ka!', message.author.id);
            startVoiceListening(message.guild.id, message.author.id, message.channel);
          }
          return;
        }

        // j!listen â€” alias for j!ask (no args) â€” same as gnslgbot2's g!listen
        if (command === 'listen' || command === 'makinig') {
          if (!message.guild) return;
          const member = message.member;
          if (!member || !member.voice.channel) {
            await message.reply('Sumali ka muna sa voice channel para makinig ako, ghorl.');
            return;
          }
          if (activeVoiceUsers.has(message.guild.id) && activeVoiceUsers.get(message.guild.id) !== message.author.id) {
            await message.reply('May nagpaparinig na ngayon! Hintayin mo muna mag-`j!stop`, sis.');
            return;
          }
          let conn = getVoiceConnection(message.guild.id);
          if (!conn) {
            joinAndWatch(member.voice.channel.id, message.guild.id, message.guild.voiceAdapterCreator);
            await new Promise(r => setTimeout(r, 1500));
            conn = getVoiceConnection(message.guild.id);
          }
          if (!conn) { await message.reply('Hindi makaconnect sa voice, mare. Try ulit.'); return; }

          listeningGuilds.add(message.guild.id);
          activeVoiceUsers.set(message.guild.id, message.author.id);
          const memberNames = member.voice.channel.members.filter(m => !m.user.bot).map(m => m.displayName || m.user.username);
          await message.reply(`NAKIKINIG NA AKO. Magsalita ka ${memberNames.join(', ') || ''}! Mag-\`j!stop\` para tumigil.`);
          speakMessage(message.guild.id, 'Handa na ako, magsalita ka!', message.author.id);
          startVoiceListening(message.guild.id, message.author.id, message.channel);
          return;
        }

        // j!stop / j!stoplisten â€” Stop voice listening (same as gnslgbot2's g!stoplisten)
        if (command === 'stop' || command === 'stoplisten' || command === 'tigil') {
          if (!message.guild) return;
          if (!listeningGuilds.has(message.guild.id)) {
            await message.reply('Hindi naman ako nakikinig ng voice ngayon, ghorl.');
            return;
          }
          listeningGuilds.delete(message.guild.id);
          activeVoiceUsers.delete(message.guild.id);
          // Call cleanup to remove speaking event listener
          const cleanup = listeningCleanup.get(message.guild.id);
          if (cleanup) { cleanup(); listeningCleanup.delete(message.guild.id); }
          await message.reply('TUMIGIL NA AKO. Naupong na ang tenga ko, mare.');
          return;
        }
        // j!view @user â€” View user's main profile + server profile
        if (command === 'view' || command === 'profile') {
          if (!message.guild) return;

          const target = message.mentions.users.first() || (args[0] ? await client.users.fetch(args[0]).catch(() => null) : message.author);
          if (!target) { await message.reply('Sino ba yun? Mention o ID mo, ghorl.'); return; }

          // Force fetch for banner
          const fullUser = await client.users.fetch(target.id, { force: true });
          const member = await message.guild.members.fetch(target.id).catch(() => null);

          const cardName = member?.displayName || fullUser.globalName || fullUser.username || fullUser.tag;
          const complimentWord = await inferComplimentWord(fullUser.id, cardName);
          const mainAvatar = fullUser.displayAvatarURL({ size: 4096, dynamic: true });
          const banner = fullUser.bannerURL({ size: 4096, dynamic: true });
          const accentColor = fullUser.hexAccentColor || '#5865F2';
          const greetingPool = [
            `Ayan na si **${cardName}**. Ang **${complimentWord}** naman neto, teh.`,
            `Profile scan kay **${cardName}**. Main character ang atake.`,
            `Hoy tingnan niyo si **${cardName}**. May dating, hindi tinipid.`
          ];
          const profileGreeting = greetingPool[Math.floor(Math.random() * greetingPool.length)];

          const embed = new EmbedBuilder()
            .setColor(accentColor)
            .setAuthor({ name: 'JANJAN PROFILE SCAN', iconURL: message.client.user.displayAvatarURL() })
            .setTitle(`* ${cardName} *`)
            .setDescription(`**${profileGreeting}**`)
            .setImage(mainAvatar)
            .addFields(
              { name: 'Handle', value: `\`${fullUser.tag}\``, inline: true },
              { name: 'Vibe', value: `**${complimentWord.toUpperCase()}**`, inline: true },
              { name: 'Bot?', value: fullUser.bot ? 'Oo' : 'Hindi', inline: true },
              { name: 'User ID', value: `\`${fullUser.id}\``, inline: false },
              { name: 'Account Created', value: `<t:${Math.floor(fullUser.createdTimestamp / 1000)}:F>\n(<t:${Math.floor(fullUser.createdTimestamp / 1000)}:R>)`, inline: false },
            );

          if (banner) {
            embed.addFields({ name: 'Banner', value: `[Open HD](${banner})`, inline: true });
          }

          // Server profile
          if (member) {
            const serverAvatar = member.displayAvatarURL({ size: 4096, dynamic: true });
            const roles = member.roles.cache
              .filter(r => r.id !== message.guild.id)
              .sort((a, b) => b.position - a.position)
              .map(r => `${r}`)
              .slice(0, 15)
              .join(', ') || 'Wala';
            const nickname = member.nickname || 'Wala';
            const joinedTs = Math.floor(member.joinedTimestamp / 1000);
            const boosting = member.premiumSince ? `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:R>` : 'Hindi nag-boost';

            embed.addFields(
              { name: '-------- SERVER PROFILE --------', value: '\u200B', inline: false },
              { name: 'Nickname', value: nickname, inline: true },
              { name: 'Joined Server', value: `<t:${joinedTs}:F>\n(<t:${joinedTs}:R>)`, inline: true },
              { name: 'Boosting', value: boosting, inline: true },
              { name: `Roles (${member.roles.cache.size - 1})`, value: roles, inline: false },
            );

            // If server avatar is different from main avatar, show it
            if (serverAvatar !== mainAvatar) {
              embed.setThumbnail(serverAvatar);
              embed.addFields({ name: 'Server Avatar', value: `[Open HD](${serverAvatar})`, inline: true });
              embed.addFields({ name: 'Main Avatar', value: `[Open HD](${mainAvatar})`, inline: true });
            }
          }

          embed.setFooter({ text: `Requested by ${message.author.tag} • j!view`, iconURL: message.author.displayAvatarURL() });
          embed.setTimestamp();

          const viewButtons = [
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Avatar HD').setURL(mainAvatar)
          ];
          if (banner) {
            viewButtons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Banner HD').setURL(banner));
          }

          const viewRow = new ActionRowBuilder().addComponents(...viewButtons);
          await message.reply({ embeds: [embed], components: [viewRow] });
          return;
        }

        // j!chat â€” owner only. Mirrors g!g from gnslgbot2.
        // j!chat <channel_id or message_id> <text>
        if (command === 'chat') {
          const OWNERS = ['1477683173520572568', '705770837399306332'];
          const originChannel = message.channel;
          const originGuild = message.guild;
          const authorUser = message.author;

          // Verify owner ID or Administrator perm
          const isOwner = OWNERS.includes(message.author.id);
          const isAdmin = message.member && message.member.permissions.has(PermissionsBitField.Flags.Administrator);

          if (!isOwner && !isAdmin) return; // Silent ignore for non-admins

          const targetId = args.shift();
          const customMessage = args.join(' ').trim();

          // Delete the command message for stealth
          await message.delete().catch(() => { });

          if (!targetId || !customMessage) {
            try {
              await authorUser.send(`j!chat: Kulang ang info, beshie! Format: j!chat <id> <message>\nID na binigay mo: ${targetId || 'wala'}\nMessage: ${customMessage || 'wala'}`);
            } catch { }
            return;
          }

          // 1. Try as a channel ID
          let targetChannel = client.channels.cache.get(targetId) || null;
          if (targetChannel && !targetChannel.isTextBased()) targetChannel = null;

          if (!targetChannel) {
            try {
              const fetched = await client.channels.fetch(targetId).catch(() => null);
              if (fetched && fetched.isTextBased()) targetChannel = fetched;
            } catch { }
          }

          if (targetChannel) {
            try {
              await targetChannel.send(customMessage);
              await authorUser.send(`Sent to #${targetChannel.name} in ${targetChannel.guild?.name || 'DM'}.`);
            } catch (e) {
              try { await authorUser.send(`Failed to send: ${e.message}`); } catch { }
            }
            return;
          }

          // 2. Try as a message ID (reply mode)
          let targetMessage = null;
          try { targetMessage = await originChannel.messages.fetch(targetId).catch(() => null); } catch { }

          if (!targetMessage && originGuild) {
            // If not in current channel, try cached channels in the same guild
            for (const ch of originGuild.channels.cache.values()) {
              if (!ch.isTextBased() || targetMessage) continue;
              try {
                targetMessage = await ch.messages.fetch(targetId).catch(() => null);
              } catch { }
            }
          }

          if (targetMessage) {
            try {
              await targetMessage.reply(customMessage);
              await authorUser.send(`Replied in #${targetMessage.channel.name}.`);
            } catch (e) {
              try { await authorUser.send(`Failed to reply: ${e.message}`); } catch { }
            }
            return;
          }

          // 3. Fallback: ID not found
          try {
            await authorUser.send(`j!chat failed. Wala akong makitang channel o message sa ID: ${targetId}`);
          } catch { }
          return;
        }

        // j!whoami â€” Verify user ID for permissions
        if (command === 'whoami' || command === 'myid') {
          const owners = ['1477683173520572568', '705770837399306332'];
          const isOwner = owners.includes(message.author.id);
          const idEmbed = new EmbedBuilder()
            .setTitle('Identity Check')
            .setDescription(`Your ID: \`${message.author.id}\`\n\nChecking permissions...\n${isOwner ? 'You are an **Authorized Owner**.' : 'You are not in the owner whitelist.'}`)
            .setColor(isOwner ? 0x00ff00 : 0xff0000);
          await message.reply({ embeds: [idEmbed] });
          return;
        }

        // j!ping â€” Bot status check
        if (command === 'ping') {
          await message.reply(`Pong! Latency is ${Math.round(client.ws.ping)}ms.`);
          return;
        }

        // j!tulog — Admin-only sleep toggle (pauses auto-epal/auto-interact in this server)
        if (command === 'tulog' || command === 'sleep') {
          if (!message.guild) {
            await message.reply('Teh, tulog mode pang-server lang.');
            return;
          }
          const isAdmin = message.member && message.member.permissions.has(PermissionsBitField.Flags.Administrator);
          if (!isAdmin) {
            await message.reply('Admins lang pwede magpatulog sakin, ghorl.');
            return;
          }

          const guildId = message.guild.id;
          const action = (args[0] || '').toLowerCase();
          const wantsOn = action === 'on' || action === 'true' || action === '1' || action === 'enable';
          const wantsOff = action === 'off' || action === 'false' || action === '0' || action === 'disable';

          if (wantsOn) sleepGuilds.add(guildId);
          else if (wantsOff) sleepGuilds.delete(guildId);
          else {
            // toggle
            if (sleepGuilds.has(guildId)) sleepGuilds.delete(guildId);
            else sleepGuilds.add(guildId);
          }

          const isSleeping = sleepGuilds.has(guildId);
          await message.reply(
            isSleeping
              ? 'Sige, tulog mode ON. Di muna ako sasabat sa random chats (pero pag minention/reply niyo ko, gising ako).'
              : 'Tulog mode OFF. Sige, pwede na ulit ako maging epal minsan.'
          );
          return;
        }

        // j!research on/off — Admin-only toggle for web research + Sources
        if (command === 'research' || command === 'sources') {
          if (!message.guild) {
            await message.reply('Teh, pang-server lang to.');
            return;
          }
          const isAdmin = message.member && message.member.permissions.has(PermissionsBitField.Flags.Administrator);
          if (!isAdmin) {
            await message.reply('Admins lang pwede mag toggle ng research, ghorl.');
            return;
          }

          const action = (args[0] || '').toLowerCase();
          if (action === 'on' || action === 'enable' || action === 'true' || action === '1') {
            researchEnabledGuilds.add(message.guild.id);
          } else if (action === 'off' || action === 'disable' || action === 'false' || action === '0') {
            researchEnabledGuilds.delete(message.guild.id);
          } else {
            // toggle if no arg/unknown
            if (researchEnabledGuilds.has(message.guild.id)) researchEnabledGuilds.delete(message.guild.id);
            else researchEnabledGuilds.add(message.guild.id);
          }

          const enabled = researchEnabledGuilds.has(message.guild.id);
          await message.reply(
            enabled
              ? 'Sige, research ON. Magso-sources lang ako pag minention/reply mo ko at research/latest yung tanong.'
              : 'Research OFF. Wala munang sources kahit anong mangyari.'
          );
          return;
        }

        // j!permcheck — Admin-only permission diagnostics for current channel
        if (command === 'permcheck') {
          if (!message.guild) {
            await message.reply('Teh, pang-server lang to. Walang perms-perms sa DM.');
            return;
          }
          const isAdmin = message.member && message.member.permissions.has(PermissionsBitField.Flags.Administrator);
          if (!isAdmin) {
            await message.reply('Admins lang pwede mag-permcheck dito, ghorl.');
            return;
          }

          const ch = message.channel;
          const missing = getMissingTextPermsForChannel(ch);
          const ok = missing.length === 0 || missing[0] === 'unknown-channel';
          const base =
            `Channel: <#${ch.id}>\n` +
            `Bot: ${client.user.tag}\n` +
            `Result: ${ok ? 'OK' : 'MISSING'}`;

          if (ok) {
            await message.reply(`${base}\nPerms: OK na. Kung di pa rin siya nakaka-backread, check Developer Portal > Message Content Intent.`);
          } else {
            await message.reply(
              `${base}\nMissing: ${missing.join(', ')}\n` +
              `Ayusin sa channel overrides/role perms. Also: Developer Portal > Message Content Intent must be ON.`
            );
          }
          return;
        }

        // j!usersummary @user — summarize a person from DB (facts + recent messages)
        if (command === 'usersummary' || command === 'usersum' || command === 'summaryuser') {
          if (!message.guild) {
            await message.reply('Teh, sa server lang to. Mention mo yung tao dito.');
            return;
          }

          const targetUser =
            message.mentions.users.first() ||
            (args[0] ? await client.users.fetch(args[0]).catch(() => null) : null);

          if (!targetUser) {
            await message.reply('Sino yun? Mention mo: `j!usersummary @user`');
            return;
          }

          // Pull stored facts + recent messages authored by the target across the SERVER
          let facts = '';
          let recentLines = [];
          try {
            const factsRes = await pool.query('SELECT facts FROM user_memory WHERE user_id = $1', [targetUser.id]);
            facts = factsRes.rows?.[0]?.facts || '';
          } catch { }
          try {
            const msgRes = message.guild
              ? await pool.query(
                  'SELECT channel_id, author_tag, content, created_at FROM messages WHERE guild_id = $1 AND author_id = $2 ORDER BY created_at DESC LIMIT 35',
                  [message.guild.id, targetUser.id]
                )
              : await pool.query(
                  'SELECT channel_id, author_tag, content, created_at FROM messages WHERE channel_id = $1 AND author_id = $2 ORDER BY created_at DESC LIMIT 35',
                  [message.channel.id, targetUser.id]
                );
            recentLines = (msgRes.rows || [])
              .reverse()
              .map((r) => {
                const ts = r.created_at ? new Date(r.created_at).toISOString() : 'unknown-time';
                const who = r.author_tag || (targetUser.globalName || targetUser.username || 'someone');
                const msg = (r.content || '').replace(/\s+/g, ' ').trim();
                if (!msg) return null;
                const where = r.channel_id ? ` (ch:${r.channel_id})` : '';
                return `[${ts}] ${who}${where}: ${msg}`;
              })
              .filter(Boolean);
          } catch { }

          const displayName =
            message.guild.members.cache.get(targetUser.id)?.displayName ||
            targetUser.globalName ||
            targetUser.username ||
            targetUser.tag;

          const prompt =
            `Summarize this person based ONLY on stored DB info below. ` +
            `Do not output raw Discord IDs. Use nickname/name only. ` +
            `Output: (1) 5-8 bullets: personality/vibe/typical topics, (2) 1 short paragraph "how to talk to them", (3) any notable facts with uncertainty labels if weak. ` +
            `If DB info is thin, say "kulang pa info" and list what you do know.\n\n` +
            `[TARGET]: ${displayName}\n` +
            `[USER FACTS FROM DB]: ${facts || '(none)'}\n` +
            `[RECENT MESSAGES FROM THIS CHANNEL]:\n${recentLines.join('\n') || '(none)'}\n`;

          await message.channel.sendTyping();
          const voiceMembers = [];
          const discordContext = await buildDiscordAwarenessContext(message, false);
          const mentionContext = buildMentionContext(message);
          const summary = await callGroqChat(prompt, message.author.id, message.channel.id, voiceMembers, {
            fastMode: false,
            researchContext: [],
            discordContext,
            mentionContext,
            forceResearchGrounding: false,
            forceSexualGuard: false
          });

          await message.reply(summary || 'Teh, wala akong ma-summarize. Kulang pa DB info.');
          return;
        }

        // j!checkdb — Admin-only DB storage usage report (Neon/Postgres)
        if (command === 'checkdb' || command === 'dbsize' || command === 'storage') {
          if (!message.guild) {
            await message.reply('Teh, pang-server lang to.');
            return;
          }
          const isAdmin = message.member && message.member.permissions.has(PermissionsBitField.Flags.Administrator);
          if (!isAdmin) {
            await message.reply('Admins lang pwede mag-checkdb dito, ghorl.');
            return;
          }

          await message.channel.sendTyping();
          try {
            const dbSizeRes = await pool.query('SELECT pg_database_size(current_database())::bigint AS bytes');
            const dbBytes = Number(dbSizeRes.rows?.[0]?.bytes || 0);
            const dbGb = dbBytes / (1024 ** 3);

            const tableRes = await pool.query(`
              SELECT 'messages' AS t,
                     pg_total_relation_size('messages'::regclass)::bigint AS bytes,
                     (SELECT COUNT(*) FROM messages)::bigint AS rows
              UNION ALL
              SELECT 'channel_memory' AS t,
                     pg_total_relation_size('channel_memory'::regclass)::bigint AS bytes,
                     (SELECT COUNT(*) FROM channel_memory)::bigint AS rows
              UNION ALL
              SELECT 'user_memory' AS t,
                     pg_total_relation_size('user_memory'::regclass)::bigint AS bytes,
                     (SELECT COUNT(*) FROM user_memory)::bigint AS rows
              UNION ALL
              SELECT 'persona' AS t,
                     pg_total_relation_size('persona'::regclass)::bigint AS bytes,
                     (SELECT COUNT(*) FROM persona)::bigint AS rows
            `);

            const tableInfo = (tableRes.rows || []).map((r) => ({
              t: r.t,
              bytes: Number(r.bytes || 0),
              rows: String(r.rows || 0)
            }));

            tableInfo.sort((a, b) => b.bytes - a.bytes);
            const lines = tableInfo.map((x) => {
              const gb = (x.bytes / (1024 ** 3)).toFixed(3);
              return `- ${x.t}: ${gb} GB | rows: ${x.rows}`;
            });

            const header =
              `DB storage (approx): ${(dbGb).toFixed(3)} GB\n` +
              `DB bytes: ${dbBytes}\n`;

            await message.reply(`${header}\nTop tables:\n${lines.join('\n')}\n\nTip: kung lumalaki masyado ang \`messages\`, mag-rotate/cleanup tayo.`);
          } catch (e) {
            await message.reply(`Teh, di ko ma-check DB size ngayon. Error: ${e.message}`);
          }
          return;
        }

        // j!img — generate an image via Leonardo
        // Usage: j!img <prompt>
        if (command === 'img' || command === 'image' || command === 'pic' || command === 'picture') {
          const prompt = args.join(' ').trim();
          if (!prompt) {
            await message.reply('Format: `j!img <prompt>`');
            return;
          }
          if (!LEONARDO_API_KEY) {
            await message.reply('Teh, wala pang `LEONARDO_API_KEY` sa .env. Lagay mo muna.');
            return;
          }

          try {
            await leonardoGenerateAndSend({ channel: message.channel, replyToMessage: message, prompt });
          } catch (e) {
            await message.reply(`Teh, di ko magawa yung pic ngayon. ${e.message}`);
          }
          return;
        }

        // j!portray / j!portrait — portray a Discord user as an image (Groq drafts prompt, Leonardo renders)
        // Usage: j!portray @user <optional style notes>
        if (command === 'portray' || command === 'portrait') {
          if (!LEONARDO_API_KEY) {
            await message.reply('Teh, wala pang `LEONARDO_API_KEY` sa .env. Lagay mo muna.');
            return;
          }
          if (!message.guild) {
            await message.reply('Teh, pang-server lang to. Mention mo yung tao.');
            return;
          }
          const targetUser = message.mentions.users.first() || null;
          const extra = args.filter((a) => !a.startsWith('<@')).join(' ').trim();
          if (!targetUser) {
            await message.reply('Format: `j!portray @user <style notes>`');
            return;
          }

          const displayName =
            message.guild.members.cache.get(targetUser.id)?.displayName ||
            targetUser.globalName ||
            targetUser.username ||
            targetUser.tag;

          let facts = '';
          try {
            const factsRes = await pool.query('SELECT facts FROM user_memory WHERE user_id = $1', [targetUser.id]);
            facts = factsRes.rows?.[0]?.facts || '';
          } catch { }

          let recentMsgs = '';
          try {
            const msgRes = await pool.query(
              'SELECT content FROM messages WHERE guild_id = $1 AND author_id = $2 ORDER BY created_at DESC LIMIT 12',
              [message.guild.id, targetUser.id]
            );
            recentMsgs = (msgRes.rows || [])
              .map((r) => String(r.content || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
              .slice(0, 12)
              .join(' | ');
          } catch { }

          await message.channel.sendTyping();
          try {
            const promptDraftRes = await performChatRequest({
              model: 'llama-3.1-8b-instant',
              messages: [
                {
                  role: 'system',
                  content:
                    'You are crafting an image prompt for Leonardo.ai. Output ONLY the prompt text, no labels. ' +
                    'Make it vivid but safe. No raw Discord IDs. No sexual content. ' +
                    'Prefer photoreal unless user asked otherwise. Keep under 280 chars.'
                },
                {
                  role: 'user',
                  content:
                    `Portray this person as an image.\n` +
                    `Name: ${displayName}\n` +
                    `Known facts: ${facts || 'none'}\n` +
                    `Recent chat vibe: ${recentMsgs || 'none'}\n` +
                    `Extra style notes: ${extra || 'none'}`
                }
              ],
              temperature: 0.6,
              max_tokens: 120
            });

            const drafted = (promptDraftRes.data?.choices?.[0]?.message?.content || '').trim();
            const finalPrompt = drafted.replace(/\s+/g, ' ').slice(0, 280) || `${displayName}, photoreal portrait in a gym, cinematic lighting`;

            await leonardoGenerateAndSend({ channel: message.channel, replyToMessage: message, prompt: finalPrompt });
          } catch (e) {
            await message.reply(`Teh, di ko ma-portray ngayon. ${e.message}`);
          }
          return;
        }

        // j!summarize / j!backread — Summarize chat (DB-grounded)
        // Usage:
        //   j!summarize              -> last 10 messages (quick)
        //   j!summarize 18:29 19:33  -> time window
        if (command === 'summarize' || command === 'backread' || command === 'sumchat') {
          const fromTime = (args[0] || '').trim();
          const toTime = (args[1] || '').trim();
          const hasWindow = Boolean(fromTime) || Boolean(toTime);
          const timeOk = !hasWindow || (/^\d{1,2}:\d{2}$/.test(fromTime) && /^\d{1,2}:\d{2}$/.test(toTime));
          if (!timeOk) {
            await message.reply('Format: `j!summarize` or `j!summarize 18:29 19:33`');
            return;
          }

          await message.channel.sendTyping();
          try {
            const rowsRes = await pool.query(
              'SELECT author_tag, content, created_at FROM messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 160',
              [message.channel.id]
            );
            const rows = (rowsRes.rows || []).reverse();
            const limit = hasWindow ? 120 : 10;
            const lines = rows
              .map((r) => {
                const ts = r.created_at ? new Date(r.created_at).toISOString() : 'unknown-time';
                const who = r.author_tag || 'someone';
                const msg = (r.content || '').replace(/\s+/g, ' ').trim();
                if (!msg) return null;
                return `[${ts}] ${who}: ${msg}`;
              })
              .filter(Boolean)
              .slice(-limit);

            const prompt = hasWindow
              ? (
                `JanJan persona ka pa rin (bading/maldita, taglish, witty). Wag formal report voice. ` +
                `Summarize the chat in THIS CHANNEL between ${fromTime} and ${toTime} (PH time) today. ` +
                `Use the backread transcript below (timestamps are ISO; align them to the requested window). ` +
                `Output format ONLY:\n` +
                `- 4-8 bullets (chika style, short)\n` +
                `- 1 short paragraph: ano nangyari (taglish)\n` +
                `- optional: 1-3 unresolved questions\n` +
                `Rules: bawal maglagay ng "Recap:" or "Chat Summary:" labels. Bawal mag-imbento. If little happened, sabihin mo straight.\n\n` +
                `[BACKREAD TRANSCRIPT]\n${lines.join('\n')}\n`
              )
              : (
                `JanJan persona ka pa rin (bading/maldita, taglish, witty). Wag formal. ` +
                `Quick backread: summarize the LAST 10 messages in THIS CHANNEL. ` +
                `Output format ONLY:\n` +
                `- 3-6 bullets (chika style)\n` +
                `- 1 short line: ano vibe/ganap\n` +
                `Rules: bawal "Recap:" label. Bawal mag-imbento.\n\n` +
                `[BACKREAD TRANSCRIPT]\n${lines.join('\n')}\n`
              );

            const discordContext = await buildDiscordAwarenessContext(message, false);
            const mentionContext = buildMentionContext(message);
            const voiceMembers = [];
            const summary = await callGroqChat(prompt, message.author.id, message.channel.id, voiceMembers, {
              fastMode: false,
              researchContext: [],
              discordContext,
              mentionContext,
              forceResearchGrounding: false,
              forceSexualGuard: false
            });

            const out = summary || 'Teh, may error sa summary. Try ulit mamaya.';
            const embed = new EmbedBuilder()
              .setColor(0x7B61FF)
              .setTitle('🧠 BACKREAD SUMMARY')
              .setDescription(out)
              .setFooter({ text: hasWindow ? `Window: ${fromTime} → ${toTime} • #${message.channel.name}` : `Quick: last 10 • #${message.channel.name}` })
              .setTimestamp();
            await message.reply({ embeds: [embed] });
          } catch (e) {
            await message.reply(`Teh, di ko ma-backread ngayon. Error: ${e.message}`);
          }
          return;
        }

        // j!admin â€” show admin command list
        if (command === 'admin' || command === 'commandslist') {
          const adminEmbed = new EmbedBuilder()
            .setTitle('JanJan Admin Panel')
            .setDescription('**Exclusive commands para sa mga diyosa ng server:**\n\n' +
              '- `j!status <note>` - Set bot bubble status (Admin only)\n' +
              '- `j!chat <id> <msg>` - Ghost message/reply (Owner only)\n' +
              '- `j!test` - Trigger mapang-lait greeting/roast\n' +
              '- `j!vc <text>` - Male TTS in voice channel\n' +
              '- `j!ask <question>` - Voice-only AI response\n' +
              '- `j!autotts` - Toggle Auto TTS in channel\n' +
              '- `j!join` / `j!leave` - Reset voice connection')
            .setColor(0xff0000)
            .setFooter({ text: 'JanJan Bot | Created by drei' });

          await message.reply({ embeds: [adminEmbed] });
          return;
        }
        // j!test
        if (command === 'test') {
          const now = getNowInPhilippines();
          const hour = now.getHours();
          const minute = now.getMinutes();
          const channel = message.channel;
          const members = message.guild ? await collectActiveMembersForChannel(channel) : [];
          const mentions =
            members.length > 0
              ? members.map((m) => `<@${m.id}>`).join(' ')
              : 'Walang online na ulikba ngayon.';

          let timeBand = 'gabi';
          if (hour >= 5 && hour < 12) timeBand = 'umaga';
          else if (hour >= 12 && hour < 18) timeBand = 'hapon';

          const phTimeString = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
          const aiPrompt =
            `Gumawa ka ng mapang-lait na greeting para sa lahat ng nasa channel. ` +
            `Oras na: ${phTimeString} (${timeBand}). ` +
            `Dapat matapang, mapanglait ng konti (roasting style), pero wholesome beki style. ` +
            `Sabihan mo silang gising na o matulog na depende sa oras, with extra asim. ` +
            `Isang maikling paragraph lang.`;

          await message.channel.sendTyping();

          let voiceMembers = [];
          if (message.guild) {
            const myVC = message.guild.members.me.voice.channel;
            if (myVC) {
              voiceMembers = myVC.members.filter(m => !m.user.bot).map(m => m.displayName || m.user.username);
            }
          }

          const aiText = await callGroqChat(aiPrompt, message.author.id, message.channel.id, voiceMembers);
          const header = members.length > 0 ? `**${mentions}**\n\n` : '';
          await message.reply({ content: `${header}${aiText}` });

          // Speak the roast if in voice
          if (message.guild && getVoiceConnection(message.guild.id)) {
            speakMessage(message.guild.id, aiText);
          }
          return;
        }


        // j!help / j!tulong
        if (command === 'help' || command === 'tulong') {
          const menuEmbed = new EmbedBuilder()
            .setColor(0xFF4D8D)
            .setAuthor({
              name: 'JANJAN • COMMAND MENU',
              iconURL: client.user.displayAvatarURL({ dynamic: true })
            })
            .setThumbnail(client.user.displayAvatarURL({ dynamic: true }))
            .setDescription(
              '**about me**\n' +
              '- mention/reply ka teh replyan kita\n' +
              '- minsan sasabat ako kahit di ako tinatanong, pake mo ba\n' +
              '- pag gusto mo tumigil ako: `j!tulog on`'
            )
            .addFields(
              {
                name: '💬 CHIKA / PROFILE',
                value:
                  '```' +
                  'j!view @User        - chika profile\n' +
                  'j!usersummary @User - summary ng tao (DB)\n' +
                  'j!img <prompt>      - generate picture\n' +
                  'j!portray @User     - portray a user as image\n' +
                  '```' +
                  '**No command needed:** “kilala mo ba ko?” / “kilala mo ba si @X?” (based sa naaalala ko)',
                inline: false
              },
              {
                name: '🧠 SUMMARIZE / BACKREAD',
                value:
                  '```' +
                  'j!summarize or j!backread\n' +
                  '```' +
                  'Bullets + short recap + unresolved questions (based sa backread).',
                inline: false
              },
              {
                name: '🔊 VOICE / TTS',
                value:
                  '```' +
                  'j!join              - pasok ako sa VC mo\n' +
                  'j!leave             - alis sa VC\n' +
                  'j!vc <text>         - TTS speak\n' +
                  'j!ask <question>    - AI answer then speak\n' +
                  'j!listen            - start STT listening\n' +
                  'j!stop              - stop STT listening\n' +
                  'j!voice / j!change m|f - change voice\n' +
                  'j!autotts           - toggle auto TTS in channel\n' +
                  '```',
                inline: false
              },
              {
                name: '🛠️ ADMIN / DIAGNOSTICS',
                value:
                  '```' +
                  'j!admin             - admin panel\n' +
                  'j!permcheck         - check channel perms\n' +
                  'j!checkdb           - DB size/storage (GB)\n' +
                  'j!status <note>     - set bot status\n' +
                  'j!tulog on|off      - pause auto-epal\n' +
                  '```',
                inline: false
              },
              {
                name: '⚡ QUICK',
                value:
                  '```' +
                  'j!ping              - latency\n' +
                  'j!test              - roast greeting\n' +
                  '```',
                inline: false
              }
            )
            .setFooter({ text: 'JanJan Bot • created by Drei • tip: j!admin (admins)' })
            .setTimestamp();

          const examplesEmbed = new EmbedBuilder()
            .setColor(0x7B61FF)
            .setTitle('📋 EXAMPLES (copy-paste)')
            .setDescription(
              '```' +
              '@JanJan Versa hi\n' +
              'j!summarize\n' +
              'kilala mo ba ko?\n' +
              'kilala mo ba si @Name?\n' +
              'j!checkdb\n' +
              '```'
            )
            .setFooter({ text: 'Pro tip: gamitin `j!permcheck` pag di ako nakikita sa channel.' });

          await message.reply({ embeds: [menuEmbed, examplesEmbed] });
          return;
        }

      }

      if (!rawContent.startsWith(prefix)) {
        const movedByNaturalChat = await tryNaturalVoiceMoveFromChat(message, rawContent);
        if (movedByNaturalChat) return;
      }

      // Mention or reply-to-bot triggers AI chat
      const isMention = message.mentions.has(me);

      let isReplyToBot = false;
      if (message.reference && message.reference.messageId) {
        try {
          const referenced = await message.fetchReference();
          if (referenced.author && referenced.author.id === me.id) {
            isReplyToBot = true;
          }
        } catch {
          // ignore
        }
      }

      const isSleepMode = message.guild?.id ? sleepGuilds.has(message.guild.id) : false;

      // Soft auto-chat: sometimes JanJan interjects when her name is mentioned in normal chat
      // (no @ mention needed). This is rate-limited + random to avoid spam.
      const lowerRaw = (rawContent || '').toLowerCase();
      const mentionsJanJanName =
        /(^|[^a-z0-9])(janjan|jan\s*jan|jan|josh)([^a-z0-9]|$)/i.test(lowerRaw) &&
        // reduce false positives like "january"
        !/\bjanuary\b/i.test(lowerRaw);

      const nowMs = Date.now();
      const autoChatScopeKey = message.guild?.id ? `guild:${message.guild.id}` : `dm:${message.channel.id}`;
      const lastAuto = autoChatCooldowns.get(autoChatScopeKey) || 0;
      const isPriorityChannel = priorityAutoChatChannels.has(message.channel.id);
      const AUTO_CHAT_COOLDOWN_MS = isPriorityChannel ? 45 * 1000 : 75 * 1000;
      const autoChatEligible = (nowMs - lastAuto) >= AUTO_CHAT_COOLDOWN_MS;
      const looksLowSignal =
        !rawContent ||
        rawContent.trim().length < 4 ||
        /^[\p{Emoji}\s]+$/u.test(rawContent.trim());

      // If user explicitly says the convo is still connected / they are still talking to JanJan,
      // and JanJan was recently active in this channel, reply reliably (even without @ mention).
      const connectedHint =
        /\b(still\s+connected|context\s+is\s+still\s+connected|connected\s+pa(la)?|tuloy\s+pa|continu(e|ing)|same\s+topic|same\s+lang|usap\s+pa|kausap\s+ka\s+pa|talking\s+to\s+janjan|still\s+talking\s+to\s+janjan)\b/i
          .test(rawContent || '');

      let botRecentlyActive = false;
      if (connectedHint && message.channel?.id) {
        try {
          const recentBotRes = await pool.query(
            'SELECT COUNT(*) FROM messages WHERE channel_id = $1 AND author_id = $2 AND created_at > (NOW() - INTERVAL \'20 minutes\')',
            [message.channel.id, client.user.id]
          );
          botRecentlyActive = parseInt(recentBotRes.rows?.[0]?.count || '0', 10) > 0;
        } catch {
          botRecentlyActive = false;
        }
      }

      // If JanJan has been chatting recently in this channel, treat it as "chatbot convo mode"
      // and be more epal (higher chance + shorter cooldown).
      let botThreadActive = false;
      if (!connectedHint && message.channel?.id) {
        try {
          const recentBotRes = await pool.query(
            'SELECT COUNT(*) FROM messages WHERE channel_id = $1 AND author_id = $2 AND created_at > (NOW() - INTERVAL \'12 minutes\')',
            [message.channel.id, client.user.id]
          );
          botThreadActive = parseInt(recentBotRes.rows?.[0]?.count || '0', 10) > 0;
        } catch {
          botThreadActive = false;
        }
      } else {
        botThreadActive = botRecentlyActive;
      }

      // "Epal mode": can auto-interject sometimes even without mention/keyword,
      // but stays rare + cooldown-protected to avoid spam.
      const baseAutoChatChance =
        botThreadActive ? 0.9 : (isPriorityChannel ? 0.75 : 0.5); // super epal when convo mode
      const autoChatChance = mentionsJanJanName ? 1.0 : baseAutoChatChance; // 100% when name is mentioned
      // Only "epal without mention" when it likely connects to an ongoing convo:
      // require recent activity in channel; name-mention bypasses this.
      let hasRecentBackreadContext = true;
      if (!mentionsJanJanName && message.channel?.id) {
        try {
          const recentRes = await pool.query(
            'SELECT COUNT(*) FROM messages WHERE channel_id = $1 AND created_at > (NOW() - INTERVAL \'10 minutes\')',
            [message.channel.id]
          );
          const recentCount = parseInt(recentRes.rows?.[0]?.count || '0', 10);
          hasRecentBackreadContext = recentCount >= 6;
        } catch {
          hasRecentBackreadContext = true;
        }
      }

      const shouldAutoChat =
        !rawContent.startsWith(prefix) &&
        !looksLowSignal &&
        (autoChatEligible || (connectedHint && botRecentlyActive) || botThreadActive) &&
        (mentionsJanJanName || hasRecentBackreadContext || botThreadActive) &&
        !isSleepMode &&
        (connectedHint && botRecentlyActive ? true : (Math.random() < autoChatChance));

      if (!isMention && !isReplyToBot && !shouldAutoChat) {
        // Auto TTS check
        if (message.guild && autoTtsChannels.has(message.guild.id)) {
          const channels = autoTtsChannels.get(message.guild.id);
          if (channels.has(message.channel.id) && message.content && !message.content.startsWith(prefix)) {
            // Speak the message autotts style
            const ttsText = `${message.member?.displayName || message.author.username} says: ${message.content}`;
            speakMessage(message.guild.id, ttsText);
          }
        }
        return;
      }

      // Queue AI replies per channel so fast message bursts are processed in order.
      await enqueueChannelAI(message.channel.id, async () => {
      const backlog = aiChannelQueueDepths.get(message.channel.id) || 0;
      const fastMode = backlog > 1;

      let content = message.content || '';
      if (isMention) {
        content = content
          .replaceAll(`<@${me.id}>`, '')
          .replaceAll(`<@!${me.id}>`, '')
          .trim();
      }

      if (!content) {
        content = 'Wala siyang sinabi, pero gusto lang daw makipagchikahan.';
      }

      // Natural image request (mention/reply mode): "send ka picture ng ..."
      // Converts to Leonardo generation and replies with an attachment.
      // Natural image requests (allow missing "picture" keyword, since users sometimes just say "gawa ka ng X")
      const imgMatch = content.match(/\b(send|gawa|generate|create)\b[\s\S]{0,25}\b(picture|pic|image|larawan)?\b[\s\S]{0,12}\b(ng|of|na)\b[\s:,-]*(.+)$/i);
      if (imgMatch && (isMention || isReplyToBot) && LEONARDO_API_KEY) {
        const prompt = (imgMatch[4] || '').trim();
        if (prompt.length >= 3) {
          try {
            await leonardoGenerateAndSend({ channel: message.channel, replyToMessage: message, prompt });
          } catch (e) {
            await message.reply(`Teh, fail yung pic. ${e.message}`);
          }
          return;
        }
      }

      // If user adds a meta-instruction like "reply okay if connected",
      // treat it as a connectivity hint but still reply normally.
      const okMetaPattern =
        /(if you feel like[\s\S]*?connected[\s\S]*?reply\s+okay)|(reply\s+okay[\s\S]*?connected)|(connected\s*100%[\s\S]*?reply\s*okay)/i;
      if (okMetaPattern.test(content)) {
        content = content.replace(okMetaPattern, '').replace(/\s{2,}/g, ' ').trim() || content;
      }

      // Anti-repeat + naturalness guard: if JanJan is looping, force variety and user-focus.
      // Pull last few JanJan replies + last few user messages for context and "do not repeat" rules.
      try {
        const lastBotRes = await pool.query(
          'SELECT content FROM messages WHERE channel_id = $1 AND author_id = $2 ORDER BY created_at DESC LIMIT 3',
          [message.channel.id, client.user.id]
        );
        const lastUserRes = await pool.query(
          'SELECT author_tag, content FROM messages WHERE channel_id = $1 AND author_id <> $2 ORDER BY created_at DESC LIMIT 3',
          [message.channel.id, client.user.id]
        );

        const lastBotTexts = (lastBotRes.rows || [])
          .map((r) => String(r.content || '').trim())
          .filter(Boolean)
          .map((t) => t.slice(0, 220));
        const lastUserTexts = (lastUserRes.rows || [])
          .map((r) => `${String(r.author_tag || 'user').trim()}: ${String(r.content || '').trim()}`)
          .filter(Boolean)
          .map((t) => t.replace(/\s+/g, ' ').slice(0, 220));

        if (lastBotTexts.length > 0 || lastUserTexts.length > 0) {
          content =
            `${content}\n\n[NATURAL CHAT GUARD]:\n` +
            `- bawal paulit-ulit (opener, punchline, brag, tanong)\n` +
            `- wag laging "WAHAHAHA" opener; mix it up (hala/luh/jusko/kaloka/sige/teh)\n` +
            `- wag ikaw lagi ang topic; reply to user's latest point\n` +
            `- 1 main point + 1 follow-up question max\n` +
            `- if user says "paulit ulit", acknowledge and switch topic\n` +
            (lastBotTexts.length ? `\n[YOUR LAST 3 REPLIES]:\n- ${lastBotTexts.join('\n- ')}` : '') +
            (lastUserTexts.length ? `\n\n[RECENT USER MESSAGES]:\n- ${lastUserTexts.join('\n- ')}` : '');
        }
      } catch { }

      // Always store user facts on interaction so summaries work
      if (isMention || isReplyToBot || shouldAutoChat) {
        const displayAuthor =
          message.member?.displayName ||
          message.author.globalName ||
          message.author.username ||
          message.author.tag;
        await extractAndStoreUserFacts({
          userId: message.author.id,
          displayName: displayAuthor,
          messageText: rawContent
        });
      }

      // "Kilala mo ba..." questions: auto-summarize from DB (no special command needed)
      const lowerContent = (content || '').toLowerCase();
      const isWhoAmIPrompt =
        /\b(kilala\s+mo\s+ba\s+ko|kilala\s+mo\s+ba\s+ako|do\s+you\s+know\s+me|who\s+am\s+i)\b/i.test(lowerContent);
      const isKnowTargetPrompt =
        /\b(kilala\s+mo\s+ba\s+(si|ito|to)|kilala\s+mo\s+ba\s+yan|do\s+you\s+know\s+him|do\s+you\s+know\s+her|do\s+you\s+know\s+this)\b/i
          .test(lowerContent);
      const isPersonMemoryRequest = Boolean(isWhoAmIPrompt || isKnowTargetPrompt);

      if ((isWhoAmIPrompt || isKnowTargetPrompt) && message.channel?.id) {
        const targets = [];
        if (message.mentions?.users?.size) {
          for (const [, u] of message.mentions.users) targets.push(u);
        }
        if (targets.length === 0) {
          targets.push(message.author);
        }

        const blocks = [];
        for (const u of targets.slice(0, 2)) {
          let facts = '';
          let recentLines = [];
          try {
            const factsRes = await pool.query('SELECT facts FROM user_memory WHERE user_id = $1', [u.id]);
            facts = factsRes.rows?.[0]?.facts || '';
          } catch { }
          try {
            const msgRes = message.guild
              ? await pool.query(
                  'SELECT channel_id, author_tag, content, created_at FROM messages WHERE guild_id = $1 AND author_id = $2 ORDER BY created_at DESC LIMIT 35',
                  [message.guild.id, u.id]
                )
              : await pool.query(
                  'SELECT channel_id, author_tag, content, created_at FROM messages WHERE channel_id = $1 AND author_id = $2 ORDER BY created_at DESC LIMIT 35',
                  [message.channel.id, u.id]
                );
            recentLines = (msgRes.rows || [])
              .reverse()
              .map((r) => {
                const ts = r.created_at ? new Date(r.created_at).toISOString() : 'unknown-time';
                const who = r.author_tag || (u.globalName || u.username || 'someone');
                const msg = (r.content || '').replace(/\s+/g, ' ').trim();
                if (!msg) return null;
                const where = r.channel_id ? ` (ch:${r.channel_id})` : '';
                return `[${ts}] ${who}${where}: ${msg}`;
              })
              .filter(Boolean);
          } catch { }

          const displayName =
            message.guild?.members?.cache?.get(u.id)?.displayName ||
            u.globalName ||
            u.username ||
            u.tag;

          blocks.push(
            `[TARGET PERSON]: ${displayName}\n` +
            `[DB FACTS]: ${facts || '(none)'}\n` +
            `[RECENT MESSAGES IN THIS CHANNEL]:\n${recentLines.join('\n') || '(none)'}\n`
          );
        }

        const instruction =
          `\n\n[DB-BASED PERSON SUMMARY MODE]: The user asked if you know someone. ` +
          `Answer based ONLY on the DB info blocks below. ` +
          `Do NOT output raw Discord IDs. ` +
          `If info is thin, say kulang pa info and ask 1 short follow-up question.\n\n` +
          blocks.join('\n---\n');

        content = `${content}${instruction}`;
      }

      // Explicit summarize requests: pull recent channel messages with timestamps.
      // This prevents JanJan from being dismissive and forces a real summary grounded in backread.
      const summarizeMatch = content.match(/summarize\s+chat\s+from\s+(\d{1,2}:\d{2})\s+to\s+(\d{1,2}:\d{2})/i);
      const isBackreadSummaryRequest = Boolean(summarizeMatch) || /\b(j!summarize|j!backread)\b/i.test(message.content || '');
      if (summarizeMatch && message.channel?.id) {
        const fromTime = summarizeMatch[1];
        const toTime = summarizeMatch[2];
        try {
          const rowsRes = await pool.query(
            'SELECT author_tag, content, created_at FROM messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 120',
            [message.channel.id]
          );
          const rows = (rowsRes.rows || []).reverse();
          const lines = rows
            .map((r) => {
              const ts = r.created_at ? new Date(r.created_at).toISOString() : 'unknown-time';
              const who = r.author_tag || 'someone';
              const msg = (r.content || '').replace(/\s+/g, ' ').trim();
              if (!msg) return null;
              return `[${ts}] ${who}: ${msg}`;
            })
            .filter(Boolean)
            .slice(-90);

          const summaryContext =
            `\n\n[SUMMARY REQUEST]: Summarize the chat in THIS CHANNEL between ${fromTime} and ${toTime} (PH time) today. ` +
            `Use the backread transcript below (timestamps are ISO; align them to the requested window). ` +
            `IMPORTANT STYLE: Keep JanJan's bading/maldita persona while summarizing (taglish, witty, a bit sassy). ` +
            `Output format ONLY: 4-8 bullets + 1 short paragraph (ano nangyari) + optional unresolved questions. ` +
            `Do NOT say "wala akong nakita" — if little happened, say that clearly and state what DID happen.\n` +
            `[BACKREAD TRANSCRIPT]\n${lines.join('\n')}\n`;

          content = `${content}${summaryContext}`;
        } catch (e) {
          // If DB fails, still proceed with normal chat (model will rely on its history context)
        }
      }

      // Light persona reaction for mentions/replies (no spam)
      await maybeReactPersona(
        message,
        content,
        shouldAutoChat ? 1.0 : (isMention || isReplyToBot ? 0.9 : 0.35)
      );

      const sexualGuardMode = isSexualEscalationText(content);

      // Never use web research for backread/summarize or person-memory requests.
      // These must be grounded in channel history / stored memory only (no "Sources:" spam).
      const researchEnabled = message.guild?.id ? researchEnabledGuilds.has(message.guild.id) : false;
      const allowResearchAndSources = researchEnabled && (isMention || isReplyToBot) && !shouldAutoChat;
      const researchMode =
        allowResearchAndSources && !(isBackreadSummaryRequest || isPersonMemoryRequest)
          ? shouldUseResearchMode(content)
          : false;
      const tavilyResults = researchMode ? await searchWithTavily(content, fastMode ? 3 : 5) : [];
      const discordContext = await buildDiscordAwarenessContext(message, fastMode);
      const mentionContext = buildMentionContext(message);

      if (shouldAutoChat) {
        autoChatCooldowns.set(autoChatScopeKey, nowMs);
        // Make it feel like she backread the convo before jumping in
        content =
          `AUTO-INTERACT MODE (NOT SPAM): You decided to join the conversation because your name was mentioned ("${rawContent}"). ` +
          `Backread the last messages in the channel first (use the conversation history). ` +
          `Then do a natural chat-interaction: react in a varied way (wag laging WAHAHAHA; pwede hala/luh/jusko/kaloka/sige/teh). ` +
          `Reply to ONE specific point/person you saw in the backread (use their nickname), then keep it moving with 1 short follow-up question. ` +
          `Optional: mini-story minsan lang, and dapat related + hindi ikaw lagi ang topic. ` +
          `ANTI-REPEAT: bawal paulit-ulit na same opener/brag/joke/question. If user calls you out for repeating, apologize briefly and switch angle. ` +
          `Keep it short and not formal.\n\n` +
          `Name-trigger message you are reacting to: ${rawContent}`;
      }

      if (researchMode && tavilyResults.length === 0) {
        const noSourceReply =
          'Teh, latest yan pero wala akong ma-pull na fresh sources ngayon gusto mo mag research ka nalang beh! tanong ka ng tanong sakin bobayta ka tlga. ' +
          'Pa-try ulit in a bit or pakilinaw yung query para di tayo hula-hula.';
        await message.reply(noSourceReply);
        try {
          await pool.query(
            'INSERT INTO messages (guild_id, channel_id, author_id, author_tag, content) VALUES ($1, $2, $3, $4, $5)',
            [
              message.guild?.id || 'DM',
              message.channel.id,
              client.user.id,
              client.user.tag,
              noSourceReply
            ]
          );
        } catch (dbErr) {
          console.error('[DB] Bot reply save error:', dbErr.message);
        }
        return;
      }

      await message.channel.sendTyping();

      // --- UNIVERSAL AWARENESS & LEARNING ---
      // JanJan learns from EVERY message, not just mentions.
      // This builds her 'CHANNEL_SUMMARY' and 'USER_FACTS' automatically.
      let voiceMembers = [];
      if (message.guild) {
        let targetVC = message.guild.members.me.voice.channel || message.member?.voice?.channel;
        if (targetVC) {
          voiceMembers = targetVC.members
            .filter(m => !m.user.bot)
            .map(m => m.displayName || m.user.username);
        }
      }

      const reply = await callGroqChat(content, message.author.id, message.channel.id, voiceMembers, {
        fastMode,
        researchContext: tavilyResults,
        discordContext,
        mentionContext,
        forceResearchGrounding: researchMode,
        forceSexualGuard: sexualGuardMode
      });

      if (reply && reply.length > 0) {
        const sourceLines = (allowResearchAndSources ? tavilyResults : [])
          .slice(0, 3)
          .map((r) => `- [${r.title}](${r.url})`);
        const finalReply = (allowResearchAndSources && sourceLines.length > 0)
          ? `${reply}\n\nSources:\n${sourceLines.join('\n')}`
          : reply;
        let safeReplyRaw = finalReply.length > 1900 ? `${finalReply.slice(0, 1900)}...` : finalReply;
        // Strip any hallucinated Sources block unless research is explicitly enabled/allowed.
        if (!allowResearchAndSources) {
          safeReplyRaw = safeReplyRaw.replace(/\n\nSources:\s*[\s\S]*$/i, '').trim();
        }
        const safeReply = keepChikaEmojisLight(safeReplyRaw);

        await message.reply(safeReply);

        // NOTE: For normal chat/mentions, we DO NOT autoâ€‘TTS the reply anymore.
        // TTS is only triggered explicitly via j!vc / j!ask / j!test / voice events.

        // Save the bot's reply to DB so it remembers what it said
        try {
          await pool.query(
            'INSERT INTO messages (guild_id, channel_id, author_id, author_tag, content) VALUES ($1, $2, $3, $4, $5)',
            [
              message.guild?.id || 'DM',
              message.channel.id,
              client.user.id,
              client.user.tag,
                safeReply
              ]
            );
        } catch (dbErr) {
          console.error('[DB] Bot reply save error:', dbErr.message);
        }
      }
      });
    } catch (err) {
      console.error('Error handling messageCreate:', err);
    }
  });

  // =====================================================================
  // VOICE STATE UPDATE â€” AI-generated join/leave announcements
  // Uses Groq AI to generate unique beki-style greetings and backstabs
  // Same vibe as gnslgbot2's on_voice_state_update
  // =====================================================================

  const vcComplimentCache = new Map(); // userId -> {word, ts}

  async function inferComplimentWord(userId, displayName) {
    const cached = vcComplimentCache.get(userId);
    const TEN_HOURS = 10 * 60 * 60 * 1000;
    if (cached && (Date.now() - cached.ts) < TEN_HOURS) return cached.word;

    let userFacts = '';
    try {
      const userRes = await pool.query('SELECT facts FROM user_memory WHERE user_id = $1', [userId]);
      userFacts = userRes.rows[0]?.facts || '';
    } catch { }

    let word = 'astig';
    try {
      const res = await performChatRequest({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: 'Classify likely compliment style from nickname/context. Output only one token: POGI or GANDA or NEUTRAL.'
          },
          {
            role: 'user',
            content: `Nickname: ${displayName}\nKnown facts: ${userFacts || 'none'}`
          }
        ],
        temperature: 0.1,
        max_tokens: 5
      });

      const raw = (res.data?.choices?.[0]?.message?.content || '').toUpperCase();
      if (raw.includes('POGI')) word = 'pogi';
      else if (raw.includes('GANDA')) word = 'ganda';
      else word = 'astig';
    } catch {
      word = 'astig';
    }

    vcComplimentCache.set(userId, { word, ts: Date.now() });
    return word;
  }

  // Quick Groq call for AI-generated VC announcements (fast, short, adaptive via DB facts)
  const lastVCAnnouncementByGuild = new Map(); // key: guildId:type[:rage] -> text
  const vcRapidActivity = new Map(); // key: guildId:userId -> { stamps: number[] }
  const vcAnnouncementBuffers = new Map(); // guildId -> { events: [], timer: Timeout | null, flushing: boolean }

  function trackVCRapidActivity(guildId, userId) {
    const key = `${guildId}:${userId}`;
    const now = Date.now();
    const windowMs = 90000;
    const current = vcRapidActivity.get(key) || { stamps: [] };
    const stamps = [...current.stamps, now].filter((ts) => now - ts <= windowMs);
    vcRapidActivity.set(key, { stamps });
    return stamps.length >= 3;
  }

  async function generateVCAnnouncement(type, displayName, userId = null, guildId = 'global', complimentWord = 'astig', rageMode = false) {
    const groqKey = GROQ_KEYS.find(k => k);
    if (!groqKey) return null;
    try {
      let userFacts = '';
      if (userId) {
        try {
          const userRes = await pool.query('SELECT facts FROM user_memory WHERE user_id = $1', [userId]);
          userFacts = userRes.rows[0]?.facts || '';
        } catch { }
      }
      const previousKey = `${guildId}:${type}:${rageMode ? 'rage' : 'normal'}`;
      const previous = lastVCAnnouncementByGuild.get(previousKey) || '';

      const prompt = type === 'join'
        ? `Gumawa ng ISANG maikling rude beki VC JOIN line para kay "${displayName}". 1 sentence lang, max 18 words. ` +
          `Include compliment flavor like "ang ${complimentWord} naman neto bes" naturally. ` +
          `Style: ${rageMode ? 'sobrang galit, mataray, maanghang, may murang Pinoy pero hindi hate speech' : 'mataray, witty, kanal humor'}. Person context: ${userFacts || 'none'}. ` +
          `Huwag ulitin itong previous style/line: "${previous}". Walang explanation.`
        : `Gumawa ng ISANG maikling rude BACKSTAB VC LEAVE line para kay "${displayName}". 1 sentence lang, max 18 words. ` +
          `Style: ${rageMode ? 'sobrang galit, mataray, maanghang, may murang Pinoy pero hindi hate speech' : 'mataray, mapanlait, funny'}. Person context: ${userFacts || 'none'}. ` +
          `Huwag ulitin itong previous style/line: "${previous}". Walang explanation.`;

      const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 80,
        temperature: 1.0
      }, {
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        timeout: 4000
      });
      let text = response.data.choices[0]?.message?.content?.trim() || null;
      if (!text) return null;
      text = text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
      if (text.length > 180) text = `${text.slice(0, 177)}...`;
      lastVCAnnouncementByGuild.set(previousKey, text);
      return text;
    } catch (err) {
      console.error('[VOICE STATE] AI generation error:', err.message);
      return null;
    }
  }

  function getOrCreateVCBuffer(guildId) {
    const existing = vcAnnouncementBuffers.get(guildId);
    if (existing) return existing;
    const created = { events: [], timer: null, flushing: false };
    vcAnnouncementBuffers.set(guildId, created);
    return created;
  }

  function compressVCEvents(events) {
    const byUser = new Map();
    for (const ev of events) byUser.set(ev.userId, ev);
    return [...byUser.values()];
  }

  async function buildBatchVCAnnouncement(guildId, events) {
    const compact = compressVCEvents(events);
    if (compact.length === 0) return null;

    if (compact.length === 1) {
      const ev = compact[0];
      if (ev.type === 'join') {
        const fallbackJoin = ev.rageMode
          ? [
            `Hoy ${ev.displayName}, labas-pasok ka na naman?.... Ano ba talaga trip mo, teh?`,
            `${ev.displayName}, pumirme ka nga.... VC to, hindi ito revolving door, gago ka ba?`,
            `Ayan si ${ev.displayName}, balik na naman.... Desisyonan mo buhay mo, teh.`
          ]
          : [
            `Ayan na si ${ev.displayName}, ang ${ev.complimentWord} naman neto bes.`,
            `${ev.displayName} joined. Gulo mode ulit, mga accla.`,
            `Uy ${ev.displayName}, sa wakas dumating ka rin.`
          ];
        const aiJoin = await generateVCAnnouncement('join', ev.displayName, ev.userId, guildId, ev.complimentWord, ev.rageMode);
        return aiJoin || fallbackJoin[Math.floor(Math.random() * fallbackJoin.length)];
      }

      const fallbackLeave = ev.rageMode
        ? [
          `Labas ulit si ${ev.displayName}. Teh, ano ba yan, pasok-labas ka parang sirang pinto bobo amputa.`,
          `${ev.displayName} umalis nanaman si gago  Kalmahan mo, hindi ka makukulong dito, bwisit.`,
          `Ayan na, umalis na naman si ${ev.displayName}. Gulo mo today, teh. may asin ba pwerta mo?`
        ]
        : [
          `Umalis si ${ev.displayName}. Pwede na mag-backstab, kasi tanga talaga yon.`,
          `${ev.displayName} left. Tahimik na, pero mas masarap mang-lait.`,
          `Ayun umalis si ${ev.displayName}, next issue please.`
        ];
      const aiLeave = await generateVCAnnouncement('leave', ev.displayName, ev.userId, guildId, ev.complimentWord, ev.rageMode);
      return aiLeave || fallbackLeave[Math.floor(Math.random() * fallbackLeave.length)];
    }

    const rageMode = compact.some((ev) => ev.rageMode) || compact.length >= 3;
    const joins = compact.filter((ev) => ev.type === 'join');
    const leaves = compact.filter((ev) => ev.type === 'leave');
    const joinNames = joins.map((ev) => ev.displayName);
    const leaveNames = leaves.map((ev) => ev.displayName);
    const joinList = joinNames.join(', ') || 'wala';
    const leaveList = leaveNames.join(', ') || 'wala';
    const prevKey = `${guildId}:batch:${rageMode ? 'rage' : 'normal'}`;
    const previous = lastVCAnnouncementByGuild.get(prevKey) || '';
    const groqKey = GROQ_KEYS.find((k) => k);

    if (groqKey) {
      try {
        const prompt =
          `Gumawa ng ISANG VC group announcement line sa Taglish. Max 24 words, 1 sentence lang. ` +
          `Context: may sabay-sabay na movement sa voice channel. Pumasok: ${joinList}. Umalis: ${leaveList}. ` +
          `Rule: group-level lang, wag individual greetings kada tao. Dapat may vibe na nalilito siya kung sino ang babatiin kapag sabay-sabay. ` +
          `Style: ${rageMode ? 'sobrang galit, mataray, may mura like gago, tarantado, tanga, bobo puta!, funny kanal' : 'mataray, witty, mabilis'}. ` +
          `Huwag ulitin ito: "${previous}". Walang paliwanag.`;

        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 100,
          temperature: 1.5
        }, {
          headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
          timeout: 4000
        });

        let text = response.data.choices[0]?.message?.content?.trim() || '';
        text = text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
        if (text) {
          if (text.length > 190) text = `${text.slice(0, 187)}...`;
          lastVCAnnouncementByGuild.set(prevKey, text);
          return text;
        }
      } catch (err) {
        console.error('[VOICE STATE] Batch AI generation error:', err.message);
      }
    }

    if (rageMode) {
      if (joins.length && leaves.length) return `Ano ba 'to, nalilito na ko kung sino babatiin: pasok si ${joinList}, labas si ${leaveList}, gulo nyo, mga teh.`;
      if (joins.length) return `Sabay-sabay kayong pumasok: ${joinList}. Nalilito na ko kung sino uunahin, kalma kayo, accla.`;
      return `Sabay-sabay din kayong umalis: ${leaveList}. Nalilito na ko sa inyo, walkout challenge ba 'to, bwisit?`;
    }

    if (joins.length && leaves.length) return `Update lang, nalilito na ko kung sino babatiin: pumasok si ${joinList}, umalis si ${leaveList}.`;
    if (joins.length) return `Ayan, sabay pumasok sina ${joinList}. Nalilito na ko kung sino uunahin batiin, beshies.`;
    return `Sabay umalis sina ${leaveList}. Nalito na rin ako sa flow nyo, tahimik na ulit for now.`;
  }

  function queueVCAnnouncement(guildId, event) {
    const state = getOrCreateVCBuffer(guildId);
    state.events.push(event);
    if (state.timer) clearTimeout(state.timer);

    state.timer = setTimeout(async () => {
      if (state.flushing) return;
      state.flushing = true;
      state.timer = null;
      const batch = state.events.splice(0, state.events.length);

      try {
        const msg = await buildBatchVCAnnouncement(guildId, batch);
        if (msg) {
          console.log(`[VOICE STATE] batched ${batch.length} events -> "${msg}"`);
          speakMessage(guildId, msg, null);
        }
      } catch (err) {
        console.error('[VOICE STATE] queue flush error:', err.message);
      } finally {
        state.flushing = false;
      }
    }, 1400);
  }

  client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
      const member = newState.member || oldState.member;
      if (!member) return;

      const guildId = newState.guild.id;

      // =====================================================================
      // 24/7 GUARD: If the BOT itself was disconnected/moved, REJOIN!
      // =====================================================================
      if (member.id === client.user.id) {
        const wasInChannel = oldState.channelId;
        const nowInChannel = newState.channelId;

        if (wasInChannel && !nowInChannel && savedVoiceState) {
          // Bot was KICKED or DISCONNECTED from voice â€” rejoin immediately!
          console.log(`[VOICE 24/7] ðŸš¨ BOT WAS KICKED/DISCONNECTED! Rejoining in 3s...`);
          scheduleVoiceRejoin('bot-kicked', 3000);
          return;
        }

        if (wasInChannel && nowInChannel && wasInChannel !== nowInChannel && savedVoiceState) {
          // Bot was MOVED to another channel â€” update saved state and stay
          console.log(`[VOICE 24/7] Bot was moved to channel ${nowInChannel}. Updating saved state.`);
          setSavedVoiceState({ guildId, channelId: nowInChannel });
          await saveVoiceStateToDB(guildId, nowInChannel);
          return;
        }

        return; // Don't announce bot's own movements
      }

      // === HUMAN USER join/leave announcements ===
      const connection = getVoiceConnection(guildId);
      if (!connection) return;

      const botVC = newState.guild.members.me?.voice?.channel;
      if (!botVC) return;

      const displayName = member.displayName || member.user.username;
      const joinedBotVC = newState.channelId === botVC.id && oldState.channelId !== botVC.id;
      const leftBotVC = oldState.channelId === botVC.id && newState.channelId !== botVC.id;
      const complimentWord = await inferComplimentWord(member.id, displayName);
      const isRapidToggle = (joinedBotVC || leftBotVC) ? trackVCRapidActivity(guildId, member.id) : false;

      if (joinedBotVC) {
        queueVCAnnouncement(guildId, {
          type: 'join',
          userId: member.id,
          displayName,
          complimentWord,
          rageMode: isRapidToggle
        });
      } else if (leftBotVC) {
        queueVCAnnouncement(guildId, {
          type: 'leave',
          userId: member.id,
          displayName,
          complimentWord,
          rageMode: isRapidToggle
        });
      }
    } catch (err) {
      console.error('[VOICE STATE] Error:', err.message);
    }
  });

  // Login AFTER sodium is ready and events are registered
  client.login(DISCORD_TOKEN).catch((err) => {
    runtimeState.discord.lastLoginError = err.message;
    console.error('Failed to login to Discord:', err.message);
    process.exit(1);
  });

})(); // End of async IIFE
