/**
 * Daily verification-reminder system.
 *
 * Once per day at 10:00 PM Asia/Manila:
 *   1. Auto-grants the Verified role to any unverified member who already
 *      has a complete intro + required role-menu picks (intro/age/rel/game).
 *   2. Deletes yesterday's reminder message (channel always holds 1).
 *   3. Posts a fresh reminder pinging the @Unverified role, listing each
 *      still-unverified member with their personalized next step.
 */

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { hasRoleMenuIdentity, getMemberIntro } = require('../intro/introSystem');
const { generateChannelBanner } = require('../welcome/welcomeCanvas');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'verify-reminder-config.json');
const VERIFY_CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'verify-config.json');
const UNVERIFIED_ROLE_ID = '1426806943896309822';
const VERIFY_CHANNEL_ID = '1506243835708313681';
const INTRO_CHANNEL_ID = '1506284754818044019';
const GET_ROLE_CHANNEL_ID = '1426746103616897130';
const WEBHOOK_NAME = 'PLAYGROUND Reminder';

/** Cached banner buffer — generated once per process. */
let bannerBuffer = null;

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return fallback; }
}
function saveJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}
function loadConfig() { return loadJson(CONFIG_PATH, {}); }
function getGuildConfig(guildId) { return loadConfig()[String(guildId)] || null; }
function setGuildConfig(guildId, patch) {
  const all = loadConfig();
  all[String(guildId)] = { ...(all[String(guildId)] || {}), ...patch };
  saveJson(CONFIG_PATH, all);
}
function getVerifyRoleId(guildId) {
  return loadJson(VERIFY_CONFIG_PATH, {})[String(guildId)]?.roleId || null;
}

async function getReminderBanner() {
  if (bannerBuffer) return bannerBuffer;
  try {
    const { buffer } = await generateChannelBanner({
      title: 'VERIFY REMINDER',
      subtitle: 'COMPLETE YOUR ACCESS',
      accentHex: '#ff00c8',
      filename: 'verify-reminder.gif',
    });
    bannerBuffer = buffer;
    return bannerBuffer;
  } catch (err) {
    console.warn('[VERIFY-REMINDER] Banner generation failed:', err.message);
    return null;
  }
}

async function getOrCreateWebhook(channel, clientUser) {
  const me = channel.guild.members.me;
  if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) {
    return null;
  }
  const hooks = await channel.fetchWebhooks().catch(() => null);
  let hook = hooks?.find((h) => h?.owner?.id === clientUser.id && h.name === WEBHOOK_NAME);
  if (!hook) {
    const icon = channel.guild.iconURL({ size: 512, extension: 'png' }) || undefined;
    hook = await channel
      .createWebhook({ name: WEBHOOK_NAME, avatar: icon, reason: 'Verify reminder webhook' })
      .catch(() => null);
  }
  return hook;
}

/**
 * Classify a member.
 *   - 'ready'      : full intro + roles → auto-grant Verified on the daily cycle
 *   - 'incomplete' : missing intro and/or role-menu picks → list in reminder
 */
function classifyMember(member, guildId) {
  const intro = getMemberIntro(guildId, member.id);
  const roles = hasRoleMenuIdentity(member, guildId);
  const introComplete = Boolean(intro?.complete);
  const allReady = introComplete && roles.ok;

  if (allReady) {
    return { status: 'ready', missing: [] };
  }
  const missing = [];
  if (!introComplete) missing.push('intro');
  if (roles.missingAge) missing.push('age');
  if (roles.missingRel) missing.push('relationship');
  if (roles.missingGames) missing.push('game');
  return { status: 'incomplete', missing };
}

/** Format the line for one member. Uses <@id> mention so they get pinged. */
function statusLine(member, classify) {
  const tag = `<@${member.id}>`;
  const parts = [];
  if (classify.missing.includes('intro')) parts.push('intro');
  if (classify.missing.includes('age')) parts.push('age role');
  if (classify.missing.includes('relationship')) parts.push('relationship role');
  if (classify.missing.includes('game')) parts.push('at least 1 game role');
  return `⚠️ ${tag} — Needs: ${parts.join(', ')}`;
}

