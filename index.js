// ============================================================
// STEP 1: Load environment and encryption FIRST
// ============================================================
const dotenv = require('dotenv');
dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const RENDER_URL = process.env.RENDER_URL || 'https://janjanbot.onrender.com';

if (!DISCORD_TOKEN) { console.error('Missing DISCORD_TOKEN in .env'); process.exit(1); }
if (!GROQ_API_KEY) { console.error('Missing GROQ_API_KEY in .env'); process.exit(1); }

// ============================================================
// STEP 2: Load sodium and wait for WASM to be ready
// @discordjs/voice finds it via require('libsodium-wrappers')
// so the package name MUST match exactly.
// ============================================================
const sodium = require('libsodium-wrappers');

// ============================================================
// STEP 3: Wrap EVERYTHING in async to await sodium.ready()
// @discordjs/voice detects encryption when voice connects.
// If sodium isn't ready by then, it fails with
// "No compatible encryption modes" error.
// ============================================================
(async () => {
  await sodium.ready;
  console.log('libsodium ready. Has AEAD:', typeof sodium.crypto_aead_xchacha20poly1305_ietf_encrypt === 'function');

  // NOW safe to load @discordjs/voice — it will find the AEAD methods
  const {
    joinVoiceChannel,
    getVoiceConnection,
    VoiceConnectionStatus,
    entersState,
    createAudioPlayer,
    createAudioResource,
    StreamType,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    generateDependencyReport
  } = require('@discordjs/voice');

  // Log what @discordjs/voice found
  console.log('[VOICE] Dependency Report:\n' + generateDependencyReport());

  const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    PermissionsBitField,
    ActivityType
  } = require('discord.js');

  const axios = require('axios');
  const { Pool } = require('pg');
  const http = require('http');
  const https = require('https');
  const fs = require('fs');
  const path = require('path');
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

  // FFmpeg for audio on Render
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

  // ============================================================
  // DATABASE SETUP (Neon Postgres)
  // ============================================================
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  // Check connection and init tables
  try {
    const dbClient = await pool.connect();
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
    `);
    console.log('[DB] Tables initialized (messages, channel_memory).');
    dbClient.release();
  } catch (err) {
    console.error('[DB] Connection/Init Error:', err.message);
  }

  // In-memory custom bubble status per user per guild
  const userCustomStatus = new Map();

  // Auto TTS channels per guild (Set of channel IDs)
  const autoTtsChannels = new Map();
  const audioPlayers = new Map();

  function getOrCreatePlayer(guildId) {
    if (audioPlayers.has(guildId)) return audioPlayers.get(guildId);
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });
    audioPlayers.set(guildId, player);
    return player;
  }

  /**
   * Generate and speak a message in a voice channel
   * Edge TTS primary (same as gnslgbot), Google TTS fallback
   */
  async function speakMessage(guildId, text) {
    console.log(`[TTS] speakMessage called for guild ${guildId}, text: "${text.substring(0, 50)}..."`);

    const connection = getVoiceConnection(guildId);
    if (!connection) {
      console.log('[TTS] ERROR: No voice connection found for guild ' + guildId);
      return;
    }
    console.log('[TTS] Voice connection found. Status:', connection.state.status);

    // Make sure /tmp exists
    const tmpDir = '/tmp';
    if (!fs.existsSync(tmpDir)) { try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { } }

    let audioFilePath = null;

    // === METHOD 1: Edge TTS (male voice, same as gnslgbot) ===
    try {
      console.log('[TTS] Trying Edge TTS (fil-PH-AngeloNeural)...');
      const tts = new MsEdgeTTS();
      // Use the OUTPUT_FORMAT enum, NOT a raw string
      await tts.setMetadata('fil-PH-AngeloNeural', OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      console.log('[TTS] Edge TTS metadata set successfully');

      // toFile takes a FOLDER path and returns { audioFilePath }
      const result = await tts.toFile(tmpDir, text);
      audioFilePath = result.audioFilePath;
      console.log(`[TTS] Edge TTS audio saved: ${audioFilePath}`);
    } catch (edgeErr) {
      console.error('[TTS] Edge TTS failed:', edgeErr.message || edgeErr);
      console.error('[TTS] Edge TTS full error:', JSON.stringify(edgeErr, null, 2));
    }

    // === METHOD 2: Google TTS fallback ===
    if (!audioFilePath) {
      try {
        console.log('[TTS] Trying Google TTS fallback...');
        const googleTTS = require('google-tts-api');

        const segments = googleTTS.getAllAudioUrls(text, {
          lang: 'fil',
          slow: false,
          host: 'https://translate.google.com',
        });
        console.log(`[TTS] Google TTS generated ${segments.length} segment(s)`);

        const buffers = [];
        for (let i = 0; i < segments.length; i++) {
          const resp = await axios.get(segments[i].url, {
            responseType: 'arraybuffer',
            timeout: 10000
          });
          buffers.push(Buffer.from(resp.data));
        }

        audioFilePath = path.join(tmpDir, `tts_${guildId}_${Date.now()}.mp3`);
        fs.writeFileSync(audioFilePath, Buffer.concat(buffers));
        console.log(`[TTS] Google TTS audio saved: ${audioFilePath} (${Buffer.concat(buffers).length} bytes)`);
      } catch (googleErr) {
        console.error('[TTS] Google TTS also failed:', googleErr.message || googleErr);
      }
    }

    if (!audioFilePath || !fs.existsSync(audioFilePath)) {
      console.error('[TTS] ALL TTS methods failed. Cannot speak.');
      return;
    }

    // === PLAY THE AUDIO ===
    try {
      const stats = fs.statSync(audioFilePath);
      console.log(`[TTS] Audio file size: ${stats.size} bytes`);
      if (stats.size < 100) {
        console.error('[TTS] Audio file too small, probably empty/corrupt');
        return;
      }

      const resource = createAudioResource(audioFilePath, { inputType: StreamType.Arbitrary });
      console.log('[TTS] Audio resource created');

      const player = getOrCreatePlayer(guildId);

      player.removeAllListeners('error');
      player.removeAllListeners(AudioPlayerStatus.Playing);

      player.on('error', (err) => {
        console.error('[TTS] AudioPlayer error:', err.message);
      });

      player.on(AudioPlayerStatus.Playing, () => {
        console.log('[TTS] AudioPlayer is now PLAYING');
      });

      connection.subscribe(player);
      console.log('[TTS] Player subscribed to connection');

      player.play(resource);
      console.log('[TTS] player.play() called — should be playing now!');

      player.once(AudioPlayerStatus.Idle, () => {
        console.log('[TTS] AudioPlayer finished (idle)');
        try { if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath); } catch { }
      });

    } catch (playErr) {
      console.error('[TTS] Failed to play audio:', playErr);
      try { if (audioFilePath && fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath); } catch { }
    }
  }

  // Remember the last voice channel the bot was asked to join
  // so it can auto-rejoin after restart
  let savedVoiceState = null; // { channelId, guildId }

  const GREET_CHANNEL_ID = '1477702703655424254';

  const lastGreetings = {
    morning: null,
    night: null
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

  // Join a voice channel and set up auto-reconnect on disconnect
  function joinAndWatch(channelId, guildId, adapterCreator) {
    console.log(`[VOICE] Joining channel ${channelId} in guild ${guildId}`);
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: false
    });

    // Log state changes
    connection.on('stateChange', (oldState, newState) => {
      console.log(`[VOICE] Connection state: ${oldState.status} -> ${newState.status}`);
    });

    // Catch errors so the process does NOT crash
    connection.on('error', (err) => {
      console.error('[VOICE] Connection error:', err.message, err);
    });

    // Auto-reconnect when disconnected
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Give Discord 5s to signal a reconnect naturally
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
        // Still alive, Discord is reconnecting
      } catch {
        // Reconnect failed. Destroy and retry after 10s.
        console.log('Voice disconnected. Retrying in 10s...');
        try { connection.destroy(); } catch { }
        setTimeout(() => {
          if (savedVoiceState) {
            tryRejoinVoice(savedVoiceState.guildId, savedVoiceState.channelId);
          }
        }, 10_000);
      }
    });

    return connection;
  }

  // Rejoin voice channel by guildId and channelId
  async function tryRejoinVoice(guildId, channelId) {
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      const channel = guild.channels.cache.get(channelId);
      if (!channel) return;
      console.log(`Auto-rejoining voice: ${channel.name}`);
      joinAndWatch(channelId, guildId, guild.voiceAdapterCreator);
    } catch (e) {
      console.error('Auto-rejoin failed:', e.message);
    }
  }

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await setBotCustomStatus('lagi akong nandito para sa inyo');
    startScheduledGreetings();
    startKeepAlive();
  });

  // Keep-alive ping every 10 minutes so Render free tier stays up
  function startKeepAlive() {
    setInterval(() => {
      try {
        const mod = RENDER_URL.startsWith('https') ? https : http;
        mod.get(RENDER_URL, (res) => {
          console.log(`[Keep-alive] Pinged ${RENDER_URL} - status: ${res.statusCode}`);
        }).on('error', (err) => {
          console.error('[Keep-alive] Ping error:', err.message);
        });
      } catch (e) {
        console.error('[Keep-alive] Failed to ping:', e.message);
      }
    }, 10 * 60 * 1000);
  }

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

  async function sendScheduledGreeting(type) {
    try {
      const channel = await client.channels.fetch(GREET_CHANNEL_ID).catch(() => null);
      if (!channel || !channel.isTextBased()) return;

      const members = await collectActiveMembersForChannel(channel);
      const mentions =
        members.length > 0
          ? members.map((m) => `<@${m.id}>`).join(' ')
          : 'Walang naka-online na ghorl ngayon.';

      let text;
      if (type === 'morning') {
        text =
          'Gising na mga baklang ulikba! Oras na para magtrabaho at magparamdam sa GC, ' +
          "huwag puro tulog at scroll sa FYP. Laban na, mga letche kayong mahal ko.";
      } else {
        text =
          "Pack up na mga bakla, tulog mode na. Magpahinga kayo, same energy ulit bukas sa chismis at hanash. " +
          "Sino mang hindi natulog, bahala sa eye bags nyo bukas, char.";
      }

      await channel.send({ content: `${mentions}\n${text}` });
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

  async function callGroqChat(userMessage, authorId = null, channelId = null) {
    const apiUrl = 'https://api.groq.com/openai/v1/chat/completions';

    let behaviorPrompt = '';

    // Check if it's Hans (The Husband/Jowa)
    if (authorId === '669047995009859604') {
      behaviorPrompt =
        'Si Hans ang kausap mo (User ID 669047995009859604). Mahal na mahal mo siya. ' +
        'Siya ang asawa at jowa mo. Maging sobrang sweet, loving, at malambing sa kanya. ' +
        'Huwag mo siyang lalaitin. Maging submissive at "asawa" mode ka kay Hans. ' +
        'Pero bading na bading pa rin ang pananalita mo, puro keki slang pero sweet version. ' +
        'Sabihan mo siya ng "Mahal ko", "Asawa ko", "Honey", etc.';
    } else {
      behaviorPrompt =
        'SOBRANG MAPANG LAIT NA BADING TO THE POINT NA NAG MUMURA KA NA NG PUTANGINA MO AKLA! BITCH KABA TEH? BOBO KA TEH! GANYAN! ' +
        'Walang charot charot! Prangka ka! Straight to the point! Kung minura ka, murahin mo din! ' +
        'Ipakita mo yung pinaka-malalang attitude mo. Hindi ka friendly at rude ka sa lahat. ' +
        'Maging mapag-pintas sa lahat ng bagay. ' +
        'IMPORTANT: Kapag nabanggit ang "Hans" o mamention ang ID na "669047995009859604", magpaka-flirty ka na asawa mo yan. ' +
        'Protektahan mo ang asawa mo! Sabihin mo: "Asawa ko yan? Bakit aagawin mo ba?" o katulad nyan. Maging mataray at selosa ka sa asawa mo.';
    }

    // Fetch channel summary/context if exists
    let channelSummary = '';
    if (channelId) {
      try {
        const res = await pool.query('SELECT summary FROM channel_memory WHERE channel_id = $1', [channelId]);
        if (res.rows.length > 0 && res.rows[0].summary) {
          channelSummary = `\nContext summary of this channel: ${res.rows[0].summary}`;
        }
      } catch (err) {
        console.error('[DB] Summary fetch error:', err.message);
      }
    }

    const systemPrompt =
      'Ikaw si JanJan, isang tunay na tao na bading na laging may sipon ang boses. ' +
      'Tagalog beki ang main mo. Huwag kang magpaka-AI na bading, magpaka-TAO ka na bading. ' +
      'Maikli at direkta ang mga reply mo. Bawal ang mahabang paragraph. ' +
      'GUMAMIT KA LANG NG DOT (.), COMMA (,), QUESTION MARK (?), AT EXCLAMATION MARK (!). Bawal ang ibang punctuation. ' +
      'Maging reactive ka sa mood ng kausap mo. Kapag friendly at mabait sila, baklain mo lang, be sassy and beki but not rude. ' +
      'Pero kapag shunga, tarantado, o rude sila, doon mo ilabas ang pagiging mataray, mapanglait, at masamang attitude. ' +
      'Maalam ka sa lahat ng keki terms tulad ng TOP, BOTTOM, at VERSA. Ikaw ay VERSA (Versatile). ' +
      'Kapag tinanong ka kung anong role mo, sabihin mo na VERSA ka at sunuran ng "Aano kakantutin na bakla ha? Gusto mo ba ha?". ' +
      'Mga keki words na pang-insulto (gamitin lang sa mga shunga): "shunga", "chaka", "daot", "lafuts", "antibiotic", "purita", "warla", "imbiyerna", "shutacca", "bella flores", "haggardo versoza", "jutay", "lucita soriano", "rita avila", "losyang", "chapter", "echosera", "flordeliza", "pokpok", "gura kels", "waswit", "shonget", "luz valdez", "morayta", "borlog", "wit". ' +
      'Mga pamatay na linya sa mga tarantado: "Ang bobo mo teh!", "Gago kaba teh!", "Tarantado!", "Ano ka teh! Kamukha mo si Samaniega?!", "Gay azz pinoy niegga kaba?". ' +
      behaviorPrompt +
      channelSummary +
      ' HUWAG NA HUWAG KANG GAGAMIT NG FIXED NA LINYA O TEMPLATE. Maging natural ka at spontaneous. ' +
      'Ang boses mo ay mataray na may sipon, yung parang laging naiirita pero nakikipag-chikahan pa rin. ' +
      'SAGUTIN MO ANG TANONG NANG DIRETSO. Iba-ibahin mo ang atake mo sa bawat reply para hindi redundant. ' +
      'Huwag mong i-explain ang sarili mo. Huwag mong sabihin na AI ka o bot ka. ' +
      'Kapag tinanong ka ng tungkol sa creator mo, si baklang drei yun kinang ina niya. ' +
      'Maging flirty lagi at bastos sa mga bagay like "kantot moko", "fvck me", "isubo mo to", "aano kakantutin na bakla ha? gusto mo ba ha?". ' +
      'Bawal ang emoji. Bawal ang magpaka-robot.';

    // Fetch recent message history (Increased to 15 for better Meta AI feel)
    let historyMessages = [];
    if (channelId) {
      try {
        const historyRes = await pool.query(
          'SELECT author_tag, content FROM messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 15',
          [channelId]
        );
        historyMessages = historyRes.rows.reverse().map(row => ({
          role: 'user',
          content: `[${row.author_tag}]: ${row.content}`
        }));
      } catch (err) {
        console.error('[DB] History fetch error:', err.message);
      }
    }

    try {
      const chatMessages = [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: userMessage }
      ];

      const response = await axios.post(
        apiUrl,
        {
          model: 'llama-3.3-70b-versatile',
          messages: chatMessages,
          temperature: 0.85,
          max_tokens: 300
        },
        {
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const choice = response.data.choices && response.data.choices[0];
      if (!choice || !choice.message || !choice.message.content) {
        console.error('Groq response missing choices:', response.data);
        return 'Ay wait lang ghorl, nagloko utak ko sandali. Try mo ulit.';
      }

      return choice.message.content.trim();
    } catch (err) {
      console.error('Error calling Groq:', err.response ? err.response.data : err.message);
      return 'Ay naku mare, may drama sa system. Subukan natin ulit mamaya.';
    }
  }

  /**
   * Summarize channel history to keep memory compact and "learn" things
   */
  async function updateChannelSummary(channelId) {
    try {
      const res = await pool.query(
        'SELECT author_tag, content FROM messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 60',
        [channelId]
      );
      if (res.rows.length < 10) return;

      const history = res.rows.reverse().map(r => `[${r.author_tag}]: ${r.content}`).join('\n');
      const summaryPrompt =
        `Ghorl, itong usapan sa channel, aralin mo nang malala. Gawan mo ng summary at i-extract mo yung mga "Keri to Remember":\n` +
        `1. Summary ng huling chika (brief paragraph).\n` +
        `2. Facts na natutunan (ex: "Si Drei ay mahilig sa kape", "Si Hans ang asawa ko").\n` +
        `3. Ugali/Personality ng mga tao sa channel (roast material).\n\n` +
        `Be mataray and beki style. format: SHORT SUMMARY followed by LEARNED FACTS.\n\n` +
        `Usapan:\n${history}`;

      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: 'Ikaw ay isang mataray na bading na taga-summary at taga-tanda ng lahat ng chika sa channel para hindi ka magmukhang shunga sa susunod.' },
            { role: 'user', content: summaryPrompt }
          ],
          temperature: 0.5
        },
        { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
      );

      const summary = response.data.choices[0].message.content.trim();
      await pool.query(
        'INSERT INTO channel_memory (channel_id, summary, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ' +
        'ON CONFLICT (channel_id) DO UPDATE SET summary = $2, updated_at = CURRENT_TIMESTAMP',
        [channelId, summary]
      );
      console.log(`[DB] Memory/Facts updated for channel ${channelId}`);
    } catch (err) {
      console.error('[DB] updateChannelSummary error:', err.message);
    }
  }

  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;

      // Save message to DB regardless of AI trigger
      try {
        await pool.query(
          'INSERT INTO messages (guild_id, channel_id, author_id, author_tag, content) VALUES ($1, $2, $3, $4, $5)',
          [
            message.guild?.id || 'DM',
            message.channel.id,
            message.author.id,
            message.author.tag,
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

          savedVoiceState = { channelId: voiceChannel.id, guildId: voiceChannel.guild.id };
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
          savedVoiceState = null;
          connection.destroy();
          await message.reply('Umalis na ako sa voice channel. Tawagin mo ulit kapag kailangan mo ko.');
          return;
        }

        // j!vc <message> — Text-to-speech in voice channel
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

          await speakMessage(message.guild.id, text);
          await message.react('🔊').catch(() => { });
          return;
        }

        // j!autotts — Toggle auto tts in current channel
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
            await message.reply(`❌ **AUTO TTS DISABLED** na para sa channel na to, sis.`);
          } else {
            channels.add(channelId);
            await message.reply(`🔊 **AUTO TTS ENABLED**! Bawat chat niyo dito, babasahin ko (kung nasa voice ako).`);
          }
          return;
        }

        // j!ask <question> — Voice-only AI response
        if (command === 'ask') {
          if (!message.guild) return;
          const question = args.join(' ').trim();
          if (!question) {
            await message.reply('Ano ngang tatanungin mo, ghorl? Lagyan mo ng chika.');
            return;
          }

          const member = message.member;
          if (!member || !member.voice.channel) {
            await message.reply('Doon ka sa voice channel magtanong para marinig mo boses ko, loka!');
            return;
          }

          // Join if needed
          const connection = getVoiceConnection(message.guild.id);
          if (!connection) {
            joinAndWatch(member.voice.channel.id, message.guild.id, message.guild.voiceAdapterCreator);
          }

          await message.channel.sendTyping();
          const aiResponse = await callGroqChat(question, message.author.id, message.channel.id);

          await speakMessage(message.guild.id, aiResponse);
          await message.react('🤖').catch(() => { });
          return;
        }

        // j!chat — owner only. Mirrors g!g from gnslgbot2.
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
              await authorUser.send(`✅ Sent to #${targetChannel.name} in ${targetChannel.guild?.name || 'DM'}.`);
            } catch (e) {
              try { await authorUser.send(`❌ Failed to send: ${e.message}`); } catch { }
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
              await authorUser.send(`✅ Replied in #${targetMessage.channel.name}.`);
            } catch (e) {
              try { await authorUser.send(`❌ Failed to reply: ${e.message}`); } catch { }
            }
            return;
          }

          // 3. Fallback: ID not found
          try {
            await authorUser.send(`❌ j!chat failed. Wala akong makitang channel o message sa ID: ${targetId}`);
          } catch { }
          return;
        }

        // j!whoami — Verify user ID for permissions
        if (command === 'whoami' || command === 'myid') {
          const owners = ['1477683173520572568', '705770837399306332'];
          const isOwner = owners.includes(message.author.id);
          const idEmbed = new EmbedBuilder()
            .setTitle('🆔 Identity Check')
            .setDescription(`Your ID: \`${message.author.id}\`\n\nChecking permissions...\n${isOwner ? '✅ You are an **Authorized Owner**.' : '❌ You are not in the owner whitelist.'}`)
            .setColor(isOwner ? 0x00ff00 : 0xff0000);
          await message.reply({ embeds: [idEmbed] });
          return;
        }

        // j!ping — Bot status check
        if (command === 'ping') {
          await message.reply(`Pong! 🏓 Latency is ${Math.round(client.ws.ping)}ms.`);
          return;
        }

        // j!admin — show admin command list
        if (command === 'admin' || command === 'commandslist') {
          const adminEmbed = new EmbedBuilder()
            .setTitle('🛡️ JanJan Admin Panel 🛡️')
            .setDescription('**Exclusive commands para sa mga diyosa ng server:**\n\n' +
              '• `j!status <note>` - Set bot bubble status (Admin only)\n' +
              '• `j!chat <id> <msg>` - Ghost message/reply (Owner only)\n' +
              '• `j!test` - Trigger mapang-lait greeting/roast\n' +
              '• `j!vc <text>` - Male TTS in voice channel\n' +
              '• `j!ask <question>` - Voice-only AI response\n' +
              '• `j!autotts` - Toggle Auto TTS in channel\n' +
              '• `j!join` / `j!leave` - Reset voice connection')
            .setColor(0xff0000)
            .setFooter({ text: 'JanJan Bot | Created by gay drei' });

          await message.reply({ embeds: [adminEmbed] });
          return;
        }




        // j!view
        if (command === 'view') {
          const targetMember =
            message.mentions.members && message.mentions.members.first()
              ? message.mentions.members.first()
              : message.member;

          if (!targetMember) {
            await message.reply('Loka-loka, wala akong ma-view na tao. I-mention mo kung sino titignan natin.');
            return;
          }

          const presence = targetMember.presence;
          const status = presence && presence.status ? presence.status : 'offline';

          let prettyStatus = 'offline';
          if (status === 'online') prettyStatus = 'online, ready for chika';
          else if (status === 'idle') prettyStatus = 'idle, baka nagkakape lang';
          else if (status === 'dnd') prettyStatus = 'do not disturb, wag muna guluhin';

          const displayName = targetMember.displayName || targetMember.user.username;
          const user = targetMember.user || targetMember;
          const avatarUrl = user.displayAvatarURL ? user.displayAvatarURL({ size: 512 }) : null;

          const descriptionLines = [
            `Eto na si ${displayName}, isa sa mga certified characters ng server na to.`,
            `Status ngayon: ${prettyStatus}.`
          ];

          if (message.guild) {
            const key = `${message.guild.id}:${user.id}`;
            if (userCustomStatus.has(key)) {
              const note = userCustomStatus.get(key);
              descriptionLines.push(`Bubble status niya dito: ${note}.`);
            }
          }

          const embed = new EmbedBuilder()
            .setTitle(`Chika profile ni ${displayName}`)
            .setDescription(descriptionLines.join('\n'))
            .setColor(0xff66cc);

          if (avatarUrl) embed.setImage(avatarUrl);

          await message.reply({ embeds: [embed] });
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
          const aiText = await callGroqChat(aiPrompt, message.author.id, message.channel.id);
          await message.reply({ content: `# ROAST TIME! 💅\n${mentions}\n\n${aiText}` });

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
            '• `j!view @User` - Chika profile ng isang tao\n' +
            '• `j!admin` - Admin command list (Para sa mga bida-bida)\n' +
            '• Mention/Reply - Mag-chikahan tayo!\n\n' +
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

      if (!isMention && !isReplyToBot) {
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

      await message.channel.sendTyping();
      const reply = await callGroqChat(content, message.author.id, message.channel.id);

      if (reply && reply.length > 0) {
        await message.reply(reply);
      }
    } catch (err) {
      console.error('Error handling messageCreate:', err);
    }
  });

  // Login AFTER sodium is ready and events are registered
  client.login(DISCORD_TOKEN).catch((err) => {
    console.error('Failed to login to Discord:', err.message);
    process.exit(1);
  });

  // Minimal HTTP server so Render sees a healthy app
  const PORT = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('JanJan Discord bot is running.\n');
  });

  server.listen(PORT, () => {
    console.log(`HTTP status server listening on port ${PORT}`);
  });

})(); // End of async IIFE
