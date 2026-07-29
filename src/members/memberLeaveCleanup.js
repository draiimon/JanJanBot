const { Events, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const { clearMemberIntro } = require('../intro/introSystem');
const { clearActivityRow, getGuildVerifyConfig } = require('../inactivity/inactivitySystem');
const { getGuildRoleMenuConfig } = require('../roleMenu/roleMenuSystem');
const { toSmallCaps } = require('../roleMenu/smallCaps');
const { isVerifyEmoji } = require('../verify/verifySystem');
const { generateWelcomeAttachment } = require('../welcome/welcomeCanvas');

const LEAVE_LOG_CHANNEL_ID = '1506595785574187039';

function getLeaveLogChannelId() {
  return LEAVE_LOG_CHANNEL_ID;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'Unknown';
  const days = Math.floor(ms / 86400000);
  if (days >= 365) return `${Math.floor(days / 365)} year(s), ${days % 365} day(s)`;
  if (days >= 1) return `${days} day(s)`;
  const hours = Math.max(1, Math.floor(ms / 3600000));
  return `${hours} hour(s)`;
}

function formatResetState(value) {
  return value ? '**Cleared**' : '**None**';
}

function getPhilippinesTime() {
  const now = new Date();
  const phTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
  const hh = phTime.getHours().toString().padStart(2, '0');
  const mm = phTime.getMinutes().toString().padStart(2, '0');
  return `Today at ${hh}:${mm}`;
}

async function prepareLogChannel(guild, clientUser) {
  const channelId = getLeaveLogChannelId();
  const [channel, me] = await Promise.all([
    guild.channels.fetch(channelId).catch(() => null),
    guild.members.me ? Promise.resolve(guild.members.me) : guild.members.fetchMe().catch(() => null),
  ]);
  if (!channel?.isTextBased?.()) return { channel: null, hook: null };
  const canManageWebhooks = channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks);
  if (!canManageWebhooks || !channel.fetchWebhooks) return { channel, hook: null };
  const hooks = await channel.fetchWebhooks().catch(() => null);
  let hook = hooks?.find((h) => h?.owner?.id === clientUser.id && h.name === 'PLAYGROUND Logs');
  if (!hook) {
    const guildIcon = guild.iconURL({ size: 512, extension: 'png', forceStatic: false }) || undefined;
    hook = await channel.createWebhook({ name: 'PLAYGROUND Logs', avatar: guildIcon, reason: 'Leave log webhook identity' }).catch(() => null);
  }
  return { channel, hook };
}

async function sendLeaveLog(member, result, prepared) {
  const { channel, hook } = prepared ?? {};
  if (!channel) return false;
  const user = member.user;
  const guild = member.guild;
  const guildName = guild.name || 'ᴘʟᴀʏ ɢʀᴏᴜɴᴅ';
  const guildIcon = guild.iconURL({ size: 512, extension: 'png', forceStatic: false }) || undefined;

  const stayedFor = member.joinedTimestamp
    ? `Stayed for ${formatDuration(Date.now() - member.joinedTimestamp)}.`
    : '';
  const leaveTime = getPhilippinesTime();

  let gifFile = null;
  try {
    const { buffer, filename } = await generateWelcomeAttachment({
      avatarURL: user.displayAvatarURL({ size: 512, extension: 'png', forceStatic: true }),
      username: user.displayName || user.username,
      serverName: guild.name,
      memberCount: guild.memberCount,
      mode: 'goodbye',
      stayedFor,
      leaveTime,
    });
    gifFile = new AttachmentBuilder(buffer, { name: filename });
  } catch (err) {
    console.warn('[MEMBER-LEAVE] goodbye GIF failed:', err.message);
  }

  const farewellLines = [
    `Goodbye, ${user}. We'll miss you!`,
    `**${user.tag}** has left **${guildName}**. ${stayedFor}`,
    `We hope to see you again someday. Take care!`,
  ];

  const payload = {
    content: farewellLines.join('\n'),
    embeds: [],
    ...(gifFile ? { files: [gifFile] } : {}),
  };

  if (hook) {
    await hook.send({ username: guildName, avatarURL: guildIcon, ...payload });
    return true;
  }
  await channel.send(payload);
  return true;
}