function buildReminderEmbed(statuses, autoVerifiedCount) {
  const embed = new EmbedBuilder()
    .setColor(0xff00c8)
    .setTitle('🌙  GOOD EVENING — Verify Reminder')
    .setDescription(
      `Daily check-in at **10:00 PM** (Asia/Manila).\n\n` +
        `Finish your intro + required roles to unlock the full server. ` +
        `**Verified access stays permanent** — no activity deadline.\n\n` +
        (autoVerifiedCount > 0
          ? `✅ **${autoVerifiedCount}** member(s) were auto-verified this cycle.\n`
          : '') +
        `**${statuses.length}** member(s) still need to complete verification.`,
    )
    .setTimestamp(new Date());

  if (statuses.length > 0) {
    const lines = statuses.map(({ member, classify }) =>
      statusLine(member, classify, false),
    );
    const chunks = [];
    let cur = '';
    for (const line of lines) {
      if ((cur + '\n' + line).length > 1000) {
        chunks.push(cur);
        cur = line;
      } else {
        cur = cur ? cur + '\n' + line : line;
      }
    }
    if (cur) chunks.push(cur);
    for (let i = 0; i < chunks.length && i < 5; i++) {
      embed.addFields({
        name: i === 0 ? `Member status (${statuses.length})` : '​',
        value: chunks[i],
      });
    }
  } else {
    embed.addFields({ name: 'Member status', value: 'Everyone is verified. 🎉' });
  }

  embed.addFields({
    name: 'How to verify',
    value:
      `**1.** Post your intro in <#${INTRO_CHANNEL_ID}>\n` +
      `**2.** Pick your age + relationship + at least one game role in <#${GET_ROLE_CHANNEL_ID}>\n` +
      `**3.** Once those are done, the bot **auto-verifies you on the next 10:00 PM cycle** — ` +
      `or react **👾** anytime on <#${VERIFY_CHANNEL_ID}>.\n\n` +
      `Check your progress anytime: \`j!view\``,
  });

  return embed;
}

/**
 * Run the full daily cycle:
 *   - Auto-grant Verified to ready members
 *   - Delete previous reminder message
 *   - Post fresh reminder
 */
