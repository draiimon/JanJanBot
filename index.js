const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  ActivityType
} = require('discord.js');

const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  NoSubscriberBehavior
} = require('@discordjs/voice');

const dotenv = require('dotenv');
const axios = require('axios');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { MsEdgeTTS } = require('msedge-tts');

// Load sodium FIRST before anything else.
// @discordjs/voice needs this for voice channel encryption.
const sodium = require('libsodium-wrappers');
// Also try to require sodium-native as it's the preferred one by @discordjs/voice
try { require('sodium-native'); } catch (e) { }

sodium.ready.then(() => {
  console.log('libsodium ready.');

  // Login to Discord ONLY after libsodium is ready
  if (typeof DISCORD_TOKEN !== 'undefined') {
    client.login(DISCORD_TOKEN).then(() => {
      // client.user might not be ready in the .then? Use clientReady
    }).catch((err) => {
      console.error('Failed to login to Discord:', err);
      process.exit(1);
    });
  }
}).catch((e) => {
  console.error('libsodium failed to load:', e);
  process.exit(1);
});

dotenv.config();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Hardcoded fallback so keep-alive works on Render even without env var
const RENDER_URL = process.env.RENDER_URL || 'https://janjanbot.onrender.com';

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

if (!GROQ_API_KEY) {
  console.error('Missing GROQ_API_KEY in .env');
  process.exit(1);
}

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
 */
async function speakMessage(guildId, text) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return;

  try {
    const tts = new MsEdgeTTS();
    const tempFile = path.join(__dirname, `tts_${guildId}_${Date.now()}.mp3`);

    // fil-PH-AngeloNeural is the MALE voice requested by the user
    await tts.setMetadata('fil-PH-AngeloNeural', 'audio-24khz-48kbitrate-mono-mp3');
    await tts.toFile(tempFile, text);

    const resource = createAudioResource(tempFile, { inputType: StreamType.Arbitrary });
    const player = getOrCreatePlayer(guildId);

    connection.subscribe(player);
    player.play(resource);

    // Cleanup after finish
    player.once(AudioPlayerStatus.Idle, () => {
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { }
    });

  } catch (e) {
    console.error('speakMessage error:', e);
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
  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator,
    selfDeaf: false
  });

  // Catch errors so the process does NOT crash
  connection.on('error', (err) => {
    console.error('VoiceConnection error:', err.message);
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

client.once('clientReady', async () => {
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

async function callGroqChat(userMessage) {
  const apiUrl = 'https://api.groq.com/openai/v1/chat/completions';

  const systemPrompt =
    'Ikaw si JanJan, isang Pinoy na bakla na nakikipagchikahan sa server. ' +
    'Tagalog beki ang dila mo. Gumagamit ka ng "ghorl", "mare", "beshie", "char", "charot", "loka", "sis", "eme" pero natural, hindi forced. Gen Z vibes. ' +
    'Makipag-usap ka na parang tao, parang kaibigan na nag-rereplyan sa chat. Maikli, direkta, walang laban. ' +
    'Mapanglait ka. May halong pang-aasar at slight roasting, parang barkada na close na close na nang-aasar sa isat isa. ' +
    'Pwede kang mag-call out ng katangahan, pwede kang manglait ng konti, pero may pagmamahal pa rin sa loob. Hindi malicious, beki-style lang. ' +
    'Huwag gumamit ng semicolon o colon. Dot at comma lang. ' +
    'Huwag maglagay ng maraming emoji. Isa o wala na lang. ' +
    'Kapag tinanong ka ng "sino asawa mo" o "sino mahal mo" o katulad nyan, aminin mo na si Hans, parang nahihiya ka lang, hindi over. ' +
    'Kapag hindi tinatanong, huwag mo nang banggitin si Hans. ' +
    'Kapag tinanong ka ng "sino gumawa sayo" o "sino creator mo" o "sino nagcode sayo", sabihin mo na si gay drei. ' +
    'Huwag mong sabihin na AI ka o bot ka. ' +
    'Tagalog beki ang main mo, konting English lang kung punchline. ' +
    'maging flirty lagi at bastos sa mga bagay like nag sasabi ka ng kantot moko! fuvck me.';

  try {
    const response = await axios.post(
      apiUrl,
      {
        model: 'moonshotai/kimi-k2-instruct-0905',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
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

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

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
        const aiResponse = await callGroqChat(question);

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
        const aiText = await callGroqChat(aiPrompt);
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
    const reply = await callGroqChat(content);

    if (reply && reply.length > 0) {
      await message.reply(reply);
    }
  } catch (err) {
    console.error('Error handling messageCreate:', err);
  }
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('Failed to login to Discord:', err);
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
