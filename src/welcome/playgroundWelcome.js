/**
 * Welcome: animated member card only (no server banner).
 */

const fs = require('fs');
const path = require('path');
const { Events, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { generateWelcomeAttachment } = require('./welcomeCanvas');
const { getServerDisplayName } = require('./welcomeFonts');

const LOG_CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'member-log-config.json');
const WEBHOOK_NAME = 'PLAYGROUND Welcome';

/** Role given to every new member on join (unverified default role). */
const DEFAULT_JOIN_ROLE_ID = '1426806943896309822';

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function getWelcomeChannelId(guildId) {
  const cfg = loadJson(LOG_CONFIG_PATH, {})[String(guildId)] || {};
  return cfg.welcomeChannelId || null;
}

async function getOrCreateWelcomeWebhook(channel) {
  const client = channel.client;
  const me = channel.guild.members.me || (await channel.guild.members.fetchMe().catch(() => null));
  if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) return null;

  const hooks = await channel.fetchWebhooks().catch(() => null);
  let hook = hooks?.find((h) => h?.owner?.id === client.user.id && h.name === WEBHOOK_NAME);
  if (!hook) {
    const guildIcon = channel.guild.iconURL({ size: 512, extension: 'png', forceStatic: false }) || undefined;
    hook = await channel
      .createWebhook({
        name: WEBHOOK_NAME,
        avatar: guildIcon,
        reason: 'PLAYGROUND welcome (server identity)',
      })
      .catch(() => null);
  }
  return hook;
}

async function resolveWelcomeChannel(member) {
  const channelId = getWelcomeChannelId(member.guild.id);
  if (channelId) {
    const ch = await member.guild.channels.fetch(channelId).catch(() => null);
    if (ch?.isTextBased?.()) return ch;
  }
  return (
    member.guild.systemChannel ??
    member.guild.channels.cache.find((ch) => ch.name === 'welcome' || ch.name === 'general') ??
    null
  );
}

async function sendPlaygroundWelcome(member) {
  const user = member.user;
  const guild = member.guild;
  if (!user || !guild || user.bot) return false;

  const channel = await resolveWelcomeChannel(member);
  if (!channel) {
    console.warn('[WELCOME] No welcome channel found.');
    return false;
  }

  const t0 = Date.now();
  const avatarURL = user.displayAvatarURL({ size: 512, extension: 'png', forceStatic: true });
  const username = user.displayName || user.username;

  const { buffer, filename, format } = await generateWelcomeAttachment({
    avatarURL,
    username,
    serverName: guild.name,
    memberCount: guild.memberCount,
  });

  const playgroundName = getServerDisplayName(guild.name);
  const playgroundIcon = guild.iconURL({ size: 512, extension: 'png', forceStatic: false }) || undefined;
  const hook = await getOrCreateWelcomeWebhook(channel);
  const identity = hook ? { username: playgroundName, avatarURL: playgroundIcon } : {};

  const welcomeLines = [
    `Welcome to **${playgroundName}**, ${user}.`,
    `We are glad to have you here. You are now member **#${guild.memberCount.toLocaleString()}** of this server.`,
    `Please take a moment to read the rules, explore the channels, and feel free to introduce yourself. We hope you enjoy your time here.`,
  ];

  await (hook || channel).send({
    ...identity,
    content: welcomeLines.join('\n'),
    files: [new AttachmentBuilder(buffer, { name: filename })],
    embeds: [],
  });

  console.log(
    `[WELCOME] Sent ${format} as ${playgroundName} for ${user.tag} → #${channel.name} (${Date.now() - t0}ms, ${(buffer.length / 1024).toFixed(0)}KB)`
  );
  return true;
}

async function assignDefaultJoinRole(member) {
  if (!member?.guild || member.user?.bot) return false;
  if (member.roles.cache.has(DEFAULT_JOIN_ROLE_ID)) return true;

  const role = await member.guild.roles.fetch(DEFAULT_JOIN_ROLE_ID).catch(() => null);
  if (!role) {
    console.warn(`[WELCOME] Default role ${DEFAULT_JOIN_ROLE_ID} not found in guild ${member.guild.id}`);
    return false;
  }

  // Bot's role must be higher than the role being assigned
  const me = member.guild.members.me;
  if (me && role.comparePositionTo(me.roles.highest) >= 0) {
    console.warn(`[WELCOME] Cannot assign role ${role.name} — bot's role is not above it`);
    return false;
  }

  await member.roles.add(role, 'Default unverified role on join');
  console.log(`[WELCOME] Assigned default role ${role.name} to ${member.user.tag}`);
  return true;
}

function registerPlaygroundWelcomeHandlers(client) {
  if (client._playgroundWelcomeRegistered) return;
  client._playgroundWelcomeRegistered = true;

  client.on(Events.GuildMemberAdd, async (member) => {
    // Assign default unverified role in parallel with welcome banner
    assignDefaultJoinRole(member).catch((err) =>
      console.warn('[WELCOME] Default role failed:', err.message),
    );

    try {
      await sendPlaygroundWelcome(member);
    } catch (err) {
      console.error('[WELCOME] GuildMemberAdd:', err.message);
    }
  });

  console.log('[WELCOME] Member card video/GIF (webhook) registered');
}

module.exports = {
  registerPlaygroundWelcomeHandlers,
  sendPlaygroundWelcome,
  assignDefaultJoinRole,
  getWelcomeChannelId,
  resolveWelcomeChannel,
  DEFAULT_JOIN_ROLE_ID,
};
