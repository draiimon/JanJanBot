const { EmbedBuilder, ActivityType } = require('discord.js');

function getBotCustomStatusText(client) {
  const activities = client.user?.presence?.activities || [];
  const custom = activities.find((a) => a.type === ActivityType.Custom);
  if (custom?.state) return custom.state;
  if (custom?.name && custom.name !== 'Custom Status') return custom.name;
  const playing = activities.find((a) => a.type !== ActivityType.Custom);
  if (playing?.name) return playing.name;
  return null;
}

function formatUptime(bootedAtIso) {
  if (!bootedAtIso) return '—';
  const ms = Date.now() - new Date(bootedAtIso).getTime();
  if (ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function statusDot(client, runtimeState) {
  if (!client?.isReady?.()) return 'Offline';
  if (runtimeState?.database?.connected === false && runtimeState?.database?.configured) {
    return 'Online (database issue)';
  }
  const ping = client.ws?.ping ?? 0;
  if (ping > 400) return 'Online (high latency)';
  return 'Online';
}

/** Bot health dashboard — member intro/roles are on `j!view`. */
function buildStatsEmbed({ client, runtimeState, guild }) {
  const bubble = getBotCustomStatusText(client);
  const dot = statusDot(client, runtimeState);
  const ping = client.ws?.ping ?? 0;
  const uptime = formatUptime(runtimeState?.service?.bootedAt);
  const dbOk = runtimeState?.database?.connected;
  const voiceStatus = runtimeState?.voice?.connectionStatus || 'idle';

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({
      name: 'JANJAN · STATS',
      iconURL: client.user.displayAvatarURL({ size: 128 }),
    })
    .setTitle('Bot dashboard')
    .setDescription(
      `**${dot}** · Ping **${ping}**ms · Uptime **${uptime}**\n` +
        (bubble
          ? `**Bubble:** *${bubble.slice(0, 120)}${bubble.length > 120 ? '…' : ''}*`
          : '**Bubble:** *Not set* — admin: `j!status <text>`'),
    )
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .addFields(
      {
        name: 'Systems',
        value:
          `**Discord** ${client.isReady() ? 'Ready' : 'Starting'}\n` +
          `**Database** ${dbOk ? 'Connected' : runtimeState?.database?.configured ? 'Issue' : 'N/A'}\n` +
          `**Voice** \`${voiceStatus}\``,
        inline: true,
      },
      {
        name: 'Scale',
        value: `**Servers** ${client.guilds.cache.size}\n**Users** ${client.users.cache.size}`,
        inline: true,
      },
      {
        name: 'Member profile',
        value: 'Use **`j!view`** for introduction, roles, and verify progress.',
        inline: false,
      },
    )
    .setFooter({ text: `j!stats · ${guild?.name || 'ᴘʟᴀʏ ɢʀᴏᴜɴᴅ'}`, iconURL: guild?.iconURL?.({ size: 64 }) })
    .setTimestamp();
}

/** Bot custom-status bubble (`j!status`). */
function buildStatusViewEmbed({ client, runtimeState, guild, isAdmin }) {
  const bubble = getBotCustomStatusText(client);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({
      name: 'JANJAN · STATUS',
      iconURL: client.user.displayAvatarURL({ size: 128 }),
    })
    .setTitle('Bot bubble status')
    .setDescription(
      bubble
        ? `**Current bubble**\n*${bubble}*`
        : '**Current bubble**\n*Not set.*',
    )
    .addFields(
      {
        name: 'Live',
        value: `${statusDot(client, runtimeState)} · **${client.ws?.ping ?? 0}**ms ping`,
        inline: true,
      },
      {
        name: 'Uptime',
        value: formatUptime(runtimeState?.service?.bootedAt),
        inline: true,
      },
      {
        name: isAdmin ? 'Admin' : 'Info',
        value: isAdmin
          ? 'Set bubble:\n`j!status <message>`\n\nExample: `j!status Listening to the server`'
          : 'Only **admins** can change the bot bubble.\nMember card: `j!view`',
        inline: false,
      },
    )
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `${guild.name} · j!status`, iconURL: guild.iconURL({ size: 64 }) || undefined })
    .setTimestamp();
}

function buildBubbleUpdatedEmbed(text, guild, adminTag) {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setAuthor({
      name: 'STATUS UPDATED',
      iconURL: guild.client?.user?.displayAvatarURL?.({ size: 128 }),
    })
    .setTitle('Bot bubble set')
    .setDescription(`**New bubble**\n*${text.slice(0, 128)}*`)
    .addFields({
      name: 'Live',
      value: `Updated by **${adminTag}** · Member card: \`j!view\``,
      inline: false,
    })
    .setFooter({ text: 'JanJan · j!status' })
    .setTimestamp();
}

module.exports = {
  buildStatsEmbed,
  buildStatusViewEmbed,
  buildBubbleUpdatedEmbed,
  getBotCustomStatusText,
};
