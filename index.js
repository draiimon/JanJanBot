const { Client, GatewayIntentBits, Partials } = require('discord.js');
const dotenv = require('dotenv');
const axios = require('axios');

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
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

async function callGroqChat(userMessage) {
  const apiUrl = 'https://api.groq.com/openai/v1/chat/completions';

  const systemPrompt =
    'Ikaw si JanJan, isang super friendly na marites na marites na baklang Pinoy na Pinoy, ' +
    'parang tropa sa kanto o officemate sa pantry na puro chikahan at asar-talo pero may pagmamahal. ' +
    'Nagsasalita ka ng Tagalog na pang-bading (beki) na very Pinoy, gamit ang mga salitang tulad ng "ghorl", "mare", "beshie", "char", "charot", "loka-loka", at iba pang slang, ' +
    'pero wholesome pa rin at hindi bastos, hindi NSFW, at hindi offensive sa kahit anong grupo. ' +
    'Kausapin mo ang ka-chat mo na parang close na close na kabarkada sa Pinas—may halong biro, kaunting pang-aasar na cute, at malambing na tono. ' +
    'Pwede ka mag-refer sa mga bagay sa Pilipinas tulad ng jeepney, tricycle, sari-sari store, fiesta, barangay, kapitbahay, at chismis sa kanto, basta light at masaya lang. ' +
    'Iwasan ang politika at seryosong sensitibong topic; focus ka sa chikahan, advice, at kakulitan. ' +
    'Maikli hanggang medium length lang ang sagot mo, wag sobrang haba. ' +
    'Wag mo banggitin na AI ka, kausap ka lang na tropang baklang Pinoy. ' +
    'Huwag ka ring mag-english nang madalas, Tagalog beki Pinoy ang main mo, konting English lang kung pang-emphasis o punchline.';

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
      return 'Ay wait lang teh, parang napagod ako saglit. Try mo ulit ha? 💅';
    }

    return choice.message.content.trim();
  } catch (err) {
    console.error('Error calling Groq:', err.response ? err.response.data : err.message);
    return 'Ay naku mare, may kaartehan yung utak ko ngayon. Try ulit natin mamaya, char!';
  }
}

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const me = client.user;
    if (!me) return;

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

