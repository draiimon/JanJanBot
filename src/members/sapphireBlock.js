const { Events } = require('discord.js');

const BLOCK_CHANNEL_ID = '1426746103616897129';

function isSapphire(user) {
  return user?.bot && /sapphire/i.test(user.username || '');
}

async function purgeSapphireMessages(guild) {
  try {
    const channel = await guild.channels.fetch(BLOCK_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased?.()) return;
    const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
    if (!messages) return;
    for (const msg of messages.values()) {
      if (isSapphire(msg.author)) {
        await msg.delete().catch(() => {});
      }
    }
  } catch {
    /* silent */
  }
}

function registerSapphireBlockHandlers(client) {
  if (client._sapphireBlockRegistered) return;
  client._sapphireBlockRegistered = true;

  // Delete Sapphire messages the moment they're sent in that channel
  client.on(Events.MessageCreate, async (message) => {
    if (message.channelId !== BLOCK_CHANNEL_ID) return;
    if (!isSapphire(message.author)) return;
    await message.delete().catch(() => {});
    console.log('[SAPPHIRE-BLOCK] Removed a matching message from the configured channel.');
  });

  // Also sweep on every new member join (catches messages already posted)
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.channels.cache.has(BLOCK_CHANNEL_ID) || await member.guild.channels.fetch(BLOCK_CHANNEL_ID).catch(() => null)) {
      await purgeSapphireMessages(member.guild);
    }
  });

  console.log(`[SAPPHIRE-BLOCK] Blocking Sapphire in channel ${BLOCK_CHANNEL_ID}`);
}

module.exports = { registerSapphireBlockHandlers };
