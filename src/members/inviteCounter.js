const { Events, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { generateChannelBanner } = require('../welcome/welcomeCanvas');
const { toSmallCaps } = require('../roleMenu/smallCaps');

const sc = toSmallCaps; // shorthand

/** Channel where invite events are logged. */
const INVITE_LOG_CHANNEL_ID = '1427125511699828929';
const WEBHOOK_NAME = 'PLAYGROUND Invites';

/** Per-guild cache: Map<inviteCode, { uses, inviterId, inviterTag, channelId }> */
const inviteCache = new Map();

const COLOR_CREATED = 0x00e6ff;   // cyan
const COLOR_DELETED = 0xff00c8;   // pink
const COLOR_JOINED = 0xa000ff;    // purple
const COLOR_UNKNOWN = 0xffaa00;   // amber

function getGuildCache(guildId) {
  if (!inviteCache.has(guildId)) inviteCache.set(guildId, new Map());
  return inviteCache.get(guildId);
}

function inviteSnapshot(invite) {
  return {
    uses: invite.uses ?? 0,
    inviterId: invite.inviter?.id || null,
    inviterTag: invite.inviter?.tag || invite.inviter?.username || 'Unknown',
    inviterAvatar: invite.inviter?.displayAvatarURL?.({ size: 128, extension: 'png' }) || null,
    channelId: invite.channelId || invite.channel?.id || null,
    channelName: invite.channel?.name || null,
    expiresTimestamp: invite.expiresTimestamp || null,
    maxUses: invite.maxUses ?? 0,
  };
}

async function refreshGuildInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    const cache = getGuildCache(guild.id);
    cache.clear();
    for (const invite of invites.values()) {
      cache.set(invite.code, inviteSnapshot(invite));
    }
    return cache;
  } catch (err) {
    console.warn(`[INVITES] Could not fetch invites for ${guild.id}:`, err.message);
    return null;
  }
}

async function getLogWebhook(guild, clientUser) {
  const channel = await guild.channels.fetch(INVITE_LOG_CHANNEL_ID).catch((err) => {
    console.warn(`[INVITES] Could not fetch channel ${INVITE_LOG_CHANNEL_ID}:`, err.message);
    return null;
  });
  if (!channel) {
    console.warn(`[INVITES] Channel ${INVITE_LOG_CHANNEL_ID} not found in guild ${guild.id}`);
    return { channel: null, hook: null };
  }
  if (!channel.isTextBased?.()) {
    console.warn(`[INVITES] Channel ${INVITE_LOG_CHANNEL_ID} is not text-based`);
    return { channel: null, hook: null };
  }

  const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    console.warn('[INVITES] Bot member not in guild cache');
    return { channel, hook: null };
  }

  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) {
    console.warn(`[INVITES] Bot lacks View/Send permission in ${INVITE_LOG_CHANNEL_ID}`);
    return { channel: null, hook: null };
  }
  if (!perms.has(PermissionFlagsBits.ManageWebhooks)) {
    console.warn(`[INVITES] Bot lacks ManageWebhooks — falling back to channel.send`);
    return { channel, hook: null };
  }

  const hooks = await channel.fetchWebhooks().catch((err) => {
    console.warn('[INVITES] fetchWebhooks failed:', err.message);
    return null;
  });
  let hook = hooks?.find((h) => h?.owner?.id === clientUser.id && h.name === WEBHOOK_NAME);
  if (!hook) {
    const guildIcon = guild.iconURL({ size: 512, extension: 'png', forceStatic: false }) || undefined;
    hook = await channel
      .createWebhook({ name: WEBHOOK_NAME, avatar: guildIcon, reason: 'PLAYGROUND invite counter' })
      .catch((err) => {
        console.warn('[INVITES] createWebhook failed:', err.message);
        return null;
      });
    if (hook) console.log(`[INVITES] Created webhook "${WEBHOOK_NAME}" in ${channel.name}`);
  }
  return { channel, hook };
}

function formatExpires(expiresTimestamp) {
  if (!expiresTimestamp) return 'Never';
  const remainingMs = expiresTimestamp - Date.now();
  if (remainingMs <= 0) return 'Expired';
  const days = Math.floor(remainingMs / 86_400_000);
  const hours = Math.floor((remainingMs % 86_400_000) / 3_600_000);
  if (days >= 1) return `in ${days} day${days === 1 ? '' : 's'}`;
  if (hours >= 1) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  return 'in <1 hour';
}

