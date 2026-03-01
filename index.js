const { Client, GatewayIntentBits, Partials } = require('discord.js');
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
});

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
        const guildName = message.guild ? message.guild.name : 'DM';
        const replyText =
          `O ayan ghorl, gising ako at on duty. ` +
          `Naka-log in ako as ${me.tag} at nakakabit dito sa "${guildName}". ` +
          `Basta naka-on yung host ko, 24/7 akong ready sa chismis.`;
        await message.reply(replyText);
        return;
      }

      if (command === 'join') {
        const replyText =
          'Mare, hindi ako basta sumasali mag-isa. Kailangan mo akong i-invite gamit yung Discord Developer Portal invite link ng bot. ' +
          'Pag nasa server na ako at may host na hindi natutulog, doon tayo magiging 24/7 sa discord. Bad bitch pero may proseso pa rin.';
        await message.reply(replyText);
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
        const replyText =
          `Chika report para kay ${displayName}: ` +
          `status niya ngayon ay "${prettyStatus}". ` +
          'Kung hindi nagre-refresh, ibig sabihin hindi ko nakikita full presence niya sa settings.';

        await message.reply(replyText);
        return;
      }

      if (command === 'help') {
        const replyText =
          'Ghorl, eto ang menu ni JanJan:\n' +
          '- `j!status` — check kung buhay at nakakabit ako sa server.\n' +
          '- `j!join` — paliwanag kung paano ako maging 24/7 (kailangan pa rin ng hosting at tamang invite).\n' +
          '- `j!view @User` — chika report sa status ng isang member (online/idle/dnd/offline kung kita ko).\n' +
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