async function removeUserFromReaction(reaction, userId) {
  if (!reaction) return false;
  const users = await reaction.users.fetch().catch(() => null);
  if (!users?.has(userId)) return false;
  await reaction.users.remove(userId).catch(() => {});
  return true;
}

async function clearVerifyReaction(guild, userId) {
  const cfg = getGuildVerifyConfig(guild.id);
  if (!cfg?.channelId || !cfg?.messageId) return 0;

  const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return 0;

  const message = await channel.messages.fetch(cfg.messageId).catch(() => null);
  if (!message) return 0;

  let removed = 0;
  for (const reaction of message.reactions.cache.values()) {
    if (!isVerifyEmoji(reaction, cfg)) continue;
    if (await removeUserFromReaction(reaction, userId)) removed += 1;
  }
  return removed;
}

async function clearRoleMenuReactions(guild, userId) {
  const cfg = getGuildRoleMenuConfig(guild.id);
  if (!cfg?.channelId || !cfg?.messageIds?.length) return 0;

  const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return 0;

  let removed = 0;
  for (const messageId of cfg.messageIds) {
    if (!messageId) continue;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) continue;
    await message.fetch(true).catch(() => {});
    for (const reaction of message.reactions.cache.values()) {
      if (await removeUserFromReaction(reaction, userId)) removed += 1;
    }
  }
  return removed;
}

async function cleanupMemberAfterLeave(member) {
  if (!member?.guild || member.user?.bot) return { ok: false };

  const guildId = member.guild.id;
  const userId = member.id;
  const introCleared = clearMemberIntro(guildId, userId);
  const activityCleared = clearActivityRow(guildId, userId);

  // PRIORITY: prep log channel + send banner immediately. Cleanup runs in parallel.
  const preparedPromise = prepareLogChannel(member.guild, member.client.user).catch(() => ({
    channel: null,
    hook: null,
  }));

  const cleanupPromise = Promise.all([
    clearVerifyReaction(member.guild, userId).catch(() => 0),
    clearRoleMenuReactions(member.guild, userId).catch(() => 0),
  ]);

  // Send the leave banner ASAP — don't wait for reaction cleanup
  const prepared = await preparedPromise;
  const logSent = await sendLeaveLog(member, { ok: true }, prepared).catch((err) => {
    console.warn('[MEMBER-LEAVE] log send failed:', err.message);
    return false;
  });

  // Reaction cleanup keeps running in background; log when done
  cleanupPromise.then(([verifyReactionsRemoved, roleMenuReactionsRemoved]) => {
    console.log(
      `[MEMBER-LEAVE] Reset ${member.user.tag}: intro=${introCleared}, activity=${activityCleared}, ` +
        `verifyReactions=${verifyReactionsRemoved}, roleMenuReactions=${roleMenuReactionsRemoved}, log=${logSent}`,
    );
  });

  return { ok: true, introCleared, activityCleared, logSent };
}

function registerMemberLeaveCleanupHandlers(client) {
  if (client._memberLeaveCleanupRegistered) return;
  client._memberLeaveCleanupRegistered = true;

  client.on(Events.GuildMemberRemove, async (member) => {
    console.log(`[MEMBER-LEAVE] Event fired: ${member?.user?.tag ?? 'unknown'} (bot=${member?.user?.bot}) guild=${member?.guild?.id}`);
    try {
      await cleanupMemberAfterLeave(member);
    } catch (err) {
      console.error('[MEMBER-LEAVE] cleanup error:', err.message, err.stack);
    }
  });

  console.log('[MEMBER-LEAVE] Cleanup handlers registered');
}

module.exports = {
  registerMemberLeaveCleanupHandlers,
  cleanupMemberAfterLeave,
  clearVerifyReaction,
  clearRoleMenuReactions,
  sendLeaveLog,
};
