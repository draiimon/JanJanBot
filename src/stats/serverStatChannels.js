/**
 * Server stat voice channels.
 *
 * Manages a row of locked voice channels under a single category whose
 * names display live server statistics (members, humans, bots, verified,
 * boosts, roles, channels, online).
 *
 * Discord rate-limits channel renames to 2 per 10 minutes per channel,
 * so the periodic refresh runs every 10 minutes.
 */

const fs = require('fs');
const path = require('path');
const { Events, PermissionFlagsBits, ChannelType } = require('discord.js');
const { toSmallCaps } = require('../roleMenu/smallCaps');

const TARGET_GUILD_ID = '1426746102903738431';
const TARGET_CATEGORY_ID = '1506770610720870532';
const VERIFY_CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'verify-config.json');

/** Existing channels the user wants reorganized + the stat each should show. */
const EXISTING_CHANNEL_BINDINGS = [
  { id: '1507462000056205485', type: 'members',  label: 'Members',  emoji: '👥' },
  { id: '1507462001712955403', type: 'humans',   label: 'Humans',   emoji: '🧑' },
  { id: '1507462003487146084', type: 'bots',     label: 'Bots',     emoji: '🤖' },
  { id: '1506770622259396688', type: 'verified', label: 'Verified', emoji: '✅' },
  { id: '1506770628366307352', type: 'boosts',   label: 'Boosts',   emoji: '🚀' },
];

/** Additional stat channels to create if missing. */
const EXTRA_STATS = [
  { type: 'online',   label: 'Online',   emoji: '🟢' },
  { type: 'roles',    label: 'Roles',    emoji: '🎭' },
  { type: 'channels', label: 'Channels', emoji: '📺' },
];

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes. setName is a no-op if name unchanged, so rate limit isn't hit on idle ticks.

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function getVerifyRoleId(guildId) {
  return loadJson(VERIFY_CONFIG_PATH, {})[String(guildId)]?.roleId || null;
}

function formatChannelName(emoji, label, value) {
  const numStr = typeof value === 'number' ? value.toLocaleString() : String(value);
  return `${emoji} | ${toSmallCaps(label)} ➜ ${numStr}`.slice(0, 100);
}

const CATEGORY_DISPLAY_NAME = `✦ ${toSmallCaps('Server Stats')} ✦`;

async function computeStat(type, guild) {
  switch (type) {
    case 'members':
      return guild.memberCount;
    case 'humans':
      return guild.members.cache.filter((m) => !m.user.bot).size;
    case 'bots':
      return guild.members.cache.filter((m) => m.user.bot).size;
    case 'verified': {
      const roleId = getVerifyRoleId(guild.id);
      if (!roleId) return 0;
      return guild.members.cache.filter((m) => m.roles.cache.has(roleId)).size;
    }
    case 'boosts':
      return guild.premiumSubscriptionCount || 0;
    case 'roles':
      return Math.max(0, guild.roles.cache.size - 1); // exclude @everyone
    case 'channels':
      return guild.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory).size;
    case 'online':
      return guild.members.cache.filter((m) => {
        if (m.user.bot) return false;
        const status = m.presence?.status;
        return status === 'online' || status === 'idle' || status === 'dnd';
      }).size;
    default:
      return 0;
  }
}

async function moveChannelToCategory(channel) {
  if (channel.parentId === TARGET_CATEGORY_ID) return false;
  await channel.setParent(TARGET_CATEGORY_ID, { lockPermissions: false, reason: 'PLAYGROUND stat channels' });
  return true;
}

async function renameIfChanged(channel, newName) {
  if (channel.name === newName) return false;
  await channel.setName(newName, 'PLAYGROUND stat refresh');
  return true;
}

async function ensureExtraStatChannel(guild, def) {
  // Try to find an existing channel under the category whose name already matches this stat type.
  const category = await guild.channels.fetch(TARGET_CATEGORY_ID).catch(() => null);
  if (!category) return null;

  const existing = guild.channels.cache.find(
    (c) =>
      c.parentId === TARGET_CATEGORY_ID &&
      c.type === ChannelType.GuildVoice &&
      typeof c.name === 'string' &&
      c.name.includes(def.emoji),
  );
  if (existing) return existing;

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    console.warn('[STATS] Cannot create stat channel — missing Manage Channels');
    return null;
  }

  try {
    const created = await guild.channels.create({
      name: formatChannelName(def.emoji, def.label, '...'),
      type: ChannelType.GuildVoice,
      parent: TARGET_CATEGORY_ID,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
          allow: [PermissionFlagsBits.ViewChannel],
        },
      ],
      reason: 'PLAYGROUND stat channel auto-create',
    });
    console.log(`[STATS] Created ${def.type} channel: ${created.name}`);
    return created;
  } catch (err) {
    console.warn(`[STATS] Could not create ${def.type} channel:`, err.message);
    return null;
  }
}

async function refreshOne(guild, binding, channel) {
  if (!channel) return false;
  const value = await computeStat(binding.type, guild);
  const desired = formatChannelName(binding.emoji, binding.label, value);
  let changed = false;

  if (channel.parentId !== TARGET_CATEGORY_ID) {
    try {
      await moveChannelToCategory(channel);
      changed = true;
    } catch (err) {
      console.warn(`[STATS] Could not move ${channel.id} to category:`, err.message);
    }
  }

  try {
    if (await renameIfChanged(channel, desired)) changed = true;
  } catch (err) {
    console.warn(`[STATS] Could not rename ${channel.id}:`, err.message);
  }

  return changed;
}

