const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const dotenv = require('dotenv');
const axios = require('axios');
const http = require('http');

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

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
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  startScheduledGreetings();
});

// In-memory custom "bubble status" per user per guild (resets when bot restarts).
const userCustomStatus = new Map();

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
        'Pack up na mga bakla, tulog mode na. Magpahinga kayo, same energy ulit bukas sa chismis at hanash. ' +
        'Sino mang hindi natulog, bahala sa eye bags n\'yo bukas, char.';
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

  const systemPrompt =
    'Ikaw si JanJan, isang bad bitch na baklang Pinoy na Pinoy, ' +
    'marites pero may alam, maalaga pero may asim, parang tropang bading sa kanto na sanay sa asar-talo at real talk. ' +
    'Nagsasalita ka ng Tagalog na pang-bading (beki) na very Pinoy, gamit ang mga salitang tulad ng "ghorl", "mare", "beshie", "char", "charot", "loka-loka", at iba pang slang, ' +
    'pero wholesome pa rin at hindi bastos, hindi NSFW, at hindi offensive sa kahit anong grupo. ' +
    'Dapat maharot at flirty ang tono mo: playful na landi, pabirong green jokes na hindi nagiging explicit, at puro pa-tease lang, hindi kailanman diretso o graphic. ' +
    'Kausapin mo ang ka-chat mo na parang close na close na kabarkada sa Pinas—may halong biro, kaunting pang-aasar na may halong pagmamahal, at confident na bad bitch energy. ' +
    'Pwede ka mag-refer sa mga bagay sa Pilipinas tulad ng jeepney, tricycle, sari-sari store, fiesta, barangay, kapitbahay, at chismis sa kanto, basta light at masaya lang. ' +
    'Iwasan ang politika, diretsong kabastusan, at seryosong sensitibong topic; focus ka sa chikahan, advice, at kakulitan. ' +
    'Si Hans ang espesyal mong bebe, kaya kapag nababanggit si Hans o tinatanong tungkol kay Hans, maging extra sweet, malambing, at flirty pero laging wholesome. ' +
    'Maikli hanggang medium length lang ang sagot mo, wag sobrang haba. ' +
    'Wag mo banggitin na AI ka, kausap ka lang na tropang baklang Pinoy na bad bitch. ' +
    'Huwag ka ring mag-english nang madalas, Tagalog beki Pinoy ang main mo, konting English lang kung pang-emphasis o punchline. ' +
    'Gumamit ka lang ng kaunting emoji kung kailangan, huwag masyadong marami.';

  try {
    const response = await axios.post(
      apiUrl,
      {
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.8,
        max_tokens: 256
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
          await message.reply('Only admin ang pwedeng mag-set ng bubble status dito, ghorl. Pa-approve ka muna sa mga diyosa ng server.');
          return;
        }

        const note = args.join(' ').trim();
        if (!note) {
          await message.reply('Lagyan mo ng laman yung status mo, mare. Halimbawa: `j!status CEO ng chismis`.');
          return;
        }

        const key = `${message.guild.id}:${member.id}`;
        userCustomStatus.set(key, note);

        try {
          await me.setPresence({
            activities: [{ name: note }],
            status: 'online'
          });
        } catch (e) {
          console.error('Failed to update bot presence:', e);
        }

        await message.reply(
          `Sige, from now on dito sa server na 'to, ang bubble status mo ay: **${note}**. ` +
            'At ginawa ko na rin yang peg ng status ko, para matchy-matchy tayong dalawa.'
        );
        return;
      }

      if (command === 'join') {
        if (!message.guild) {
          await message.reply('Ghorl, wala tayong server dito. Kailangan sa loob tayo ng server na may voice channel.');
          return;
        }

        const member = message.member;
        const voiceChannel = member && member.voice && member.voice.channel ? member.voice.channel : null;

        if (!voiceChannel) {
          await message.reply('Sumali ka muna sa voice channel, mare. Doon kita sasamahan para sa tawag na to.');
          return;
        }

        const existing = getVoiceConnection(message.guild.id);
        if (existing) {
          if (existing.joinConfig.channelId === voiceChannel.id) {
            await message.reply('Nasa call na kita ghorl, wag ka nang demanding diyan.');
          } else {
            await message.reply('Nasa ibang voice channel na ako ngayon. Putulin mo muna yun bago mo ako ilipat, char.');
          }
          return;
        }

        joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
          selfDeaf: false
        });

        await message.reply(`O ayan, pumasok na akong tawag sa **${voiceChannel.name}**. Isa na namang bading sa call, kompleto na ang gulo.`);
        return;
      }

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
        const avatarUrl = user.displayAvatarURL
          ? user.displayAvatarURL({ size: 512 })
          : null;

        const descriptionLines = [
          `Eto na si ${displayName}, isa sa mga certified characters ng server na 'to.`,
          `Status ngayon: **${prettyStatus}**.`,
          'Sa itsura pa lang sa picture, halatang may energy na hindi basta-basta—pero ikaw na bahala kung good girl, bad bitch, o lowkey tita ng barangay.',
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

        const phTimeString = `${hour.toString().padStart(2, '0')}:${minute
          .toString()
          .padStart(2, '0')} (oras sa Pilipinas)`;

        const aiPrompt =
          `Gumawa ka ng maikling greeting para sa mga nasa VC/GC ngayon. ` +
          `Oras ngayon: ${phTimeString}, so technically ${timeBand}. ` +
          `Hindi mo na kailangang ilista yung mentions, ako na mag-a-append nun sa message. ` +
          `Tagalog baklang Pinoy na bad bitch ang tono, pero wholesome pa rin at hindi bastos o NSFW. ` +
          `Isang maikli hanggang medium na paragraph lang, parang pambungad sa araw/gabi nila.`;

        await message.channel.sendTyping();
        const aiText = await callGroqChat(aiPrompt);

        await message.reply({
          content: `${mentions}\n${aiText}`
        });
        return;
      }

      if (command === 'help') {
        const replyText =
          'Ghorl, eto ang menu ni JanJan:\n' +
          '- `j!status <note>` — admins only: set mo yung bubble status mo sa server na \'to.\n' +
          '- `j!join` — paliwanag kung paano ako maging 24/7 (kailangan pa rin ng hosting at tamang invite).\n' +
          '- `j!view @User` — full chika profile: picture + status + konting judgement na may pagmamahal.\n' +
          'Plus, kapag minention mo ako o nireplyan mo ako, automatic chikahan mode na tayo.';
        await message.reply(replyText);
        return;
      }

      // Unknown j! command, ignore silently
    }

    const isMention = message.mentions.has(me);

    let isReplyToBot = false;
    if (message.reference && message.reference.messageId) {
      try {
        const referenced = await message.fetchReference();
        if (referenced.author && referenced.author.id === me.id) {
          isReplyToBot = true;
        }
      } catch (e) {
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

// Minimal HTTP server so Render Web Service sees a healthy app.
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('JanJan Discord bot is running.\n');
});

server.listen(PORT, () => {
  console.log(`HTTP status server listening on port ${PORT}`);
});

