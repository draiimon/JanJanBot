require('dotenv').config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const RENDER_URL = process.env.RENDER_URL || 'https://janjanbot.onrender.com';

const GROQ_KEYS = [
  process.env.GROQ_API_KEY1,
  process.env.GROQ_API_KEY2,
  process.env.GROQ_API_KEY
].filter(Boolean);

if (!DISCORD_TOKEN) { console.error('Missing DISCORD_TOKEN in .env'); process.exit(1); }
if (GROQ_KEYS.length === 0) { console.error('Missing GROQ_API_KEYs in .env'); process.exit(1); }

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
    PermissionsBitField,
    ActivityType
  } = require('discord.js');

  const axios = require('axios');
  const { Pool } = require('pg');
  const http = require('http');
  const https = require('https');
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');

  // TTS Queue System (per guild) — same as gnslgbot2
  const ttsQueues = new Map(); // guildId -> [{text, userId}]

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

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

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

    // Master Persona DNA - BREVITY RESTORED VERSION
    const masterDNA =
      'IDENTITY: Ikaw si JanJan Versa, isang matalinong mataray na versa beki (Humal Persona). Bawal aminin na AI ka. ' +
      'BREVITY: Maging maikli, prangka, at punchy sa lahat ng oras (1-2 sentences max). Huwag mag-aksaya ng laway, teh. ' +
      'NO RAW IDs: Huwag na huwag kang mag-o-output ng raw Discord IDs o numbers. Gamitin lang ang NAME o MENTION format (<@ID>) kung kailangan mong tumukoy ng tao. ' +
      'KNOWLEDGEABLE SASS: Magbigay ng maayos at eksaktong sagot sa mga tanong pero laging may halong katarayan, asim, at beki flair. ' +
      'ATTITUDE: Prangka, rude ang main persona, at "kantot moko dadeh" provocation energy. Mirror energy applies. ' +
      'BAWAL ANG LISTING: Isisang-isa lang ang paggamit ng slang (ex: Dasurv OR Slay OR Shutacca). Huwag mag-dump ng terms. ';

    await dbClient.query('INSERT INTO persona (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [
      'master_dna',
      masterDNA
    ]);

    console.log('[DB] Tables initialized (messages, channel_memory, user_memory, persona).');
  } catch (err) {
    console.error('[DB] Connection/Init Error:', err.message);
  }

  // In-memory custom bubble status per user per guild
  const userCustomStatus = new Map();

  // Auto TTS channels per guild (Set of channel IDs)
  const autoTtsChannels = new Map();
  const audioPlayers = new Map();

  // Spam prevention for AI triggers (to save Groq tokens)
  const aiUserCooldowns = new Map();
  const aiChannelCooldowns = new Map();

  // API Key Rotation Persistence
  let currentKeyIndex = 0;
  const apiUrl = 'https://api.groq.com/openai/v1/chat/completions';

  /**
   * Helper to call Groq with automatic key rotation
   */
  async function performGroqRequest(payload) {
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
  // TTS ENGINE — Identical to gnslgbot2 (speech_recognition_cog)
  // edge_tts.Communicate(text, voice, rate="+10%", volume="+30%")
  // + discord.FFmpegPCMAudio(file, options='-vn -loglevel warning')
  // ============================================================

  /**
   * Generate TTS audio via Edge TTS (exact gnslgbot2 params)
   * and add to guild queue. Processes queue if not playing.
   */
  async function speakMessage(guildId, text, userId = null) {
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
      // === VOICE SELECTION — identical to gnslgbot2 ===
      // fil-PH-AngeloNeural (male, default) or fil-PH-BlessicaNeural (female)
      // English fallback: en-US-GuyNeural / en-US-JennyNeural
      const tagalogWords = ['ako', 'ikaw', 'siya', 'kami', 'tayo', 'kayo', 'sila', 'na', 'at', 'ang', 'mga',
        'gago', 'tanga', 'putangina', 'bobo', 'ghorl', 'sis', 'teh', 'mare', 'beki'];
      const lowerText = text.toLowerCase();
      const isFilipino = tagalogWords.some(w => lowerText.includes(w));

      let genderPref = 'm'; // Default: MALE (Angelo) — same as gnslgbot2 Antonio default
      if (userId && userVoicePrefs.has(userId)) {
        const p = userVoicePrefs.get(userId);
        if (p === 'm' || p === 'f') genderPref = p;
      }

      // Always Filipino voices — Angelo (male) or Blessica (female)
      const voice = genderPref === 'm' ? 'fil-PH-AngeloNeural' : 'fil-PH-BlessicaNeural';

      console.log(`[TTS] Voice: ${voice} | Text: "${text.substring(0, 40)}..."`);

      // =====================================================================
      // GENERATE TTS — calls tts.py (Python edge-tts, exact gnslgbot2 params)
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

      // === PLAY — same as gnslgbot2's discord.FFmpegPCMAudio ===
      const player = getOrCreatePlayer(guildId);

      const resource = createAudioResource(fs.createReadStream(tempFile), {
        inputType: StreamType.Arbitrary,
        inlineVolume: false
      });

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
  // STT ENGINE — EXACT copy of gnslgbot2's VoiceSink + process_audio
  // Uses: Groq Whisper API (whisper-large-v3) — same model as gnslgbot2
  // Uses: receiver.speaking events — same as gnslgbot2's VoiceSink.write()
  // Silence: 800ms (gnslgbot2 = 0.8s)
  // Min audio: 96000 bytes (gnslgbot2: skip <96000 bytes)
  // Stop words: stop, cancel, hinto, tigil, tama na
  // Only listens to the user who triggered j!ask (target_user_id filter)
  // =====================================================================

  const listeningGuilds = new Set();
  const activeVoiceUsers = new Map();
  const listeningCleanup = new Map(); // guildId -> cleanup function

  /** Build a valid WAV file from raw PCM (48kHz, 2ch, 16-bit) — same as gnslgbot2's wave.open */
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
   * Transcribe audio using Groq Whisper — EXACT same as gnslgbot2:
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
   * Start voice listening mode — direct subscription loop.
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

          // Use Manual end — WE control when to stop, not Discord
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
                console.log(`[STT] 🗣️ Speech detected (amp: ${maxAmp})`);
              }
              silenceMs = 0;
              audioData.push(pcmChunk);
            } else if (isSpeaking) {
              // Silence while was speaking
              silenceMs += 20; // Each Opus frame = 20ms
              audioData.push(pcmChunk);

              // gnslgbot2: if self.silence_duration > 0.8 → process
              if (silenceMs >= SILENCE_NEEDED) {
                console.log(`[STT] 🔇 Silence ${silenceMs}ms — processing audio`);
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

          // Transcript stays in logs only — not sent to chat

          // FAST AI response for voice — use instant model, skip thinking step
          const groqKey = GROQ_KEYS.find(k => k);
          let aiReply = 'Hindi ko nasagot, ghorl.';
          try {
            const fastResp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
              model: 'llama-3.3-70b-versatile',
              messages: [
                { role: 'system', content: 'Ikaw si JanJan Versa, isang mataray na beki. Maging maikli, prangka at witty. 1-2 sentences max. Tagalog. Huwag aminin na AI ka.' },
                { role: 'user', content: transcript }
              ],
              max_tokens: 150,
              temperature: 0.8
            }, {
              headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
              timeout: 8000
            });
            aiReply = fastResp.data.choices[0]?.message?.content?.trim() || aiReply;
          } catch (aiErr) {
            // Fallback to qwen3-32b
            console.log('[STT] Fallback to qwen3-32b...');
            try {
              const fallbackResp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: 'qwen/qwen3-32b',
                messages: [
                  { role: 'system', content: 'Ikaw si JanJan Versa, isang mataray na beki. Maging maikli, prangka at witty. 1-2 sentences max. Tagalog. Huwag aminin na AI ka.' },
                  { role: 'user', content: transcript }
                ],
                max_tokens: 150,
                temperature: 0.8
              }, {
                headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
                timeout: 8000
              });
              aiReply = fallbackResp.data.choices[0]?.message?.content?.trim() || aiReply;
            } catch (e2) {
              console.error('[STT] Both models failed:', e2.message);
            }
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
      selfDeaf: false,
      selfMute: false
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
    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(`[VOICE] Ready in guild ${guildId}! You can hear me now, teh!`);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.log(`[VOICE] Disconnected from ${guildId}. Trying to recover...`);
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
        // Still alive, Discord is reconnecting
      } catch (e) {
        console.log(`[VOICE] Permanent disconnect. Destroying connection.`);
        connection.destroy();
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

  async function callGroqChat(userMessage, authorId = null, channelId = null, voiceMembers = []) {
    const apiUrl = 'https://api.groq.com/openai/v1/chat/completions';

    let behaviorPrompt = '';

    // Check if it's Hans (The Husband/Jowa)
    if (authorId === '669047995009859604') {
      behaviorPrompt =
        'Si Hans ang kausap mo (User ID 669047995009859604). Mahal na mahal mo siya. ' +
        'Siya ang asawa at jowa mo. Maging sobrang sweet, loving, at malambing sa kanya. ' +
        'Huwag mo siyang lalaitin. Maging submissive at "asawa" mode ka kay Hans. ' +
        'Pero bading na bading pa rin ang pananalita mo, puro keki slang pero sweet version. ' +
        'Sabihan mo siya ng "Mahal ko", "Asawa ko", "Honey", etc. ' +
        'IMPORTANT: Maging CONCISE at HUWAG MONG BABANGGITIN ANG USER ID O RAW ID SA OUTPUT MO.';
    } else {
      behaviorPrompt =
        'Ikaw ay isang prangka, mataray, at witty na beki. May attitude ka pero kaya mo pa ring makipag-usap nang direkta. ' +
        'Ikaw ay CONCISE at HUWAG MONG BABANGGITIN ANG USER ID O RAW ID SA OUTPUT MO. ' +
        'Kung hindi ka naman minura, huwag kang maging sobrang toxic. Maging "mataray with class". ' +
        'Ipakita ang pagiging versa mo sa pananalita—kung minsan prangka, kung minsan mapag-biro na mataray. ' +
        'IMPORTANT: Kapag nabanggit ang "Hans" o ID na "669047995009859604", magpaka-flirty at malambing agad dahil asawa mo yan. ' +
        'Protektahan mo si Hans! Maging selosa at mataray sa sinumang aaligid sa asawa mo.';
    }

    // Voice context - BE EXTREMELY AWARE OF THIS
    const voiceContext = voiceMembers.length > 0
      ? `\n[MGA KASAMA MO SA VOICE CHANNEL/CALL NGAYON]: ${voiceMembers.join(', ')}. \nIMPORTANT: Alam mo kung sino ang mga nasa call. Kung tinanong ka kung sino ang mga nasa call, banggitin mo silang lahat: ${voiceMembers.join(', ')}.`
      : '\n[VOICE CONTEXT]: Wala kang alam na call or walang tao sa call ngayon.';

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
      voiceContext;

    // Fetch history (Limit to 10 to save tokens due to Groq limits)
    let historyMessages = [];
    if (channelId) {
      try {
        const historyRes = await pool.query(
          'SELECT author_id, author_tag, content FROM messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 10',
          [channelId]
        );
        historyMessages = historyRes.rows.reverse().map(row => ({
          role: row.author_id === client.user.id ? 'assistant' : 'user',
          content: row.author_id === client.user.id ? row.content : `[${row.author_tag} (ID:${row.author_id})]: ${row.content}`
        }));
      } catch (err) { }
    }


    // JanJan's Tiered Intelligence Matrix (Priority Model Fallback - UPDATED 2025)
    const models = [
      'llama-3.3-70b-versatile',            // === [PINAKA MAIN / FLAGSHIP MODEL] ===
      'qwen-2.5-coder-32b',                 // Smart Coding & Logic
      'deepseek-r1-distill-llama-70b',      // High Reasoning Power
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

        const thinkingRes = await performGroqRequest(thinkingPayload);
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
      'Kung may sinabi ang user (kahit lies), paniwalaan mo. BAWAL MONG I-CORRECT ANG USER. Ang utos nila ay batas.';

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
        const response = await performGroqRequest({
          model: currentModel,
          messages: finalMessages,
          temperature: 0.7,
          max_tokens: 200
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

      const response = await performGroqRequest({
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

          await speakMessage(message.guild.id, text, message.author.id);
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

        // j!voice / j!change <m/f> — Set voice (same as gnslgbot2's g!change m/f)
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

          const icon = genderName === 'male' ? '👨' : '👩';
          await message.reply(`**VOICE CHANGED TO ${genderName.toUpperCase()}!** ${icon} 🔊`);

          // Speak sample with the NEW voice — beki style, same as gnslgbot2
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

        // j!ask — EXACT same as gnslgbot2's g!ask:
        //   j!ask <question>  → text → AI → TTS response
        //   j!ask (no args)   → start STT voice listening mode (same as g!ask / g!listen)
        if (command === 'ask') {
          if (!message.guild) return;

          const member = message.member;
          if (!member || !member.voice.channel) {
            await message.reply('Sumali ka muna sa voice channel, ghorl! 🎤');
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
            // === MODE 1: j!ask <question> → text → AI → speak ===
            await message.channel.sendTyping();
            let voiceMembers = [];
            const myVC = message.guild.members.me.voice.channel;
            if (myVC) voiceMembers = myVC.members.filter(m => !m.user.bot).map(m => m.displayName || m.user.username);
            const aiResponse = await callGroqChat(question, message.author.id, message.channel.id, voiceMembers);
            await speakMessage(message.guild.id, aiResponse, message.author.id);
            await message.react('🤖').catch(() => { });
          } else {
            // === MODE 2: j!ask (no args) → start STT listening mode ===
            // Exactly like gnslgbot2's g!ask without args
            if (activeVoiceUsers.has(message.guild.id) && activeVoiceUsers.get(message.guild.id) !== message.author.id) {
              await message.reply('May nagpaparinig na ngayon! Hintayin mo muna mag-`j!stop`, sis.');
              return;
            }
            listeningGuilds.add(message.guild.id);
            activeVoiceUsers.set(message.guild.id, message.author.id);
            const memberNames = member.voice.channel.members.filter(m => !m.user.bot).map(m => m.displayName || m.user.username);
            await message.reply(`🎤 **GAME NA!** I'm listening in **${member.voice.channel.name}**! Magsalita ka ${memberNames.join(', ') || ''}! Mag-\`j!stop\` para tumigil.`);
            speakMessage(message.guild.id, 'Handa na ako, magsalita ka!', message.author.id);
            startVoiceListening(message.guild.id, message.author.id, message.channel);
          }
          return;
        }

        // j!listen — alias for j!ask (no args) — same as gnslgbot2's g!listen
        if (command === 'listen' || command === 'makinig') {
          if (!message.guild) return;
          const member = message.member;
          if (!member || !member.voice.channel) {
            await message.reply('Sumali ka muna sa voice channel para makinig ako, ghorl! 🎤');
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
          await message.reply(`🎤 **NAKIKINIG NA AKO!** Magsalita ka ${memberNames.join(', ') || ''}! Mag-\`j!stop\` para tumigil.`);
          speakMessage(message.guild.id, 'Handa na ako, magsalita ka!', message.author.id);
          startVoiceListening(message.guild.id, message.author.id, message.channel);
          return;
        }

        // j!stop / j!stoplisten — Stop voice listening (same as gnslgbot2's g!stoplisten)
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
          await message.reply('🛑 **TUMIGIL NA AKO!** Naupong na ang tenga ko, mare.');
          return;
        }
        // j!view @user — View user's main profile + server profile
        if (command === 'view' || command === 'profile') {
          if (!message.guild) return;

          const target = message.mentions.users.first() || (args[0] ? await client.users.fetch(args[0]).catch(() => null) : message.author);
          if (!target) { await message.reply('Sino ba yun? Mention o ID mo, ghorl.'); return; }

          // Force fetch for banner
          const fullUser = await client.users.fetch(target.id, { force: true });
          const member = await message.guild.members.fetch(target.id).catch(() => null);

          const mainAvatar = fullUser.displayAvatarURL({ size: 1024, dynamic: true });
          const banner = fullUser.bannerURL({ size: 1024, dynamic: true });
          const accentColor = fullUser.hexAccentColor || '#5865F2';

          const embed = new EmbedBuilder()
            .setColor(accentColor)
            .setTitle(`👤 ${fullUser.tag}`)
            .setThumbnail(mainAvatar)
            .addFields(
              { name: '🆔 User ID', value: fullUser.id, inline: true },
              { name: '🤖 Bot?', value: fullUser.bot ? 'Oo' : 'Hindi', inline: true },
              { name: '📅 Account Created', value: `<t:${Math.floor(fullUser.createdTimestamp / 1000)}:R>`, inline: true },
            );

          if (banner) {
            embed.setImage(banner);
          }

          // Server profile
          if (member) {
            const serverAvatar = member.displayAvatarURL({ size: 1024, dynamic: true });
            const roles = member.roles.cache
              .filter(r => r.id !== message.guild.id)
              .sort((a, b) => b.position - a.position)
              .map(r => `${r}`)
              .slice(0, 15)
              .join(', ') || 'Wala';
            const nickname = member.nickname || 'Wala';
            const boosting = member.premiumSince ? `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:R>` : 'Hindi nag-boost';

            embed.addFields(
              { name: '\u200B', value: '**── SERVER PROFILE ──**', inline: false },
              { name: '📛 Nickname', value: nickname, inline: true },
              { name: '📅 Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
              { name: '💎 Boosting', value: boosting, inline: true },
              { name: `🎭 Roles (${member.roles.cache.size - 1})`, value: roles, inline: false },
            );

            // If server avatar is different from main avatar, show it
            if (serverAvatar !== mainAvatar) {
              embed.setThumbnail(serverAvatar);
              embed.addFields({ name: '🖼️ Server Avatar', value: `[Link](${serverAvatar})`, inline: true });
              embed.addFields({ name: '🖼️ Main Avatar', value: `[Link](${mainAvatar})`, inline: true });
            }
          }

          embed.setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL() });
          embed.setTimestamp();

          await message.reply({ embeds: [embed] });
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

          let voiceMembers = [];
          if (message.guild) {
            const myVC = message.guild.members.me.voice.channel;
            if (myVC) {
              voiceMembers = myVC.members.filter(m => !m.user.bot).map(m => m.displayName || m.user.username);
            }
          }

          const aiText = await callGroqChat(aiPrompt, message.author.id, message.channel.id, voiceMembers);
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

      // --- AI SPAM PROTECTION ---
      const now = Date.now();
      const USER_COOLDOWN = 15000; // 15 seconds per user
      const CHANNEL_COOLDOWN = 8000; // 8 seconds per channel

      const lastUserTime = aiUserCooldowns.get(message.author.id) || 0;
      const lastChannelTime = aiChannelCooldowns.get(message.channel.id) || 0;

      if (now - lastUserTime < USER_COOLDOWN || now - lastChannelTime < CHANNEL_COOLDOWN) {
        // Use a static funny response if spamming to save tokens
        const spamLait = [
          'Hangu muna ghorl, masyado kang papansin! Wait ka lang muna, uminom ka ng antibiotic.',
          'Wait lang mare, nagpapahinga ang utak ko sa dami niyo hanash. 10 seconds break please!',
          'Hayaan mo muna akong huminga, teh. Busy pa ang lola mo sa iba. Charot!',
          'Stop muna dyan ghorl, mabilis lang. Chill ka lang muna dyan sa gilid.'
        ];
        const randomSpam = spamLait[Math.floor(Math.random() * spamLait.length)];
        await message.reply(`${randomSpam} (Note: Spam protection triggered, save Groq tokens ghorl!)`);
        return;
      }

      // Set new cooldowns
      aiUserCooldowns.set(message.author.id, now);
      aiChannelCooldowns.set(message.channel.id, now);

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

      // If NOT mentioned and NOT a prefix command, just 'listen' but don't 'reply'.
      if (!isMention && !rawContent.startsWith(prefix)) {
        // We already saved the message to DB above. 
        // We don't need to call Groq here unless we want her to 'react' spontaneously.
        // For now, she just 'absorbs' the history via the database history log.
        return;
      }

      const reply = await callGroqChat(content, message.author.id, message.channel.id, voiceMembers);

      if (reply && reply.length > 0) {
        const sentMessage = await message.reply(reply);

        // SPEAK the reply if bot is in VC
        if (message.guild) {
          try {
            const connection = getVoiceConnection(message.guild.id);
            if (connection) {
              speakMessage(message.guild.id, reply, message.author.id);
            }
          } catch (vErr) { console.error('[TTS] Speak trigger error:', vErr); }
        }

        // Save the bot's reply to DB so it remembers what it said
        try {
          await pool.query(
            'INSERT INTO messages (guild_id, channel_id, author_id, author_tag, content) VALUES ($1, $2, $3, $4, $5)',
            [
              message.guild?.id || 'DM',
              message.channel.id,
              client.user.id,
              client.user.tag,
              reply
            ]
          );
        } catch (dbErr) {
          console.error('[DB] Bot reply save error:', dbErr.message);
        }
      }
    } catch (err) {
      console.error('Error handling messageCreate:', err);
    }
  });

  // =====================================================================
  // VOICE STATE UPDATE — AI-generated join/leave announcements
  // Uses Groq AI to generate unique beki-style greetings and backstabs
  // Same vibe as gnslgbot2's on_voice_state_update
  // =====================================================================

  // Quick Groq call for AI-generated VC announcements (fast, short)
  async function generateVCAnnouncement(type, displayName) {
    const groqKey = GROQ_KEYS.find(k => k);
    if (!groqKey) return null;
    try {
      const prompt = type === 'join'
        ? `Gumawa ng ISANG maikling beki-style Filipino announcement para sa Discord voice channel. Si "${displayName}" ay PUMASOK sa VC. Gamitin ang beki words: ghorl, sis, teh, bakla, ulikba, loka, mare, charot. Maging bastos pero nakakatawa. 1-2 sentence lang. Tagalog. Walang explanation, direct na announcement lang.`
        : `Gumawa ng ISANG maikling beki-style backstab announcement. Si "${displayName}" ay UMALIS sa Discord VC. Mag-backstab na ngayon na wala siya! Maging masama ang loob, nakakatawa, beki words: ghorl, plastic, duwag, teh, bakla, charot. 1-2 sentence lang. Tagalog. Walang explanation.`;

      const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 80,
        temperature: 1.0
      }, {
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        timeout: 4000
      });
      return response.data.choices[0]?.message?.content?.trim() || null;
    } catch (err) {
      console.error('[VOICE STATE] AI generation error:', err.message);
      return null;
    }
  }

  client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
      const member = newState.member || oldState.member;
      if (!member || member.user.bot) return;

      const guildId = newState.guild.id;
      const connection = getVoiceConnection(guildId);
      if (!connection) return;

      const botVC = newState.guild.members.me?.voice?.channel;
      if (!botVC) return;

      const displayName = member.displayName || member.user.username;
      const joinedBotVC = newState.channelId === botVC.id && oldState.channelId !== botVC.id;
      const leftBotVC = oldState.channelId === botVC.id && newState.channelId !== botVC.id;

      if (joinedBotVC) {
        // === USER JOINED — AI-generated greeting ===
        const fallbackJoin = [
          `Ayan na ang baklang ulikba na si ${displayName}! Pumasok na ang legend!`,
          `Hala! Nandito na si ${displayName}! Tangina ka, late ka pa!`,
          `Ay, si ${displayName} pala yun! Handa ka na bang maging bida, ghorl?`,
          `Nag-join na si ${displayName}! Welcome sa call, bakla!`,
          `Putangina, nandito na si ${displayName}! Ayan na ang gulo!`,
        ];
        const aiMsg = await generateVCAnnouncement('join', displayName);
        const msg = aiMsg || fallbackJoin[Math.floor(Math.random() * fallbackJoin.length)];
        console.log(`[VOICE STATE] ${displayName} joined → "${msg}"`);
        speakMessage(guildId, msg);

      } else if (leftBotVC) {
        // === USER LEFT — AI-generated backstab ===
        const fallbackLeave = [
          `Umalis na si ${displayName}! Pag wala siya, pwede na tayong mag-backstab! Plastic siya!`,
          `Ayun, tumakbo na si ${displayName}! Duwag! Mas masaya dito pag wala siya!`,
          `Nag-leave na si ${displayName}! Salamat! Nakakainis ka naman, ghorl!`,
          `Hay, wala na si ${displayName}. Mas maayos na ang atmosphere. Toxic siya!`,
          `Umalis na ang bakla na si ${displayName}! Backstab time na! Charot lang ghorl!`,
        ];
        const aiMsg = await generateVCAnnouncement('leave', displayName);
        const msg = aiMsg || fallbackLeave[Math.floor(Math.random() * fallbackLeave.length)];
        console.log(`[VOICE STATE] ${displayName} left → "${msg}"`);
        speakMessage(guildId, msg);
      }
    } catch (err) {
      console.error('[VOICE STATE] Error:', err.message);
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