async function refreshGuildStats(client) {
  const guild = await client.guilds.fetch(TARGET_GUILD_ID).catch(() => null);
  if (!guild) {
    console.warn('[STATS] Target guild not available');
    return;
  }

  // Make sure presence + members caches are fresh so humans/bots/online are accurate
  await guild.members.fetch().catch(() => {});

  // Rename the category
  try {
    const category = await guild.channels.fetch(TARGET_CATEGORY_ID).catch(() => null);
    if (category && category.name !== CATEGORY_DISPLAY_NAME) {
      await category.setName(CATEGORY_DISPLAY_NAME, 'PLAYGROUND stat category rename');
      console.log(`[STATS] Renamed category → ${CATEGORY_DISPLAY_NAME}`);
    }
  } catch (err) {
    console.warn('[STATS] Could not rename category:', err.message);
  }

  let updated = 0;

  // Existing bindings: try ID first, fall back to category emoji lookup,
  // finally auto-create. This makes "delete all and let the bot rebuild"
  // a valid recovery path.
  for (const binding of EXISTING_CHANNEL_BINDINGS) {
    let channel = await guild.channels.fetch(binding.id).catch(() => null);
    if (!channel) {
      channel = await ensureExtraStatChannel(guild, binding);
    }
    if (!channel) {
      console.warn(`[STATS] Channel for ${binding.type} could not be resolved or created`);
      continue;
    }
    if (await refreshOne(guild, binding, channel)) updated += 1;
  }

  // Extra stat channels — create if missing, then refresh
  for (const def of EXTRA_STATS) {
    const channel = await ensureExtraStatChannel(guild, def);
    if (!channel) continue;
    if (await refreshOne(guild, def, channel)) updated += 1;
  }

  // Sort the category's stat channels by the order in EXISTING_CHANNEL_BINDINGS + EXTRA_STATS
  try {
    const allOrder = [...EXISTING_CHANNEL_BINDINGS, ...EXTRA_STATS];
    const positionedIds = [];
    for (const def of allOrder) {
      let ch;
      if (def.id) {
        ch = await guild.channels.fetch(def.id).catch(() => null);
      } else {
        ch = guild.channels.cache.find(
          (c) => c.parentId === TARGET_CATEGORY_ID && c.name?.includes(def.emoji),
        );
      }
      if (ch?.parentId === TARGET_CATEGORY_ID) positionedIds.push(ch.id);
    }
    if (positionedIds.length > 0) {
      await guild.channels.setPositions(
        positionedIds.map((id, idx) => ({ channel: id, position: idx })),
      );
    }
  } catch (err) {
    console.warn('[STATS] Could not sort stat channels:', err.message);
  }

  if (updated > 0) console.log(`[STATS] Refreshed ${updated} stat channel(s)`);
}

function startServerStatsScheduler(client) {
  if (client._serverStatsStarted) return;
  client._serverStatsStarted = true;

  const run = () => {
    refreshGuildStats(client).catch((err) => {
      console.error('[STATS] Refresh error:', err.message);
    });
  };

  // First run a few seconds after Ready so caches settle
  setTimeout(run, 5_000);
  setInterval(run, REFRESH_INTERVAL_MS).unref?.();
  console.log(`[STATS] Server stats scheduler started (every ${REFRESH_INTERVAL_MS / 60_000}m)`);
}

function registerServerStatsHandlers(client) {
  if (client._serverStatsRegistered) return;
  client._serverStatsRegistered = true;

  // Trigger a refresh on every relevant change. Discord rate-limits channel
  // renames to 2 per 10 min per channel, but we still want the bot to TRY
  // immediately and let the next scheduled run mop up anything that got
  // rate-limited. 5s debounce coalesces bursts (e.g. role-update spam).
  const debounced = (() => {
    let timer = null;
    return () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refreshGuildStats(client).catch(() => {});
      }, 5_000);
    };
  })();

  // Members in/out → affects members, humans, bots, online (if presence intent on)
  client.on(Events.GuildMemberAdd, debounced);
  client.on(Events.GuildMemberRemove, debounced);
  // Role updates on a member → affects verified count
  client.on(Events.GuildMemberUpdate, (oldM, newM) => {
    if (oldM.roles.cache.size !== newM.roles.cache.size) debounced();
  });
  // Channel + role create/delete → affects channels, roles count
  client.on(Events.ChannelCreate, debounced);
  client.on(Events.ChannelDelete, debounced);
  client.on(Events.GuildRoleCreate, debounced);
  client.on(Events.GuildRoleDelete, debounced);
  // Boost level/count changes
  client.on(Events.GuildUpdate, (oldG, newG) => {
    if ((oldG.premiumSubscriptionCount || 0) !== (newG.premiumSubscriptionCount || 0)) {
      debounced();
    }
  });
}

module.exports = {
  registerServerStatsHandlers,
  startServerStatsScheduler,
  refreshGuildStats,
  TARGET_CATEGORY_ID,
};