async function sendVerificationReminder(client, guildId) {
  const cfg = getGuildConfig(guildId);
  if (!cfg?.channelId) {
    console.warn(`[VERIFY-REMINDER] No channel configured for guild ${guildId}`);
    return { ok: false, reason: 'no-channel' };
  }
  const verifiedRoleId = getVerifyRoleId(guildId);
  if (!verifiedRoleId) {
    console.warn(`[VERIFY-REMINDER] No verified role configured for guild ${guildId}`);
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return { ok: false, reason: 'no-guild' };

  const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { ok: false, reason: 'no-channel' };

  await guild.members.fetch().catch(() => {});

  // PASS 1: scan all unverified, auto-verify any who are 'ready'
  const statuses = [];
  let autoVerifiedCount = 0;

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    if (!member.roles.cache.has(UNVERIFIED_ROLE_ID)) continue;

    const classify = classifyMember(member, guildId);

    if (classify.status === 'ready' && verifiedRoleId) {
      try {
        const verifiedRole = guild.roles.cache.get(verifiedRoleId);
        if (verifiedRole && !member.roles.cache.has(verifiedRoleId)) {
          await member.roles.add(verifiedRole, 'Auto-verified by daily reminder system: profile complete');
        }
        if (member.roles.cache.has(UNVERIFIED_ROLE_ID)) {
          await member.roles.remove(UNVERIFIED_ROLE_ID, 'Auto-verified: graduated from unverified');
        }
        autoVerifiedCount += 1;
        console.log(`[VERIFY-REMINDER] Auto-verified ${member.user.tag}`);
        // intentionally not pushed to statuses — message is for still-unverified only
      } catch (err) {
        console.warn(`[VERIFY-REMINDER] Could not auto-verify ${member.user.tag}:`, err.message);
        statuses.push({ member, classify, autoVerified: false });
      }
    } else {
      statuses.push({ member, classify, autoVerified: false });
    }
  }

  // PASS 2: delete previous reminder message
  const prevId = cfg.messageId;
  if (prevId) {
    const prevMsg = await channel.messages.fetch(prevId).catch(() => null);
    if (prevMsg?.deletable) {
      await prevMsg.delete().catch((err) => {
        console.warn(`[VERIFY-REMINDER] Could not delete previous message:`, err.message);
      });
    }
  }

  // PASS 3: post fresh reminder
  const embed = buildReminderEmbed(statuses, autoVerifiedCount);
  const banner = await getReminderBanner();
  const files = [];
  if (banner) {
    files.push(new AttachmentBuilder(banner, { name: 'verify-reminder.gif' }));
    embed.setImage('attachment://verify-reminder.gif');
  }

  const content = `<@&${UNVERIFIED_ROLE_ID}>`;
  const hook = await getOrCreateWebhook(channel, client.user);
  const guildIcon = guild.iconURL({ size: 512, extension: 'png' }) || undefined;

  let sent;
  if (hook) {
    sent = await hook
      .send({
        username: 'JanJan',
        avatarURL: guildIcon,
        content,
        embeds: [embed],
        files,
        allowedMentions: { roles: [UNVERIFIED_ROLE_ID] },
      })
      .catch((err) => {
        console.warn('[VERIFY-REMINDER] Webhook send failed:', err.message);
        return null;
      });
  } else {
    sent = await channel
      .send({
        content,
        embeds: [embed],
        files,
        allowedMentions: { roles: [UNVERIFIED_ROLE_ID] },
      })
      .catch((err) => {
        console.warn('[VERIFY-REMINDER] Channel send failed:', err.message);
        return null;
      });
  }

  if (!sent) return { ok: false, reason: 'send-failed' };

  setGuildConfig(guildId, {
    messageId: sent.id,
    lastSentAt: new Date().toISOString(),
  });
  console.log(
    `[VERIFY-REMINDER] Sent reminder → ${sent.id} | auto-verified: ${autoVerifiedCount} | still pending: ${statuses.length - autoVerifiedCount}`,
  );
  return { ok: true, messageId: sent.id, autoVerifiedCount, pendingCount: statuses.length - autoVerifiedCount };
}

/** Asia/Manila wall clock. */
function getPHTime() {
  const now = new Date();
  const hm = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const [hour, minute] = hm.split(':').map(Number);
  const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now);
  return { hour, minute, dateKey };
}

function startVerifyReminderScheduler(client) {
  if (client._verifyReminderStarted) return;
  client._verifyReminderStarted = true;

  // Check every minute. Fire exactly once per day when PHT hits 22:00.
  const tick = async () => {
    const { hour, minute, dateKey } = getPHTime();
    const all = loadConfig();
    for (const [guildId, cfg] of Object.entries(all)) {
      if (!cfg?.channelId) continue;
      if (hour === 22 && minute === 0 && cfg.lastFireKey !== dateKey) {
        setGuildConfig(guildId, { lastFireKey: dateKey });
        sendVerificationReminder(client, guildId).catch((err) =>
          console.error('[VERIFY-REMINDER] send error:', err.message),
        );
      }
    }
  };

  setInterval(tick, 60_000).unref?.();
  setTimeout(tick, 5_000); // recover if bot was down during 22:00 fire window
  console.log('[VERIFY-REMINDER] Scheduler started (22:00 PHT daily, single message)');
}

module.exports = {
  sendVerificationReminder,
  startVerifyReminderScheduler,
  getGuildConfig,
  setGuildConfig,
  UNVERIFIED_ROLE_ID,
};
