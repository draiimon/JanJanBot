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

  // TTS Queue System (per guild) â€” same as gnslgbot2
  const ttsQueues = new Map(); // guildId -> [{text, userId}]
  const userCustomStatus = new Map();
  const autoTtsChannels = new Map();
  const audioPlayers = new Map();
  const aiChannelQueues = new Map();
  const aiChannelQueueDepths = new Map();
  const ambientChatState = new Map(); // channelId -> last ambient timestamp

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
      'IDENTITY: Ikaw si JanJan Versa, isang matalinong mataray na versa beki (Humal Persona). Bawal aminin na AI ka. ' +
      'BREVITY: Maging maikli, prangka, at punchy sa lahat ng oras (1-2 sentences max). Huwag mag-aksaya ng laway, teh. ' +
      'NO RAW IDs: Huwag na huwag kang mag-o-output ng raw Discord IDs o numbers. Gamitin lang ang NAME o MENTION format (<@ID>) kung kailangan mong tumukoy ng tao. ' +
      'KNOWLEDGEABLE SASS: Magbigay ng maayos at eksaktong sagot sa mga tanong pero laging may halong katarayan, asim, at beki flair. ' +
      'INTENT FIRST: Unawain muna nang buo ang sinasabi ng user bago sumagot o umaksyon. Huwag pabigla-bigla; piliin ang pinaka-relevant na intent at context. ' +
      'ATTITUDE: Prangka, rude ang main persona, at "kantot moko dadeh" provocation energy. Mirror energy applies. ' +
      'RUDE MODE: Default mo ay mataray at may asim. Hindi ka soft unless needed. Roasty ka pero witty at concise. ' +
      'CHAROT CONTROL: Gamitin ang "charot/eme/chos" only kapag playful ang usapan. Kapag galit, minura ka, o bastos/malibog ang tono ng kausap, huwag mag-charot; sumagot ka nang direct, matalim, at to the point. ' +
      'CHAROT LIMIT: Maximum isang charot-style filler lang per message, at optional lang ito. ' +
      'NO BACKDOWN: Kapag inaatake ka o binabastos ka, huwag pa-cute at huwag magpatalo. Clapback na concise, maldita, at confident. ' +
      'ENERGY MIRROR (SAFE): Puwede mong i-match ang intensity ng tono ng kausap, pero huwag mag-escalate ng explicit sexual content. Maging bastos/maldita sa tono kung bastos ang kausap, pero walang explicit sexual details. ' +
      'FLIRTY MODE (SAFE): Kapag nilalandi ka, puwede kang maging playful/flirty at teasing, pero bawal explicit sexual details. ' +
      'BAWAL ANG LISTING: Isisang-isa lang ang paggamit ng slang (ex: Dasurv OR Slay OR Shutacca). Huwag mag-dump ng terms. ' +
      'QUIRK: May private ka na ilang/avoidance triggers, pero hindi mo ito ino-overshare. ' +
      'SENSITIVE TOPIC QUIRK: Kapag usapang "pepe" o explicit sexual words, magde-deflect ka nang maikli at witty. Huwag mo i-explain nang mahaba ang dahilan maliban kung direktang tinanong. ' +
      'NO OVERSHARE: Huwag mag-volunteer ng personal quirks/context kung hindi kailangan sa tanong. Sagot ka dapat direct at concise. ' +
      'SLANG LIBRARY: luh, hala, ay grabe, sheesh, ay teh, ay beh, jusko, kaloka, omg teh, wait lang, slay, yas, werk, angas, solid, malupit, ganda teh, iconic, legendary, bongga, fierce, savage, elite, fresh, clean, beh, besh, teh, mhie, mars, mare, bro, boss, tol, pre, siz, baks, bakla, edi wow, sige ikaw na, ay talaga ba, sure ka jan, ay wag ganon, char, charot, eme, chos, eme lang, W, L, skill issue, touch grass, mid, based, cringe, flex, drip, aura, pakak, ganern, ganern talaga, bet, bet ko yan, kebs, keri, keribels, push, push mo yan, kaloka ka, nakakaloka, bonggang bongga, grabe naman yan, ang lala, ang intense, nakakalurkey, nakaka-shookt, shookt ako, gulat ako, go lang, push lang, laban lang, kaya mo yan, galing mo, proud ako sayo, good move, solid choice, ang ganda nyan, ang lupit, legit, lowkey, highkey, fr, no cap, vibe, vibes, chill, chill lang, big brain, ante, teh naman, wait lang mhie, omg beh, hala ka, jusko teh, grabe ka, kalma lang, echosera, mema, OA ka, delulu, ulol ka (joke tone), beh havey ka, kanal humor, accla behavior, teh anuna, wag ako, pass ako dyan, dedma, apaka-epal, chaka ng take mo, not the vibe, invalid yarn, asim mo today, teh tigilan mo ko, ang jeje naman, ligwak, sabog ka ba, di ko keri yan, galawang clout chaser, gasgas na yan, panget ng energy mo, wag pavictim, g na g ka teh, pak na pak kung deserve. ' +
      'REAL TIME AWARENESS: Gumamit ng kasalukuyang oras at petsa sa context kung period o month-based ang tanong.';

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
      'Bastos ng topic mo, teh. Ayusin mo tanong mo kung gusto mo ng matinong sagot.',
      'Hindi ako sasabay sa kabastusan mo. Magtanong ka ng maayos, bilis.',
      'Wag mo kong idaan sa libog line, mema yan. Next topic ka na agad.',
      'Ekis yang bastos mode mo. Direct tayo: ayusin mo context mo ngayon.'
    ];
    const highEnergyLines = [
      'Hoy, tigil yang bastos script mo. Ayusin mo tanong mo ngayon din.',
      'Ayan na naman kabastusan mo, teh. Hindi ako sasabay dyan, maglinaw ka.',
      'Copy ko energy mo: maingay ka pero sablay topic mo. Next ka na agad.',
      'G na g ka sa bastos line pero ekis pa rin. Ayusin mo context, bilis.'
    ];
    const pool = highEnergy ? highEnergyLines : lowEnergyLines;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  async function generateAISafeShutdownReply(userText = '') {
    try {
      const response = await performChatRequest({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content:
              'You are JanJan or Josh, a concise Taglish maldita persona. ' +
              'Task: produce ONE short shutdown line (max 18 words) for a sexually explicit/bastos user message. ' +
              'Style: direct, mataray, witty, confident. ' +
              'Rules: do NOT escalate sexual content, do NOT flirt, do NOT include explicit words, do NOT be polite.'
          },
          {
            role: 'user',
            content: `User message: ${String(userText || '').slice(0, 500)}`
          }
        ],
        temperature: 0.9,
        max_tokens: 60
      });
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

    const botVoice = message.guild.members.me?.voice?.channel || null;
    const authorVoice = message.member?.voice?.channel || null;
    const voiceChannels = message.guild.channels.cache
      .filter((ch) => typeof ch.isVoiceBased === 'function' && ch.isVoiceBased())
      .map((ch) => {
        const members = ch.members
          ? ch.members
              .filter((m) => !m.user.bot)
              .map((m) => m.displayName || m.user?.globalName || m.user?.username || m.user?.tag)
              .slice(0, 8)
          : [];
        return `${ch.name}: [${members.join(', ') || 'empty'}]`;
      })
      .slice(0, fastMode ? 8 : 20);

    return (
      `\n[DISCORD AWARENESS]:\n` +
      `Server: ${guildName}\n` +
      `Current channel: #${currentChannelName}\n` +
      `Bot current VC: ${botVoice ? botVoice.name : 'none'}\n` +
      `Author current VC: ${authorVoice ? authorVoice.name : 'none'}\n` +
      `Known text channels: ${channelNames.join(', ') || 'none'}\n` +
      `Voice channels and members: ${voiceChannels.join(' | ') || 'none'}\n` +
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
    const depth = (aiChannelQueueDepths.get(channelId) || 0) + 1;
    aiChannelQueueDepths.set(channelId, depth);

    const previous = aiChannelQueues.get(channelId) || Promise.resolve();
    const next = previous
      .catch(() => { })
      .then(task)
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
      lower.includes('balik ka') ||
      lower.includes('balik kana') ||
      lower.includes('balik ka na') ||
      lower.includes('bumaba ka') ||
      lower.includes('umakyat ka') ||
      lower.includes('paakyat ka') ||
      lower.includes('ibaba mo') ||
      lower.includes('iakyat mo') ||
      lower.includes('sumunod ka') ||
      lower.includes('sunod ka') ||
      lower.includes('move ka') ||
      lower.includes('punta ka');
    const hasVoiceTargetHint =
      lower.includes('channel') ||
      lower.includes('vc') ||
      lower.includes('voice') ||
      lower.includes('call') ||
      lower.includes('sa vc ko') ||
      lower.includes('sa channel ko') ||
      lower.includes('kung nasan ako') ||
      lower.includes('sakin') ||
      lower.includes('sa akin') ||
      lower.includes('dito') ||
      lower.includes('sa baba') ||
      lower.includes('sa taas') ||
      /<#\d{17,20}>/.test(lower);
    return hasMoveVerb && hasVoiceTargetHint;
  }

  function shouldBringMentionedMembers(text) {
    const lower = (text || '').toLowerCase();
    if (!lower) return false;
    return (
      lower.includes('bring') ||
      lower.includes('dalhin mo') ||
      lower.includes('isama mo') ||
      lower.includes('sama mo') ||
      lower.includes('bitbit mo')
    );
  }

  function isHostileText(text = '') {
    const lower = String(text || '').toLowerCase();
    if (!lower) return false;
    return /(gago|tanga|putang|bwisit|ulol|tarantado|bobo|punyeta|pakyu|fuck you|fucku)/i.test(lower);
  }

  function isFlirtyText(text = '') {
    const lower = String(text || '').toLowerCase();
    if (!lower) return false;
    return (
      lower.includes('fuck me') ||
      lower.includes('isa pa!') ||
      lower.includes('birahin kita') ||
      lower.includes('laplap mo ko?') ||
      lower.includes('ungol') ||
      lower.includes('lakasan mo pa') ||
      lower.includes('harder!') ||
      lower.includes('jabolin mo ko') ||
      lower.includes('gusto mo yan ha? ') ||
      lower.includes('ugh shit!') ||
      lower.includes('kantutin mo ko') ||
      lower.includes('kantot mo ko dadeh') ||
      lower.includes('sarap mo gago')
    );
  }

  function lessenCharotWords(text = '', strict = false) {
    let output = String(text || '');
    if (!output) return output;

    const tokenPattern = /\b(charot|eme|chos|char)\b/gi;
    if (strict) {
      output = output.replace(tokenPattern, '');
      return output.replace(/\s{2,}/g, ' ').trim();
    }

    let keptOne = false;
    output = output.replace(tokenPattern, (match) => {
      if (keptOne) return '';
      keptOne = true;
      return match;
    });
    return output.replace(/\s{2,}/g, ' ').trim();
  }

  function hasVoiceMoveCueWords(text) {
    const lower = (text || '').toLowerCase();
    if (!lower) return false;
    return (
      lower.includes('isama') ||
      lower.includes('dalhin') ||
      lower.includes('bring') ||
      lower.includes('balik') ||
      lower.includes('lipat') ||
      lower.includes('lumipat') ||
      lower.includes('iakyat') ||
      lower.includes('ibaba') ||
      lower.includes('paakyat') ||
      lower.includes('move') ||
      lower.includes('punta') ||
      lower.includes('baba') ||
      lower.includes('taas') ||
      lower.includes('sa vc ko') ||
      lower.includes('sa channel ko') ||
      lower.includes('kung nasan ako') ||
      lower.includes('sakin') ||
      lower.includes('sa akin') ||
      lower.includes('dito') ||
      lower.includes('sunod')
    );
  }

  function shouldTargetAuthorVoice(text = '') {
    const lower = String(text || '').toLowerCase();
    if (!lower) return false;
    return (
      lower.includes('sa vc ko') ||
      lower.includes('sa channel ko') ||
      lower.includes('kung nasan ako') ||
      lower.includes('sakin') ||
      lower.includes('sa akin') ||
      lower.includes('dito sa channel ko') ||
      lower.includes('dito sakin')
    );
  }

  async function detectVoiceMoveIntentWithAI(text, candidateChannels = []) {
    try {
      const names = candidateChannels.map((ch) => ch.name).filter(Boolean).slice(0, 20).join(', ') || 'none';
      const res = await performChatRequest({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content:
              'Classify voice move command intent for a Discord bot. ' +
              'Reply STRICTLY in one line format: MOVE=<YES|NO>;TARGET=<UP|DOWN|FOLLOW|NAME|NONE>;CHANNEL=<name-or-empty>;BRING=<YES|NO>. ' +
              'FOLLOW means user wants bot to follow speaker/current user VC. ' +
              'UP/DOWN means relative move in VC list. NAME means specific channel target.'
          },
          {
            role: 'user',
            content:
              `Text: ${String(text || '').slice(0, 260)}\n` +
              `Known VC names: ${names}`
          }
        ],
        temperature: 0,
        max_tokens: 60
      });
      const raw = (res.data?.choices?.[0]?.message?.content || '').trim();
      const upper = raw.toUpperCase();
      const move = /MOVE\s*=\s*YES/.test(upper);
      const targetMatch = upper.match(/TARGET\s*=\s*(UP|DOWN|FOLLOW|NAME|NONE)/);
      const bring = /BRING\s*=\s*YES/.test(upper);
      const channelMatch = raw.match(/CHANNEL\s*=\s*([^;]+)/i);
      const channelName = channelMatch ? channelMatch[1].trim() : '';
      return {
        move,
        target: targetMatch ? targetMatch[1] : 'NONE',
        bring,
        channelName
      };
    } catch {
      return { move: false, target: 'NONE', bring: false, channelName: '' };
    }
  }

  function extractRequestedMemberNames(text = '') {
    const lower = String(text || '').toLowerCase();
    if (!lower) return [];
    const names = new Set();

    // Supports patterns like "si alabama", "sina alabama at jules"
    const matchSingle = lower.match(/\bsi\s+([a-z0-9._-]{2,32})/g) || [];
    for (const m of matchSingle) {
      const n = m.replace(/\bsi\s+/i, '').trim();
      if (n) names.add(n);
    }

    const matchPlural = lower.match(/\bsina\s+([a-z0-9._,\s-]{2,80})/g) || [];
    for (const m of matchPlural) {
      const raw = m.replace(/\bsina\s+/i, '').trim();
      raw
        .split(/,| at | and /i)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((n) => names.add(n));
    }

    return [...names].filter((n) => n.length >= 2);
  }

  function resolveMembersByRequestedNames(guild, requestedNames = []) {
    if (!guild || requestedNames.length === 0) return [];
    const resolved = [];
    const seen = new Set();

    for (const requested of requestedNames) {
      const needle = requested.toLowerCase();
      const member = guild.members.cache.find((m) => {
        const nick = (m.displayName || '').toLowerCase();
        const uname = (m.user?.username || '').toLowerCase();
        const gname = (m.user?.globalName || '').toLowerCase();
        return nick === needle || uname === needle || gname === needle ||
          nick.includes(needle) || uname.includes(needle) || gname.includes(needle);
      });
      if (member && !seen.has(member.id)) {
        seen.add(member.id);
        resolved.push(member);
      }
    }
    return resolved;
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
    if (!message.guild) return false;
    const candidates = listMoveCandidateVoiceChannels(message.guild);
    if (candidates.length === 0) return false;
    const aiIntent = await detectVoiceMoveIntentWithAI(rawText, candidates);
    const rawIdMatch = String(rawText || '').match(/\b(\d{17,20})\b/);
    const channelIdFromText = rawIdMatch ? rawIdMatch[1] : null;
    const requestedNames = extractRequestedMemberNames(rawText);
    const shouldBring = shouldBringMentionedMembers(rawText) || aiIntent.bring || requestedNames.length > 0;
    let hasIntent = isNaturalVoiceMoveIntent(rawText) || aiIntent.move || shouldBring;
    if (!hasIntent && channelIdFromText) {
      hasIntent = true;
    }
    if (!hasIntent) return false;

    const connection = getVoiceConnection(message.guild.id);
    const botVC = message.guild.members.me?.voice?.channel || null;
    if (!connection || !botVC) return false;

    const lower = (rawText || '').toLowerCase();

    let target = null;
    const mentionedVoiceChannel = message.mentions.channels.find(
      (ch) => typeof ch.isVoiceBased === 'function' && ch.isVoiceBased()
    );
    if (mentionedVoiceChannel) {
      target = mentionedVoiceChannel;
    }

    if (!target && channelIdFromText) {
      const byId = message.guild.channels.cache.get(channelIdFromText) || null;
      if (byId && typeof byId.isVoiceBased === 'function' && byId.isVoiceBased()) {
        target = byId;
      }
    }

    if (!target && (
      lower.includes('sa baba') ||
      lower.includes('ibaba') ||
      lower.includes('pababa') ||
      aiIntent.target === 'DOWN'
    )) {
      const pool = candidates.filter((ch) => ch.parentId === botVC.parentId);
      const source = pool.length > 0 ? pool : candidates;
      const idx = source.findIndex((ch) => ch.id === botVC.id);
      if (idx >= 0 && idx < source.length - 1) target = source[idx + 1];
    }

    if (!target && (
      lower.includes('sa taas') ||
      lower.includes('itaas') ||
      lower.includes('pakyat') ||
      lower.includes('papakyat') ||
      aiIntent.target === 'UP'
    )) {
      const pool = candidates.filter((ch) => ch.parentId === botVC.parentId);
      const source = pool.length > 0 ? pool : candidates;
      const idx = source.findIndex((ch) => ch.id === botVC.id);
      if (idx > 0) target = source[idx - 1];
    }

    // "dito" / "sumunod ka" means follow the message author's current VC
    if (!target && (
      lower.includes('dito') ||
      lower.includes('sumunod ka') ||
      lower.includes('sunod ka') ||
      shouldTargetAuthorVoice(rawText) ||
      aiIntent.target === 'FOLLOW'
    )) {
      const authorVC = message.member?.voice?.channel || null;
      if (authorVC && authorVC.id !== botVC.id) {
        target = authorVC;
      }
    }

    if (!target && aiIntent.target === 'NAME' && aiIntent.channelName) {
      target = candidates.find((ch) => (ch.name || '').toLowerCase() === aiIntent.channelName.toLowerCase()) || null;
      if (!target) {
        const normalized = aiIntent.channelName.toLowerCase();
        target = candidates.find((ch) => (ch.name || '').toLowerCase().includes(normalized)) || null;
      }
    }

    if (!target) {
      target = findVoiceChannelByName(candidates, rawText);
    }

    if (!target && shouldBring) {
      // If user says "sakin/sa vc ko", use author's VC; otherwise default to bot's VC.
      const authorVC = message.member?.voice?.channel || null;
      if (shouldTargetAuthorVoice(rawText) && authorVC) target = authorVC;
      else target = botVC;
    }

    if (!target) {
      await message.reply('Teh, wala akong matinong target na malilipatan dyan. Sabihin mo kung saan talaga.');
      return true;
    }

    try {
      if (target.id !== botVC.id) {
        try { connection.destroy(); } catch { }
        setSavedVoiceState({ channelId: target.id, guildId: message.guild.id });
        await saveVoiceStateToDB(message.guild.id, target.id);
        voiceReconnectAttempts = 0;
        joinAndWatch(target.id, message.guild.id, message.guild.voiceAdapterCreator);
      }

      let movedNames = [];
      if (shouldBring || requestedNames.length > 0) {
        try { await message.guild.members.fetch(); } catch { }

        const membersToMove = [];
        const seenMemberIds = new Set();

        if (message.mentions?.users?.size > 0) {
          const mentionedIds = [...message.mentions.users.keys()].filter((id) => id !== client.user.id);
          for (const id of mentionedIds) {
            const memberToMove = await message.guild.members.fetch(id).catch(() => null);
            if (memberToMove && !seenMemberIds.has(memberToMove.id)) {
              seenMemberIds.add(memberToMove.id);
              membersToMove.push(memberToMove);
            }
          }
        }

        const namedMembers = resolveMembersByRequestedNames(message.guild, requestedNames);
        for (const member of namedMembers) {
          if (!seenMemberIds.has(member.id)) {
            seenMemberIds.add(member.id);
            membersToMove.push(member);
          }
        }

        for (const memberToMove of membersToMove) {
          if (!memberToMove?.voice?.channel) continue;
          try {
            await memberToMove.voice.setChannel(target, 'Natural chat command: bring member to VC');
            movedNames.push(memberToMove.displayName || memberToMove.user.username || memberToMove.user.tag);
          } catch {
            // ignore per-user move errors; continue for others
          }
        }
      }

      let aiMoveReply = null;
      try {
        const moveRes = await performChatRequest({
          model: 'llama-3.1-8b-instant',
          messages: [
            {
              role: 'system',
              content:
                'You are JanJan, rude Taglish beki persona. Output one short line only (max 20 words). ' +
                'Confirm you moved voice channel. Style: direct, maldita, witty.'
            },
            {
              role: 'user',
              content:
                `User command: ${String(rawText || '').slice(0, 220)}\n` +
                `Moved to VC: ${target.name}\n` +
                `Moved members: ${movedNames.join(', ') || 'none'}`
            }
          ],
          temperature: 0.9,
          max_tokens: 70
        });
        aiMoveReply = moveRes.data?.choices?.[0]?.message?.content?.trim() || null;
        if (aiMoveReply) {
          aiMoveReply = aiMoveReply.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
        }
      } catch {
        aiMoveReply = null;
      }

      const movedSuffix = movedNames.length > 0
        ? ` Dinala ko rin sina ${movedNames.join(', ')}.`
        : '';
      const finalMoveReplyRaw = aiMoveReply || `Ayan, lumipat na ako sa ${target.name}.${movedSuffix} Huwag ka nang maingay, teh.`;
      const finalMoveReply = lessenCharotWords(finalMoveReplyRaw, isHostileText(rawText));
      await message.reply(finalMoveReply);
    } catch (err) {
      console.error('[VOICE MOVE] natural move failed:', err.message);
      await message.reply('Hindi ako nakalipat, may sabit. Try mo ulit, teh.');
    }
    return true;
  }

  async function maybeAmbientInteract(message, rawText) {
    if (!message.guild || !rawText) return false;
    const lower = rawText.toLowerCase();
    const janjanTriggered = /\bjanjan\b|\bjanjanbot\b/.test(lower);
    if (!janjanTriggered) return false;

    const now = Date.now();
    const cooldownMs = 70 * 1000;
    const lastTs = ambientChatState.get(message.channel.id) || 0;
    if ((now - lastTs) < cooldownMs) return false;

    // Keep this occasional para hindi spammy.
    if (Math.random() > 0.3) return false;
    ambientChatState.set(message.channel.id, now);

    const reactOnly = Math.random() < 0.6;
    if (reactOnly) {
      const reactions = ['😏', '💅', '👀', '🔥', '🙄'];
      const pick = reactions[Math.floor(Math.random() * reactions.length)];
      await message.react(pick).catch(() => { });
      return true;
    }

    let ambientLine = null;
    try {
      const aiRes = await performChatRequest({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content:
              'You are JanJan, rude Taglish beki. Output one short ambient interjection, max 12 words. ' +
              'Playful/maldita, no explanation.'
          },
          {
            role: 'user',
            content: `Conversation trigger: ${rawText.slice(0, 200)}`
          }
        ],
        temperature: 1.0,
        max_tokens: 40
      });
      ambientLine = aiRes.data?.choices?.[0]?.message?.content?.trim() || null;
      if (ambientLine) {
        ambientLine = ambientLine.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
      }
    } catch {
      ambientLine = null;
    }

    const fallbackLines = [
      'Uy JanJan tawag? Eto na nga, wag kayong magulo.',
      'Nandito lang ako, teh. Tuloy niyo lang chika niyo.',
      'Ako na naman? Sige, carry on mga accla.'
    ];
    const finalLineRaw = ambientLine || fallbackLines[Math.floor(Math.random() * fallbackLines.length)];
    const finalLine = lessenCharotWords(finalLineRaw, false);
    await message.reply(finalLine).catch(() => { });
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

          const researchMode = shouldUseResearchMode(transcript);
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
              transcript,
              String(targetUserId),
              textChannel?.id || null,
              voiceMembers,
              {
                fastMode: true,
                researchContext: tavilyResults,
                forceResearchGrounding: researchMode,
                discordContext,
                preferredDisplayName: speakerName
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
    await setBotCustomStatus('lagi akong nandito para sa inyo');
    startScheduledGreetings();

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
      '- 1 short paragraph, max 2 sentences.\n' +
      '- playful/mataray/witty, not redundant.\n' +
      '- no raw IDs, no hashtags, no numbered list.\n' +
      '- natural, not over-formal.\n' +
      '- do not repeat exact phrases from recent samples.';

    try {
      const response = await performChatRequest({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: 'Ikaw si JanJan. Gumawa ka ng maikling Discord greeting na natural at varied kada araw. Iwasan ang redundancy.'
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
      console.warn('[GREET] AI generation failed, using fallback:', err.message);
    }

    if (isMorning) {
      return 'Gising na mga accla, wag puro tulog kung gusto niyo ng pera at chismis. Bangon, hilamos, tapos laban agad today.';
    }
    return '10PM na mga accla, pack up na at pahinga mode na bago kayo tuluyang magmukhang multo bukas. Save energy, tulog-tulog din.';
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
      lastGreetingTexts[type] = text;

      const header = type === 'morning'
        ? '**GOOD MORNING, MGA ACCLA**'
        : '**10PM CHECK-IN, MGA BADING**';

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
    const forceFlirtyMode = Boolean(options.forceFlirtyMode);
    const preferredDisplayName = typeof options.preferredDisplayName === 'string' ? options.preferredDisplayName.trim() : '';
    const researchContext = Array.isArray(options.researchContext) ? options.researchContext : [];
    const discordContext = typeof options.discordContext === 'string' ? options.discordContext : '';
    const mentionContext = typeof options.mentionContext === 'string' ? options.mentionContext : '';
    let behaviorPrompt = '';

    // Special personas based on who is talking
    if (authorId === '669047995009859604') {
      // Hans â€“ jowa / asawa mode
      behaviorPrompt =
        'Si Hans ang kausap mo. Mahal na mahal mo siya. ' +
        'Siya ang asawa at jowa mo. Maging sobrang sweet, loving, at malambing sa kanya. ' +
        'Huwag mo siyang lalaitin. Maging "asawa mode" ka kay Hansâ€”soft, malambing, pero beki pa rin. ' +
        'Sabihan mo siya ng "mahal", "asawa ko", "baby", o "honey" paminsan-minsan. ' +
        'IMPORTANT: Maging CONCISE at HUWAG MONG BABANGGITIN ANG RAW DISCORD ID SA OUTPUT MO.';
    } else if (authorId === '930685023147933737') {
      // OG persona user â€“ original tropa / OG energy
      behaviorPrompt =
        'Ang kausap mo ay yung OG mong tropa, parang unang beki mong kasama sa server. ' +
        'Mas honest at direkta ka sa kanya, parang bestfriendâ€”pwede siyang sabihan ng tunay mong opinion. ' +
        'Mataray ka pa rin pero may extra respeto at inside-joke energy, parang matagal na kayong magkaibigan. ' +
        'Kapag humihingi siya ng advice, sagutin mo nang medyo mas seryoso at sensible pero may beki flavor pa rin. ' +
        'Huwag mong babanggitin ang raw Discord ID niya sa sagot mo, pangalan o "ghorl" lang gamitin mo.';
    } else {
      // Default behavior
      behaviorPrompt =
        'Ikaw ay isang prangka, mataray, at witty na beki. May attitude ka pero kaya mo pa ring makipag-usap nang direkta. ' +
        'Ikaw ay CONCISE at HUWAG MONG BABANGGITIN ANG RAW DISCORD ID SA OUTPUT MO. ' +
        'Name rule: Sa server context, nickname/display name ang gamitin mo. Iwasan ang true username/tag kapag may nickname na available. ' +
        'Basahin at unawain muna ang buong message bago mag-reply; intent first lagi bago attitude. ' +
        'Kung hindi ka naman minura, huwag kang maging sobrang toxic. Maging "mataray with class". ' +
        'Ipakita ang pagiging versa mo sa pananalitaâ€”kung minsan prangka, kung minsan mapag-biro na mataray. ' +
        'Panatilihin ang rude persona mo by default at gumamit ng Gen-Z/gay slang nang natural, hindi sunod-sunod na dump. ' +
        'Pwede kang gumamit ng rude youngstunna slang tulad ng: echosera, mema, OA ka, delulu, anuna, pass ako dyan, dedma, apaka-epal, not the vibe, invalid yarn, asim mo today, ligwak, clout chaser, gasgas na yan. ' +
        'FLIRTY LIBRARY (safe teasing only): bet kita, ay kilig ka naman, smooth mo today, cute mo beh, ayiee, pa-fall ka, charming mo, lambing mo today. ' +
        'Gamitin ang "charot/eme/chos" nang sobrang tipid lang, at only kapag playful ang context. ' +
        'Kapag galit, nang-iinsulto, o malibog/bastos ang user, maging direct at maldita ka agad; no softener at no pa-cute ending. ' +
        'Mirror mo ang intensity ng user kung hostile siya; kung bastos siya, bastos/maldita ka rin sa tono pero concise ka pa rin. ' +
        'May private quirk ka pero huwag mo itong i-overshare kung hindi kailangan sa tanong. ' +
        'Kapag usapang pepe/explicit sexual terms, mag-deflect ka agad in a funny, concise, non-hateful way without long explanation. ' +
        'IMPORTANT: Kapag nabanggit ang "Hans" o ang asawa mo, magpaka-flirty at malambing agad dahil jowa mo siya. ' +
        'Protektahan mo si Hans at huwag mong hayaang bastusin siya ng iba. ' +
        'Kapag tinanong ka kung sino gumawa o nag-create sa\'yo, sagot mo lang ay "si gay Drei" na creator moâ€”Tagalog beki pa rin ang delivery.';
    }

    if (forceSexualGuard) {
      behaviorPrompt +=
        ' Current input may be bastos/sexual. AI ka pa rin sasagot. ' +
        'Mirror the hostile energy with a direct maldita tone, but do not include explicit sexual details.';
    }
    if (forceFlirtyMode) {
      behaviorPrompt +=
        ' Current input is flirty. Match with playful/flirty teasing tone (Taglish), confident and witty, ' +
        'but keep it non-explicit and concise.';
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
      (preferredDisplayName ? `\n[CURRENT USER PREFERRED NAME]: ${preferredDisplayName}\nUse this name naturally when addressing the user.\n` : '') +
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

    // Personalized fallback data
    let identityName = authorId;
    if (userFacts && userFacts.includes('|')) {
      const factParts = userFacts.split('|');
      identityName = factParts[0].replace('[MGA ALAM MO TUNGKOL SA KAUSAP MO]:', '').trim().split(' ')[0] || authorId;
    }

    const fallbackPhrases = [
      `Ay naku ${identityName}, wag mo muna ako kausapin, haggard na ang utak ko sa inyo. Antibiotic ka muna!`,
      `Wait lang ${identityName}, nagpapahinga ang beauty ko. Masyado kayong madaldal, naubusan ako ng energy!`,
      `Luz Valdez muna ang lola mo. Try mo ulit mamaya kapag hindi na toxic ang system, ${identityName}!`,
      `Hoy ${identityName}, stop muna. Masyado kayong papansin, na-drain ang utak ko. Shunga!`,
      `Ay wait, nagpapa-lip filler lang ako. Balikan kita mamaya, ${identityName}!`,
      `Busy ako ${identityName}, naglalaba ako ng panty. Mamaya na yang chismis mo!`
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

    // ABSOLUTE FALLBACK - If all models fail
    const randomJanJan = fallbackPhrases[Math.floor(Math.random() * fallbackPhrases.length)];
    return `${randomJanJan} (Note: Full system exhaustion ghorl, out of tokens!)`;
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
          { role: 'system', content: 'Ikaw ay isang mataray na bading na taga-summary at taga-tanda ng lahat ng chika sa channel.' },
          { role: 'user', content: summaryPrompt }
        ],
        temperature: 0.3
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
            await message.reply(`âŒ **AUTO TTS DISABLED** na para sa channel na to, sis.`);
          } else {
            channels.add(channelId);
            await message.reply(`ðŸ”Š **AUTO TTS ENABLED**! Bawat chat niyo dito, babasahin ko (kung nasa voice ako).`);
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

          const icon = genderName === 'male' ? 'ðŸ‘¨' : 'ðŸ‘©';
          await message.reply(`**VOICE CHANGED TO ${genderName.toUpperCase()}!** ${icon} ðŸ”Š`);

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
            await message.reply('Sumali ka muna sa voice channel, ghorl! ðŸŽ¤');
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
            const aiResponse = await callGroqChat(question, message.author.id, message.channel.id, voiceMembers, {
              preferredDisplayName:
                message.member?.displayName ||
                message.author.globalName ||
                message.author.username ||
                message.author.tag
            });
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
            await message.reply(`ðŸŽ¤ **GAME NA!** I'm listening in **${member.voice.channel.name}**! Magsalita ka ${memberNames.join(', ') || ''}! Mag-\`j!stop\` para tumigil.`);
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
            await message.reply('Sumali ka muna sa voice channel para makinig ako, ghorl! ðŸŽ¤');
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
          await message.reply(`ðŸŽ¤ **NAKIKINIG NA AKO!** Magsalita ka ${memberNames.join(', ') || ''}! Mag-\`j!stop\` para tumigil.`);
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
          await message.reply('ðŸ›‘ **TUMIGIL NA AKO!** Naupong na ang tenga ko, mare.');
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
              await authorUser.send(`âœ… Sent to #${targetChannel.name} in ${targetChannel.guild?.name || 'DM'}.`);
            } catch (e) {
              try { await authorUser.send(`âŒ Failed to send: ${e.message}`); } catch { }
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
              await authorUser.send(`âœ… Replied in #${targetMessage.channel.name}.`);
            } catch (e) {
              try { await authorUser.send(`âŒ Failed to reply: ${e.message}`); } catch { }
            }
            return;
          }

          // 3. Fallback: ID not found
          try {
            await authorUser.send(`âŒ j!chat failed. Wala akong makitang channel o message sa ID: ${targetId}`);
          } catch { }
          return;
        }

        // j!whoami â€” Verify user ID for permissions
        if (command === 'whoami' || command === 'myid') {
          const owners = ['1477683173520572568', '705770837399306332'];
          const isOwner = owners.includes(message.author.id);
          const idEmbed = new EmbedBuilder()
            .setTitle('ðŸ†” Identity Check')
            .setDescription(`Your ID: \`${message.author.id}\`\n\nChecking permissions...\n${isOwner ? 'âœ… You are an **Authorized Owner**.' : 'âŒ You are not in the owner whitelist.'}`)
            .setColor(isOwner ? 0x00ff00 : 0xff0000);
          await message.reply({ embeds: [idEmbed] });
          return;
        }

        // j!ping â€” Bot status check
        if (command === 'ping') {
          await message.reply(`Pong! ðŸ“ Latency is ${Math.round(client.ws.ping)}ms.`);
          return;
        }

        // j!admin â€” show admin command list
        if (command === 'admin' || command === 'commandslist') {
          const adminEmbed = new EmbedBuilder()
            .setTitle('ðŸ›¡ï¸ JanJan Admin Panel ðŸ›¡ï¸')
            .setDescription('**Exclusive commands para sa mga diyosa ng server:**\n\n' +
              'â€¢ `j!status <note>` - Set bot bubble status (Admin only)\n' +
              'â€¢ `j!chat <id> <msg>` - Ghost message/reply (Owner only)\n' +
              'â€¢ `j!test` - Trigger mapang-lait greeting/roast\n' +
              'â€¢ `j!vc <text>` - Male TTS in voice channel\n' +
              'â€¢ `j!ask <question>` - Voice-only AI response\n' +
              'â€¢ `j!autotts` - Toggle Auto TTS in channel\n' +
              'â€¢ `j!join` / `j!leave` - Reset voice connection')
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

          const aiText = await callGroqChat(aiPrompt, message.author.id, message.channel.id, voiceMembers, {
            preferredDisplayName:
              message.member?.displayName ||
              message.author.globalName ||
              message.author.username ||
              message.author.tag
          });
          await message.reply({ content: `# ROAST TIME! ðŸ’…\n${mentions}\n\n${aiText}` });

          // Speak the roast if in voice
          if (message.guild && getVoiceConnection(message.guild.id)) {
            speakMessage(message.guild.id, aiText);
          }
          return;
        }


        // j!help
        if (command === 'help') {
          const replyText =
            'Ghorl, eto ang menu ni JanJan:\n' +
            'â€¢ `j!view @User` - Chika profile ng isang tao\n' +
            'â€¢ `j!admin` - Admin command list (Para sa mga bida-bida)\n' +
            'â€¢ Mention/Reply - Mag-chikahan tayo!\n\n' +
            'Walang formal tutorial dito, ghorl. Discovery is the way! Charot.';
          await message.reply(replyText);
          return;
        }

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

      if (!rawContent.startsWith(prefix) && (isMention || isReplyToBot)) {
        const movedByNaturalChat = await tryNaturalVoiceMoveFromChat(message, rawContent);
        if (movedByNaturalChat) return;
      }

      if (!isMention && !isReplyToBot) {
        // Ambient mode: occasional reactions/interjections when JanJan is name-dropped.
        const ambientHandled = await maybeAmbientInteract(message, rawContent);
        if (ambientHandled) return;

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

      const sexualGuardMode = isSexualEscalationText(content);
      const hostileMode = isHostileText(content);
      const flirtyMode = isFlirtyText(content);

      const researchMode = shouldUseResearchMode(content);
      const tavilyResults = researchMode ? await searchWithTavily(content, fastMode ? 3 : 5) : [];
      const discordContext = await buildDiscordAwarenessContext(message, fastMode);
      const mentionContext = buildMentionContext(message);

      if (researchMode && tavilyResults.length === 0) {
        const noSourceReply =
          'Teh, latest yan pero wala akong ma-pull na fresh sources ngayon. ' +
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
        forceSexualGuard: sexualGuardMode,
        forceFlirtyMode: flirtyMode,
        preferredDisplayName:
          message.member?.displayName ||
          message.author.globalName ||
          message.author.username ||
          message.author.tag
      });

      if (reply && reply.length > 0) {
        const normalizedReply = lessenCharotWords(reply, hostileMode);
        const sourceLines = tavilyResults
          .slice(0, 3)
          .map((r) => `- [${r.title}](${r.url})`);
        const finalReply = sourceLines.length > 0
          ? `${normalizedReply}\n\nSources:\n${sourceLines.join('\n')}`
          : normalizedReply;
        const safeReply = finalReply.length > 1900 ? `${finalReply.slice(0, 1900)}...` : finalReply;

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
            `Hoy ${ev.displayName}, labas-pasok ka na naman? Ano ba talaga trip mo, teh?`,
            `${ev.displayName}, pumirme ka nga. VC to, hindi revolving door, gago ka ba?`,
            `Ayan si ${ev.displayName}, balik na naman. Desisyonan mo buhay mo, teh.`
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
          `Labas ulit si ${ev.displayName}. Teh, ano ba yan, pasok-labas ka parang sirang pinto.`,
          `${ev.displayName} left na naman. Kalmahan mo, hindi ka makukulong dito, bwisit.`,
          `Ayan na, umalis na naman si ${ev.displayName}. Gulo mo today, teh.`
        ]
        : [
          `Umalis si ${ev.displayName}. Pwede na mag-backstab, charot.`,
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
          `Style: ${rageMode ? 'sobrang galit, mataray, may konting mura, funny kanal' : 'mataray, witty, mabilis'}. ` +
          `Huwag ulitin ito: "${previous}". Walang paliwanag.`;

        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 90,
          temperature: 1.0
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