function formatMaxUses(maxUses) {
  return !maxUses || maxUses <= 0 ? '∞' : String(maxUses);
}

/** Cached banner buffers — pre-generated once on startup so each invite event posts instantly. */
const bannerCache = new Map(); // key -> Buffer

async function preGenerateBanners() {
  // Canvas uses Orbitron/Rajdhani — fonts don't have small-caps glyphs,
  // so titles MUST be regular ASCII or they render as tofu boxes.
  // The neon styling (glow, color, layout) applies the same.
  // Subtitles are intentionally distinct from the top 'PLAY GROUND' tag
  // (which the banner template renders automatically) — avoids redundancy.
  const defs = [
    { key: 'created', title: 'INVITE CREATED', subtitle: 'A new gateway opened', accentHex: '#00e6ff' },
    { key: 'deleted', title: 'INVITE DELETED', subtitle: 'A gateway closed',     accentHex: '#ff00c8' },
    { key: 'joined',  title: 'NEW MEMBER',     subtitle: 'Welcome to the crew',  accentHex: '#a000ff' },
  ];
  for (const def of defs) {
    try {
      const { buffer } = await generateChannelBanner({
        title: def.title,
        subtitle: def.subtitle,
        accentHex: def.accentHex,
        filename: `invite-${def.key}.gif`,
      });
      bannerCache.set(def.key, buffer);
      console.log(`[INVITES] Pre-generated ${def.key} banner (${buffer.length} bytes)`);
    } catch (err) {
      console.warn(`[INVITES] Pre-gen ${def.key} banner failed:`, err.message);
    }
  }
}

function buildBanner(key) {
  const buffer = bannerCache.get(key);
  if (!buffer) return null;
  return new AttachmentBuilder(buffer, { name: `invite-${key}.gif` });
}

async function postViaWebhook(guild, clientUser, embed, banner) {
  const { channel, hook } = await getLogWebhook(guild, clientUser);
  if (!channel) return false;
  const guildIcon = guild.iconURL({ size: 512, extension: 'png', forceStatic: false }) || undefined;

  const files = banner ? [banner] : [];
  if (banner) embed.setImage(`attachment://${banner.name}`);

  const payload = { embeds: [embed], files };

  if (hook) {
    await hook
      .send({ username: 'JanJan', avatarURL: guildIcon, ...payload })
      .catch((err) => console.warn('[INVITES] Webhook send failed:', err.message));
    return true;
  }
  await channel.send(payload).catch((err) => console.warn('[INVITES] Channel send failed:', err.message));
  return true;
}

function buildInviteCreatedEmbed(invite) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_CREATED)
    .setTitle(`🎟️  ${sc('Invite Created')}`)
    .setDescription(
      `**${sc('Code')}:** \`${invite.code}\`\n` +
        `**${sc('Channel')}:** <#${invite.channelId}>\n` +
        `**${sc('Expires')}:** ${formatExpires(invite.expiresTimestamp)}\n` +
        `**${sc('Max Uses')}:** ${formatMaxUses(invite.maxUses)}`,
    )
    .setTimestamp(new Date());

  if (invite.inviter) {
    embed.setFooter({
      text: sc(`By ${invite.inviter.tag || invite.inviter.username}`),
      iconURL: invite.inviter.displayAvatarURL({ size: 128, extension: 'png' }),
    });
  }
  return embed;
}

function buildInviteDeletedEmbed(snapshot, code) {
  return new EmbedBuilder()
    .setColor(COLOR_DELETED)
    .setTitle(`🗑️  ${sc('Invite Deleted')}`)
    .setDescription(
      `**${sc('Code')}:** \`${code}\`\n` +
        `**${sc('Channel')}:** ${snapshot?.channelId ? `<#${snapshot.channelId}>` : sc('Unknown')}\n` +
        `**${sc('Total Uses While Active')}:** ${snapshot?.uses ?? '?'}`,
    )
    .setTimestamp(new Date());
}

