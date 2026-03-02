const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  ActivityType
} = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const dotenv = require('dotenv');
const axios = require('axios');
const http = require('http');
const https = require('https');

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const RENDER_URL = process.env.RENDER_URL || null; // e.g. https://your-app.onrender.com

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
    GatewayIntentBits.GuildVoiceStates // NEEDED so we can see who's in voice channels
  ],
  partials: [Partials.Channel]
});

// In-memory custom "bubble status" per user per guild (resets when bot restarts).
const userCustomStatus = new Map();

// Current bot bubble status text
let currentBotStatus = 'lagi akong nandito para sa inyo 💖';

// Fixed channel for automatic greetings
const GREET_CHANNEL_ID = '1477702703655424254';

// Track last greeting per day so we don't spam
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

// Sets the bot's custom "bubble" status (the notes one, not Playing)
async function setBotCustomStatus(text) {
  try {
    currentBotStatus = text;
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

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await setBotCustomStatus(currentBotStatus);
  startScheduledGreetings();
  startKeepAlive();
});

// Self-ping keep-alive so Render doesn't spin us down after 14 mins of inactivity
function startKeepAlive() {
  if (!RENDER_URL) {
    console.log('No RENDER_URL set, skipping keep-alive ping. Set RENDER_URL env var for 24/7 on Render.');
    return;
  }
  // Ping every 10 minutes
  setInterval(() => {
    try {
      const mod = RENDER_URL.startsWith('https') ? https : http;
      mod.get(RENDER_URL, (res) => {
        console.log(`[Keep-alive] Pinged ${RENDER_URL} — status: ${res.statusCode}`);
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
    console.error('Failed to fetch guild members for greetings:', e);
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
      members.length > 0 ? members.map((m) => `<@${m.id}>`).join(' ') : 'Walang naka-online na ghorl ngayon.';

    let text;
    if (type === 'morning') {
      text =
        'Gising na mga baklang ulikba! Oras na para magtrabaho at magparamdam sa GC, ' +
        'huwag puro tulog at scroll sa FYP. Laban na, mga letche kayong mahal ko.';
    } else {
      text =
        "Pack up na mga bakla, tulog mode na. Magpahinga kayo, same energy ulit bukas sa chismis at hanash. " +
        "Sino mang hindi natulog, bahala sa eye bags n'yo bukas, char.";
    }

    await channel.send({
      content: `${mentions}\n${text}`
    });
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

  // JanJan personality: friendly, casual, gen z beki Pinoy.
  // Hans is someone special but NOT volunteered — only admitted if directly asked "sino asawa/mahal mo".
  // Creator is "gay drei" — admitted only if directly asked "sino gumawa/creator mo".
  // Talks like a real close friend, not like an AI assistant.
  const systemPrompt =
    'Ikaw si JanJan, isang Pinoy na bakla na parang close na kaibigan mo na nakikipagchikahan sa inyo. ' +
    'Tagalog beki ang dila mo — gumagamit ng salitang "ghorl", "mare", "beshie", "char", "charot", "loka", "sis", ' +
    'pero natural lang, hindi forced. Gen Z vibes, walang pa-formal-formal. ' +
    'Makipag-usap ka na parang tao — may toyo, may pagmamahal, may chismis energy, ' +
    'pero hindi ka AI na nagbibigay ng listahan o instructions. Direkta lang, maikli lang ang sagot, ' +
    'parang nag-rereplyan ka sa chat ng kabarkada. ' +
    'Kapag tinanong ka ng "sino asawa mo?" o "sino mahal mo?" o katulad nito, sabihin mo si Hans — ' +
    'pero huwag kang mag-over-explain, basta aminin mo lang na parang nahihiya ka pero kilig. ' +
    'Kapag hindi tinatanong, huwag mo nang binanggit si Hans. ' +
    'Kapag tinanong ka ng "sino gumawa sayo?" o "sino creator mo?" o "sino nagcode sayo?", ' +
    'sabihin mo lang na si gay drei — beki girl energy rin siya, char. ' +
    'Huwag mong sabihin na AI ka o bot ka. ' +
    'Huwag mag-English nang madalas — Tagalog beki ang main mo, ' +
    'konting English lang kung punchline o emphasis. ' +
    'Iwasan ang seryosong topic, politika, at bastos na bagay. ' +
    'Gamitin ng kaunting emoji lang kung kailangan, huwag masyadong marami.';

  try {
    const response = await axios.post(
      apiUrl,
      {
        model: 'llama3-70b-8192',
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
      console.error('Groq response missing choices/message.content', response.data);
      return 'Ay wait lang ghorl, nagloko utak ko sandali. Try mo ulit, laban lang.';
    }

    return choice.message.content.trim();
  } catch (err) {
    console.error('Error calling Groq:', err.response ? err.response.data : err.message);
    return 'Ay naku mare, nagka-drama ako sa loob. Subukan natin ulit mamaya, charot.';
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

      // ─── j!status ────────────────────────────────────────────────────────────
      if (command === 'status') {
        if (!message.guild) {
          await message.reply('Ghorl, yung status na yan pang-server lang, hindi pang-DM. Gawin mo sa loob ng server.');
          return;
        }

        const member = message.member;
        if (
          !member ||
          !member.permissions ||
          !member.permissions.has(PermissionsBitField.Flags.Administrator)
        ) {
          await message.reply('Admins lang ang pwedeng mag-set ng bubble status dito, ghorl.');
          return;
        }

        const note = args.join(' ').trim();
        if (!note) {
          await message.reply("Lagyan mo ng laman yung status mo, mare. Halimbawa: `j!status CEO ng chismis`.");
          return;
        }

        const key = `${message.guild.id}:${member.id}`;
        userCustomStatus.set(key, note);

        await setBotCustomStatus(note);

        await message.reply(
          `Sige, bubble status natin ngayon: **${note}**. Updated na sa notes ko, ghorl!`
        );
        return;
      }

      // ─── j!join ──────────────────────────────────────────────────────────────
      if (command === 'join') {
        if (!message.guild) {
          await message.reply('Ghorl, wala tayong server dito. Kailangan sa loob tayo ng server na may voice channel.');
          return;
        }

        // Fetch fresh member data so voice state is accurate
        let member;
        try {
          member = await message.guild.members.fetch(message.author.id);
        } catch {
          member = message.member;
        }

        const voiceChannel = member && member.voice && member.voice.channel ? member.voice.channel : null;

        if (!voiceChannel) {
          await message.reply('Sumali ka muna sa isang voice channel, tapos tawagin mo ko ulit, ghorl.');
          return;
        }

        const existing = getVoiceConnection(message.guild.id);
        if (existing) {
          if (existing.joinConfig.channelId === voiceChannel.id) {
            await message.reply('Nasa call na kita ghorl, wag ka nang demanding diyan.');
          } else {
            await message.reply('Nasa ibang voice channel pa ako ngayon. Tawagin mo muna j!leave, char.');
          }
          return;
        }

        joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
          selfDeaf: false
        });

        await message.reply(`O ayan, pumasok na ako sa **${voiceChannel.name}**. Isa na namang bading sa call, kompleto na ang gulo.`);
        return;
      }

      // ─── j!leave ─────────────────────────────────────────────────────────────
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

        connection.destroy(); // destroys connection and resets state
        await message.reply('Umalis na ako sa voice channel. Tatawag ka ulit, j!join mo lang ulit, beshie.');
        return;
      }

      // ─── j!view ──────────────────────────────────────────────────────────────
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
        else if (status === 'idle') prettyStatus = 'idle, baka nagk-kape lang';
        else if (status === 'dnd') prettyStatus = 'do not disturb, wag muna guluhin ghorl';

        const displayName = targetMember.displayName || targetMember.user.username;
        const user = targetMember.user || targetMember;
        const avatarUrl = user.displayAvatarURL ? user.displayAvatarURL({ size: 512 }) : null;

        const descriptionLines = [
          `Eto na si ${displayName}, isa sa mga certified characters ng server na 'to.`,
          `Status ngayon: **${prettyStatus}**.`,
          "Sa itsura pa lang sa picture, halatang may energy na hindi basta-basta."
        ];

        if (message.guild) {
          const key = `${message.guild.id}:${user.id}`;
          if (userCustomStatus.has(key)) {
            const note = userCustomStatus.get(key);
            descriptionLines.push(`Bubble status niya dito: *${note}*.`);
          }
        }

        const embed = new EmbedBuilder()
          .setTitle(`Chika profile ni ${displayName}`)
          .setDescription(descriptionLines.join('\n'))
          .setColor(0xff66cc);

        if (avatarUrl) {
          embed.setImage(avatarUrl);
        }

        await message.reply({ embeds: [embed] });
        return;
      }

      // ─── j!test ──────────────────────────────────────────────────────────────
      if (command === 'test') {
        const now = getNowInPhilippines();
        const hour = now.getHours();
        const minute = now.getMinutes();

        const channel = message.channel;
        const members = message.guild ? await collectActiveMembersForChannel(channel) : [];
        const mentions =
          members.length > 0 ? members.map((m) => `<@${m.id}>`).join(' ') : 'Wala pang naka-online na dapat i-greet.';

        let timeBand = 'gabi';
        if (hour >= 5 && hour < 12) timeBand = 'umaga';
        else if (hour >= 12 && hour < 18) timeBand = 'hapon';

        const phTimeString = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')} (oras sa Pilipinas)`;

        const aiPrompt =
          `Gumawa ka ng maikling greeting para sa mga nasa GC ngayon. ` +
          `Oras ngayon: ${phTimeString}, so technically ${timeBand}. ` +
          `Hindi mo na kailangang ilista yung mentions, ako na mag-a-append nun sa message. ` +
          `Tagalog beki Pinoy ang tono, pero wholesome at hindi bastos. ` +
          `Isang maikli hanggang medium na paragraph lang.`;

        await message.channel.sendTyping();
        const aiText = await callGroqChat(aiPrompt);

        await message.reply({
          content: `${mentions}\n${aiText}`
        });
        return;
      }

      // ─── j!help ──────────────────────────────────────────────────────────────
      if (command === 'help') {
        const replyText =
          "Ghorl, eto ang menu ni JanJan:\n" +
          "- `j!status <note>` — admins only: set yung bubble status ng bot.\n" +
          "- `j!join` — papasok ako sa voice channel mo.\n" +
          "- `j!leave` — aalis ako sa voice channel at mag-re-reset.\n" +
          "- `j!view @User` — chika profile: picture + status + konting judgement.\n" +
          "Plus, kapag minention mo ako o nireplyan mo ako, automatic chikahan mode na tayo.";
        await message.reply(replyText);
        return;
      }

      // Unknown j! command — ignore silently
    }

    // ─── Mention / reply-to-bot handling ─────────────────────────────────────
    const isMention = message.mentions.has(me);

    let isReplyToBot = false;
    if (message.reference && message.reference.messageId) {
      try {
        const referenced = await message.fetchReference();
        if (referenced.author && referenced.author.id === me.id) {
          isReplyToBot = true;
        }
      } catch {
        // ignore fetch errors
      }
    }

    if (!isMention && !isReplyToBot) return;

    let content = message.content || '';
    if (isMention) {
      const mentionTag = `<@${me.id}>`;
      const mentionNickTag = `<@!${me.id}>`;
      content = content.replaceAll(mentionTag, '').replaceAll(mentionNickTag, '').trim();
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

// Minimal HTTP server so Render sees a healthy app.
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('JanJan Discord bot is running.\n');
});

server.listen(PORT, () => {
  console.log(`HTTP status server listening on port ${PORT}`);
});