function buildMemberJoinedEmbed(member, invite, snapshot) {
  const inviterDisplay = invite.inviter
    ? `<@${invite.inviter.id}>`
    : snapshot?.inviterTag || sc('Unknown');

  const embed = new EmbedBuilder()
    .setColor(COLOR_JOINED)
    .setTitle(`🎉  ${sc('New Member Joined')}`)
    .setDescription(
      `${member.user} **${member.user.tag}**\n\n` +
        `**${sc('Via')}:** \`${invite.code}\`\n` +
        `**${sc('Inviter')}:** ${inviterDisplay}\n` +
        `**${sc('Total Uses')}:** ${invite.uses}\n` +
        `**${sc('Channel')}:** <#${invite.channelId}>`,
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256, extension: 'png', forceStatic: false }))
    .setTimestamp(new Date());

  if (invite.inviter) {
    embed.setFooter({
      text: sc(`Invited by ${invite.inviter.tag || invite.inviter.username}`),
      iconURL: invite.inviter.displayAvatarURL({ size: 128, extension: 'png' }),
    });
  }
  return embed;
}

function buildUnknownJoinEmbed(member) {
  return new EmbedBuilder()
    .setColor(COLOR_UNKNOWN)
    .setTitle(`🎉  ${sc('New Member Joined')}`)
    .setDescription(
      `${member.user} **${member.user.tag}**\n\n` +
        `_${sc('Invite source unknown — vanity URL, server discovery, or invite tracking lag.')}_`,
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256, extension: 'png', forceStatic: false }))
    .setTimestamp(new Date());
}

function registerInviteCounterHandlers(client) {
  if (client._inviteCounterRegistered) return;
  client._inviteCounterRegistered = true;

  client.once(Events.ClientReady, async () => {
    // Pre-generate banners in parallel with invite cache refresh
    await Promise.all([
      preGenerateBanners(),
      ...Array.from(client.guilds.cache.values()).map((g) => refreshGuildInvites(g)),
    ]);
    console.log('[INVITES] Banners pre-generated + invite cache ready');
  });

  client.on(Events.InviteCreate, async (invite) => {
    const guild = invite.guild;
    if (!guild) return;

    const cache = getGuildCache(guild.id);
    cache.set(invite.code, inviteSnapshot(invite));

    await postViaWebhook(guild, client.user, buildInviteCreatedEmbed(invite), buildBanner('created'));
  });

  client.on(Events.InviteDelete, async (invite) => {
    const guild = invite.guild;
    if (!guild) return;

    const cache = getGuildCache(guild.id);
    const snapshot = cache.get(invite.code);
    cache.delete(invite.code);

    await postViaWebhook(guild, client.user, buildInviteDeletedEmbed(snapshot, invite.code), buildBanner('deleted'));
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.user.bot) return;

    let invitesNow;
    try {
      invitesNow = await member.guild.invites.fetch();
    } catch (err) {
      console.warn('[INVITES] Could not fetch invites on member join:', err.message);
      await postViaWebhook(member.guild, client.user, buildUnknownJoinEmbed(member), buildBanner('joined'));
      return;
    }

    const cache = getGuildCache(member.guild.id);
    let usedInvite = null;

    for (const invite of invitesNow.values()) {
      const prev = cache.get(invite.code);
      if (!prev) {
        if (invite.uses > 0) {
          usedInvite = invite;
          break;
        }
        continue;
      }
      if (invite.uses > prev.uses) {
        usedInvite = invite;
        break;
      }
    }

    // Refresh cache with new counts
    cache.clear();
    for (const invite of invitesNow.values()) {
      cache.set(invite.code, inviteSnapshot(invite));
    }

    if (usedInvite) {
      await postViaWebhook(
        member.guild,
        client.user,
        buildMemberJoinedEmbed(member, usedInvite, cache.get(usedInvite.code)),
        buildBanner('joined'),
      );
    } else {
      await postViaWebhook(member.guild, client.user, buildUnknownJoinEmbed(member), buildBanner('joined'));
    }
  });

  console.log(`[INVITES] Invite counter handlers registered (channel ${INVITE_LOG_CHANNEL_ID})`);
}

module.exports = {
  registerInviteCounterHandlers,
  refreshGuildInvites,
  INVITE_LOG_CHANNEL_ID,
};
