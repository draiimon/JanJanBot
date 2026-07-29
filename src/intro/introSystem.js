const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ChannelType, PermissionsBitField, AttachmentBuilder } = require('discord.js');
const { generateChannelBanner } = require('../welcome/welcomeCanvas');
const { getOrCreateGuildWebhook } = require('../utils/guildWebhook');
const {
  INTRO_FIELDS,
  getIntroTemplate,
  capsLabel,
  parseIntroText,
  isIntroComplete,
  missingIntroLabels,
  isRandomIntroChat,
  buildIntroFormatReminder,
  toSmallCaps,
} = require('./introFields');
const { getGuildRoleMenuConfig } = require('../roleMenu/roleMenuSystem');
const { GROUPS } = require('../roleMenu/definitions');
const { collectRoleMenuPicks } = require('../stats/roleMenuPicks');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'intro-config.json');
const PROFILES_PATH = path.join(__dirname, '..', '..', 'data', 'member-intros.json');

const DEFAULT_GUILD = '1426746102903738431';
const DEFAULT_GET_ROLE_CHANNEL = '1426746103616897130';
/** Pinned introduction channel. */
const PINNED_INTRO_CHANNEL_ID = '1506284754818044019';

/** Channel names that must never be used as the intro channel. */
const INTRO_CHANNEL_BLOCK_RE = /spawn|verify|rules|get-role|get_role|chit-chat/i;

/** Per-user cooldown so random-chat reminders do not spam the channel. */
const introReminderAt = new Map();
const INTRO_REMINDER_COOLDOWN_MS = 45_000;

function isIntroChannel(channel) {
  if (!channel?.isTextBased?.()) return false;
  const name = channel.name || '';
  if (INTRO_CHANNEL_BLOCK_RE.test(name)) return false;
  return (
    name === '📝︱introduction' ||
    name === 'introduction' ||
    /^📝/.test(name) ||
    /\bintro/i.test(name)
  );
}

function getIntroChannelId(guildId) {
  return getGuildIntroConfig(guildId)?.channelId || PINNED_INTRO_CHANNEL_ID;
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function loadIntroConfig() {
  return loadJson(CONFIG_PATH, {});
}

function saveIntroConfig(config) {
  saveJson(CONFIG_PATH, config);
}

function getGuildIntroConfig(guildId) {
  const all = loadIntroConfig();
  return all[String(guildId)] || null;
}

function loadMemberIntros() {
  return loadJson(PROFILES_PATH, {});
}

function saveMemberIntros(all) {
  saveJson(PROFILES_PATH, all);
}

function profileKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getMemberIntro(guildId, userId) {
  const all = loadMemberIntros();
  const row = all[profileKey(guildId, userId)];
  if (!row) return null;
  return {
    ...row,
    complete: isIntroComplete(row.fields || {}),
  };
}

function clearMemberIntroByMessageId(guildId, messageId) {
  const all = loadMemberIntros();
  const prefix = `${guildId}:`;
  for (const [key, row] of Object.entries(all)) {
    if (!key.startsWith(prefix)) continue;
    if (String(row.messageId) === String(messageId)) {
      delete all[key];
      saveMemberIntros(all);
      const userId = key.slice(prefix.length);
      return userId;
    }
  }
  return null;
}

function clearMemberIntro(guildId, userId) {
  const all = loadMemberIntros();
  const key = profileKey(guildId, userId);
  if (!all[key]) return false;
  delete all[key];
  saveMemberIntros(all);
  return true;
}

/** Save intro — new message fully replaces the previous one (redo/update). */
function saveMemberIntro(guildId, userId, fields, messageId = null, { replace = true } = {}) {
  const all = loadMemberIntros();
  const key = profileKey(guildId, userId);
  const prev = all[key];
  const nextFields = replace ? { ...fields } : { ...(prev?.fields || {}), ...fields };
  all[key] = {
    fields: nextFields,
    messageId: messageId || prev?.messageId || null,
    updatedAt: new Date().toISOString(),
  };
  saveMemberIntros(all);
  return all[key];
}

function hasRoleMenuIdentity(member, guildId) {
  const cfg = getGuildRoleMenuConfig(guildId);
  if (!cfg?.mappings) {
    return { ok: false, missingAge: true, missingRel: true, missingGames: true };
  }

  const roleIds = new Set(member.roles.cache.map((r) => r.id));
  const ageKeys = GROUPS.age.entries.map((e) => e.key);
  const relKeys = GROUPS.relationship.entries.map((e) => e.key);
  const gameKeys = [
    ...GROUPS.games_a.entries,
    ...GROUPS.games_b.entries,
    ...GROUPS.games_c.entries,
  ].map((e) => e.key);

  const hasAge = ageKeys.some((k) => {
    const id = cfg.mappings[k]?.roleId;
    return id && roleIds.has(id);
  });
  const hasRel = relKeys.some((k) => {
    const id = cfg.mappings[k]?.roleId;
    return id && roleIds.has(id);
  });
  const hasGame = gameKeys.some((k) => {
    const id = cfg.mappings[k]?.roleId;
    return id && roleIds.has(id);
  });

  return {
    ok: hasAge && hasRel && hasGame,
    missingAge: !hasAge,
    missingRel: !hasRel,
    missingGames: !hasGame,
  };
}

/** Find member's latest complete intro in #introduction and save it. */
async function tryResyncIntroFromChannel(member, guildId, channel) {
  if (!channel?.isTextBased?.()) return null;

  const messages = await channel.messages.fetch({ limit: 50 });
  for (const msg of messages.values()) {
    if (msg.author?.bot || String(msg.author.id) !== String(member.id)) continue;
    const parsed = parseIntroText(msg.content);
    if (!Object.keys(parsed).length) continue;
    saveMemberIntro(guildId, member.id, parsed, msg.id, { replace: true });
    const row = getMemberIntro(guildId, member.id);
    if (row?.complete) {
      console.log(`[INTRO] Resynced intro for ${member.user.tag} from message ${msg.id}`);
      return row;
    }
  }
  return null;
}

async function resolveIntroForVerify(member, guildId, { client = null } = {}) {
  let intro = getMemberIntro(guildId, member.id);
  const introChannelId = getIntroChannelId(guildId);

  if (!client || !introChannelId) {
    return { intro, introComplete: Boolean(intro?.complete) };
  }

  const channel = await member.guild.channels.fetch(introChannelId).catch(() => null);
  if (!channel) {
    return { intro, introComplete: Boolean(intro?.complete) };
  }

  if (intro?.messageId) {
    try {
      const msg = await channel.messages.fetch(intro.messageId);
      if (msg && String(msg.author.id) === String(member.id) && msg.content) {
        const parsed = parseIntroText(msg.content);
        if (Object.keys(parsed).length) {
          saveMemberIntro(guildId, member.id, parsed, msg.id, { replace: true });
          intro = getMemberIntro(guildId, member.id);
        }
      } else {
        intro = (await tryResyncIntroFromChannel(member, guildId, channel)) || intro;
      }
    } catch {
      // Stored message gone (deleted/reposted) — scan channel, else trust saved file
      const resynced = await tryResyncIntroFromChannel(member, guildId, channel);
      if (resynced) {
        intro = resynced;
      }
    }
  } else if (!intro?.complete) {
    intro = (await tryResyncIntroFromChannel(member, guildId, channel)) || intro;
  }

  return { intro, introComplete: Boolean(intro?.complete) };
}

async function checkVerifyReadiness(member, guildId, { client = null } = {}) {
  const introCfg = getGuildIntroConfig(guildId);
  const introChannelId = getIntroChannelId(guildId);
  const getRoleChannel = introCfg?.getRoleChannelId || DEFAULT_GET_ROLE_CHANNEL;
  const { intro, introComplete } = await resolveIntroForVerify(member, guildId, { client });
  const roles = hasRoleMenuIdentity(member, guildId);

  const blockers = [];
  if (roles.missingAge || roles.missingRel) {
    const parts = [];
    if (roles.missingAge) parts.push('**Age** (buttons — tap the same button again to remove)');
    if (roles.missingRel) {
      parts.push('**Relationship** (buttons — tap the same button again to remove)');
    }
    blockers.push({
      id: 'identity',
      title: 'Pick Age and Relationship',
      detail:
        `Go to <#${getRoleChannel}> on the **Age / Relationship** message:\n• ${parts.join('\n• ')}`,
    });
  }
  if (roles.missingGames) {
    blockers.push({
      id: 'games',
      title: 'Pick at least one game or platform',
      detail:
        `Go to <#${getRoleChannel}> and react on **Games (1/3)**, **(2/3)**, or **(3/3)** ` +
        '(or **PC / Console / Phone**).\n' +
        '_Remove a reaction to drop that role — you need at least one game/platform pick to verify._',
    });
  }
  if (!introComplete) {
    const missing = missingIntroLabels(intro?.fields || {});
    const introLine = introChannelId
      ? `Go to <#${introChannelId}> and copy the template from the guide message. Fill in **every** field:\n`
      : 'Post your introduction in the **#introduction** channel (see staff if you cannot find it). Fill in **every** field:\n';
    blockers.push({
      id: 'intro',
      title: 'Post your introduction first',
      detail:
        introLine +
        (missing.length
          ? missing.map((l) => `• **${l}**`).join('\n')
          : INTRO_FIELDS.map((f) => `• **${f.label}**`).join('\n')),
    });
  }

  return { ok: blockers.length === 0, blockers, intro: { ...intro, complete: introComplete }, roles };
}

function buildIntroGuideEmbed(guild, getRoleChannelId = DEFAULT_GET_ROLE_CHANNEL) {
  const introCh = getIntroChannelId(guild.id);
  return new EmbedBuilder()
    .setColor(0xeb459e)
    .setTitle('Member Introduction')
    .setDescription(
      `Welcome to **${guild.name}**.\n\n` +
        '**Before you verify** ✅\n' +
        `1. <#${getRoleChannelId}> — **Age** + **Relationship** (buttons; tap again to undo) + **at least one game/platform** (reactions).\n` +
        `2. Post your **full intro** in <#${introCh}> (template below) — **random chat is deleted**.\n` +
        '3. React **✅** in the verify channel — **member channels stay locked** until all steps are done.\n\n' +
        'Check progress: `j!view`',
    )
    .addFields({
      name: 'Copy this template',
      value: getIntroTemplate().slice(0, 1020),
      inline: false,
    })
    .setFooter({ text: 'JanJan · Introduction · j!view' })
    .setTimestamp();
}

const _bumpInProgress = new Set();

async function bumpIntroGuideMessage(channel) {
  const guildId = channel.guild.id;
  if (_bumpInProgress.has(guildId)) return;
  _bumpInProgress.add(guildId);
  try {
    const cfg = getGuildIntroConfig(guildId);
    const guideId = cfg?.guideMessageId;
    const getRoleChannelId = cfg?.getRoleChannelId || DEFAULT_GET_ROLE_CHANNEL;
    const embed = buildIntroGuideEmbed(channel.guild, getRoleChannelId);

    // Delete known guide + scan for any other duplicates in the channel
    const toDelete = new Set();
    if (guideId) toDelete.add(String(guideId));
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (recent) {
      recent.filter(m => m.embeds?.[0]?.title === 'Member Introduction').forEach(m => toDelete.add(m.id));
    }
    for (const id of toDelete) {
      const msg = await channel.messages.fetch(id).catch(() => null);
      if (msg?.deletable) await msg.delete().catch(() => {});
    }

    const { buffer, filename } = await generateChannelBanner({
      title: 'INTRODUCTION',
      subtitle: 'Introduce yourself to the community',
      accentHex: '#ff00c8',
      filename: 'intro-banner.gif',
    });

    const hook = await getOrCreateGuildWebhook(channel, channel.client);
    const whMsg = await hook.send({
      files: [new AttachmentBuilder(buffer, { name: filename })],
      embeds: [embed],
    });

    const config = loadIntroConfig();
    if (config[String(guildId)]) {
      config[String(guildId)].guideMessageId = whMsg.id;
      saveIntroConfig(config);
    }
    console.log('[INTRO] Guide message bumped → new ID:', whMsg.id);
  } catch (err) {
    console.warn('[INTRO] bumpIntroGuideMessage failed:', err.message);
  } finally {
    _bumpInProgress.delete(guildId);
  }
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Inspect the target user's avatar at max quality (4096) and return its
 * actual byte size + format. Uses a HEAD request to Discord's CDN.
 * Returns null if the request fails or the avatar can't be reached.
 */
async function getAvatarFileInfo(user) {
  const axios = require('axios');
  const isAnimated = typeof user.avatar === 'string' && user.avatar.startsWith('a_');
  const ext = isAnimated ? 'gif' : 'png';
  const url = user.displayAvatarURL({ size: 4096, extension: ext, forceStatic: !isAnimated });
  try {
    const res = await axios.head(url, { timeout: 5000, validateStatus: (s) => s < 500 });
    const bytes = parseInt(res.headers['content-length'] || '0', 10);
    if (!bytes) return { url, ext, isAnimated, bytes: 0 };
    return { url, ext, isAnimated, bytes };
  } catch {
    return null;
  }
}

async function buildMemberViewEmbed({ member, targetUser, guild, client }) {
  const intro = getMemberIntro(guild.id, targetUser.id);
  const fields = intro?.fields || {};
  const picks = collectRoleMenuPicks(member, guild.id);
  const readiness = await checkVerifyReadiness(member, guild.id, { client });
  const avatarInfo = await getAvatarFileInfo(targetUser);

  const introLines = INTRO_FIELDS.map((f) => {
    const v = fields[f.key];
    return `**${capsLabel(f)}:** ${v?.trim() ? v : '—'}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setColor(readiness.ok ? 0x57f287 : 0x5865f2)
    .setAuthor({
      name: 'JanJan · View',
      iconURL: client.user.displayAvatarURL({ size: 128 }),
    })
    .setTitle(member.displayName || targetUser.username)
    .setThumbnail(client.user.displayAvatarURL({ size: 512 }))
    .setDescription('Eto na boy!');

  if (avatarInfo) {
    embed.setImage(avatarInfo.url);
  }

  embed.setFooter({
    text: `JanJan · j!view`,
    iconURL: client.user.displayAvatarURL({ size: 64 }),
  });
  embed.setTimestamp();
  return embed;
}

function formatVerifyBlockMessage(readiness) {
  if (readiness.ok) return null;
  return (
    '**You cannot verify yet.**\n\n' +
    readiness.blockers.map((b) => `**${b.title}**\n${b.detail}`).join('\n\n') +
    '\n\nWhen finished, react **✅** again on the verify message. Check progress: `j!view`'
  );
}

function syncIntroChannelToVerifyConfig(guildId, introChannelId) {
  const verifyPath = path.join(__dirname, '..', '..', 'data', 'verify-config.json');
  const verify = loadJson(verifyPath, {});
  const row = verify[String(guildId)];
  if (!row) return;
  const pub = new Set((row.publicChannelIds || []).map(String));
  pub.add(String(introChannelId));
  row.publicChannelIds = [...pub];
  const chat = new Set((row.chatChannelIds || []).map(String));
  chat.add(String(introChannelId));
  row.chatChannelIds = [...chat];
  verify[String(guildId)] = row;
  saveJson(verifyPath, verify);
}

async function findOrCreateIntroChannel(guild, preferredId = null) {
  const pinned = await guild.channels.fetch(PINNED_INTRO_CHANNEL_ID).catch(() => null);
  if (pinned?.isTextBased()) return pinned;

  const byName = guild.channels.cache.find((c) => isIntroChannel(c));
  if (byName) return byName;

  const tryId = preferredId || PINNED_INTRO_CHANNEL_ID;
  if (tryId) {
    const existing = await guild.channels.fetch(tryId).catch(() => null);
    if (existing?.isTextBased()) return existing;
  }

  const me = guild.members.me || (await guild.members.fetchMe());
  if (!me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    throw new Error('Bot needs **Manage Channels** to create the introduction channel');
  }

  let parentId = null;
  const getRole = await guild.channels.fetch(DEFAULT_GET_ROLE_CHANNEL).catch(() => null);
  if (getRole?.parentId) parentId = getRole.parentId;

  const channel = await guild.channels.create({
    name: '📝︱introduction',
    type: ChannelType.GuildText,
    parent: parentId || undefined,
    topic:
      'Member introductions — copy the template, fill all fields, then send. Required before verify ✅.',
    reason: 'JanJan: create introduction channel',
  });
  console.log(`[INTRO] Created channel #${channel.name} (${channel.id})`);
  return channel;
}

async function setupIntroChannel(client, guildId = DEFAULT_GUILD, { createIfMissing = true } = {}) {
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();

  const cfg = getGuildIntroConfig(guildId);
  let channel = null;
  if (createIfMissing) {
    channel = await findOrCreateIntroChannel(guild, cfg?.channelId || null);
  } else {
    channel = cfg?.channelId
      ? await guild.channels.fetch(cfg.channelId).catch(() => null)
      : null;
    if (channel && !isIntroChannel(channel)) channel = null;
    if (!channel?.isTextBased()) {
      throw new Error('Introduction channel not found. Run setup with createIfMissing.');
    }
  }

  const getRoleChannelId = cfg?.getRoleChannelId || DEFAULT_GET_ROLE_CHANNEL;
  const embed = buildIntroGuideEmbed(guild, getRoleChannelId);

  // Delete known guide + scan for any duplicates
  const toDelete = new Set();
  if (cfg?.guideMessageId) toDelete.add(String(cfg.guideMessageId));
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent) {
    recent.filter(m => m.embeds?.[0]?.title === 'Member Introduction').forEach(m => toDelete.add(m.id));
  }
  for (const id of toDelete) {
    const msg = await channel.messages.fetch(id).catch(() => null);
    if (msg?.deletable) await msg.delete().catch(() => {});
  }

  // Send as server via webhook (banner + embed)
  const { buffer: bannerBuf, filename: bannerFile } = await generateChannelBanner({
    title: 'INTRODUCTION',
    subtitle: 'Introduce yourself to the community',
    accentHex: '#ff00c8',
    filename: 'intro-banner.gif',
  });
  const hook = await getOrCreateGuildWebhook(channel, client);
  const whMsg = await hook.send({
    files: [new AttachmentBuilder(bannerBuf, { name: bannerFile })],
    embeds: [embed],
  });
  const msg = await channel.messages.fetch(whMsg.id).catch(() => ({ id: whMsg.id }));
  console.log('[INTRO] Posted guide message via webhook, ID:', whMsg.id);

  const config = loadIntroConfig();
  config[String(guildId)] = {
    channelId: channel.id || PINNED_INTRO_CHANNEL_ID,
    guideMessageId: msg.id,
    getRoleChannelId,
  };
  saveIntroConfig(config);
  syncIntroChannelToVerifyConfig(guildId, channel.id);

  return { channel, message: msg, created: true };
}

async function dmIntroOnly(user, text) {
  if (!user || user.bot) return false;
  try {
    await user.send(text);
    return true;
  } catch {
    return false;
  }
}

async function deleteIntroChannelMessage(guild, msg, reason) {
  if (!msg?.deletable) return false;
  const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!me?.permissions?.has(PermissionsBitField.Flags.ManageMessages)) {
    console.warn('[INTRO] Cannot delete message — bot needs Manage Messages in #introduction');
    return false;
  }
  await msg.delete(reason);
  return true;
}

/** Resend: delete the member's previous intro post (new valid intro already saved). */
async function deletePreviousIntroMessage(guild, channel, prevMessageId, newMessageId) {
  if (!prevMessageId || String(prevMessageId) === String(newMessageId)) return false;

  const oldMsg = await channel.messages.fetch(prevMessageId).catch(() => null);
  if (!oldMsg) return false;

  const ok = await deleteIntroChannelMessage(
    guild,
    oldMsg,
    'JanJan: member resubmitted introduction — keeping latest only',
  );
  if (ok) {
    console.log(`[INTRO] Deleted previous intro ${prevMessageId} (replaced by ${newMessageId})`);
  }
  return ok;
}

/** Random chat: delete the message, then tell the user the template (channel + DM). */
async function rejectRandomIntroChat(message) {
  const user = message.author;
  const userId = user?.id;
  if (!userId) return;

  const deleted = await deleteIntroChannelMessage(
    message.guild,
    message,
    'JanJan: #introduction is template-only — random chat removed',
  );
  if (deleted) {
    console.log(`[INTRO] Deleted random chat from ${user.tag} (${message.id})`);
  }

  const now = Date.now();
  const last = introReminderAt.get(userId) || 0;
  if (now - last >= INTRO_REMINDER_COOLDOWN_MS) {
    introReminderAt.set(userId, now);
    const reminder = buildIntroFormatReminder().slice(0, 1900);
    const prefix = deleted
      ? `${user}, your message was **removed** — this channel is for the introduction template only.\n\n`
      : `${user}, please use the introduction template only in this channel.\n\n`;

    await message.channel
      .send({
        content: `${prefix}${reminder}`.slice(0, 2000),
        allowedMentions: { parse: [], users: [userId] },
      })
      .catch((err) => console.warn('[INTRO] random-chat channel warn:', err.message));
  }

  // DM removed — the channel notification above already explains it.
}

async function applyIntroFromMessage(message, { isEdit = false } = {}) {
  const cfg = getGuildIntroConfig(message.guild.id);
  const parsed = parseIntroText(message.content);
  const user = message.author;

  if (isRandomIntroChat(message.content)) {
    if (!isEdit) {
      await rejectRandomIntroChat(message);
    }
    return true;
  }

  const prev = getMemberIntro(message.guild.id, user.id);
  const prevMessageId = prev?.messageId || null;
  const isRedo = prevMessageId && String(prevMessageId) !== String(message.id);

  saveMemberIntro(message.guild.id, user.id, parsed, message.id, { replace: true });

  let removedPrevious = false;
  if (isRedo && !isEdit) {
    removedPrevious = await deletePreviousIntroMessage(
      message.guild,
      message.channel,
      prevMessageId,
      message.id,
    );
  }

  const intro = getMemberIntro(message.guild.id, user.id);
  const complete = intro.complete;

  const memberForEnforce = await message.guild.members.fetch(user.id).catch(() => null);
  if (memberForEnforce && !complete) {
    const { enforceVerifiedEligibility } = require('../verify/verifyEligibility');
    await enforceVerifiedEligibility(memberForEnforce, message.guild.id, {
      client: message.client,
    });
  }

  if (complete) {
    // Minimal feedback only — a green check reaction on their message.
    // No DM (was: "Introduction saved. View your card: j!view ...") because
    // it duplicates info already visible in the channel + j!view command.
    await message.react('✅').catch(() => {});
  } else if (!isEdit) {
    // Partial intro: react with a different emoji as a quick signal.
    // No DM either — they can use j!view to see what's missing.
    await message.react('⚠️').catch(() => {});
  }
  return true;
}

async function handleIntroChannelMessage(message) {
  if (message.author?.bot || !message.guild) return false;

  const channelId = getIntroChannelId(message.guild.id);
  if (!channelId || String(message.channel.id) !== String(channelId)) return false;

  const handled = await applyIntroFromMessage(message, { isEdit: false });

  // After any valid intro (or random chat removal), bump the guide to the bottom
  if (handled && !message.author.bot) {
    bumpIntroGuideMessage(message.channel).catch((err) =>
      console.warn('[INTRO] bump failed:', err.message)
    );
  }

  return handled;
}

async function handleIntroMessageDelete(message) {
  if (!message.guild) return false;

  const channelId = getIntroChannelId(message.guild.id);
  if (!channelId || String(message.channel.id) !== String(channelId)) return false;

  const userId = clearMemberIntroByMessageId(message.guild.id, message.id);
  if (!userId) return false;

  console.log(`[INTRO] Cleared intro for user ${userId} (message ${message.id} deleted)`);

  const member = await message.guild.members.fetch(userId).catch(() => null);
  const user = message.author || (await message.client.users.fetch(userId).catch(() => null));
  if (user && !user.bot) {
    await user
      .send(
        'Your **introduction** was removed because you deleted that message in **#introduction**.\n\n' +
          '**Member channels are locked** until you post a new full intro and meet all verify requirements.\n' +
          'Check progress: `j!view`',
      )
      .catch(() => {});
  }
  if (member) {
    const { enforceVerifiedEligibility } = require('../verify/verifyEligibility');
    await enforceVerifiedEligibility(member, message.guild.id, {
      client: message.client,
    });
  }
  return true;
}

async function handleIntroMessageUpdate(oldMessage, newMessage) {
  if (newMessage.author?.bot || !newMessage.guild) return false;

  const channelId = getIntroChannelId(newMessage.guild.id);
  if (!channelId || String(newMessage.channel.id) !== String(channelId)) return false;

  const intro = getMemberIntro(newMessage.guild.id, newMessage.author.id);
  if (!intro?.messageId || String(intro.messageId) !== String(newMessage.id)) {
    return false;
  }

  if (oldMessage.content === newMessage.content) return false;

  console.log(`[INTRO] Intro edited by ${newMessage.author.tag} (${newMessage.id})`);
  return applyIntroFromMessage(newMessage, { isEdit: true });
}

/**
 * Scan the intro channel on startup and backfill any intros that were
 * posted while the bot was offline. Walks the channel's recent messages
 * and saves any that parse as a valid intro template.
 */
async function scanIntroChannelOnStartup(client, { limit = 200 } = {}) {
  const introConfig = loadIntroConfig();
  let scanned = 0;
  let saved = 0;

  for (const [guildId, cfg] of Object.entries(introConfig || {})) {
    const channelId = cfg?.channelId;
    if (!channelId) continue;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) continue;

    // Fetch in batches of 100 (Discord max per call)
    let lastId;
    let fetched = 0;
    const perUserLatest = new Map(); // userId -> { message, parsed }

    while (fetched < limit) {
      const batch = await channel.messages
        .fetch({ limit: Math.min(100, limit - fetched), before: lastId })
        .catch(() => null);
      if (!batch || batch.size === 0) break;

      for (const msg of batch.values()) {
        scanned += 1;
        if (msg.author?.bot) continue;
        const parsed = parseIntroText(msg.content);
        if (!Object.keys(parsed).length) continue;

        // Keep only the user's latest intro (messages are fetched newest-first)
        if (!perUserLatest.has(msg.author.id)) {
          perUserLatest.set(msg.author.id, { msg, parsed });
        }
      }

      fetched += batch.size;
      lastId = batch.last()?.id;
      if (batch.size < 100) break;
    }

    for (const [userId, { msg, parsed }] of perUserLatest) {
      const existing = getMemberIntro(guildId, userId);
      // Only overwrite if the existing record points to a deleted message or
      // is missing — never clobber a user's already-saved intro.
      if (existing?.messageId === msg.id) continue;
      saveMemberIntro(guildId, userId, parsed, msg.id, { replace: true });
      saved += 1;
    }
  }

  console.log(`[INTRO] Startup scan: ${scanned} messages, backfilled ${saved} intro(s)`);
  return { scanned, saved };
}

function registerIntroHandlers(client) {
  if (client._introHandlersRegistered) return;
  client._introHandlersRegistered = true;

  client.on('messageCreate', async (message) => {
    try {
      await handleIntroChannelMessage(message);
    } catch (err) {
      console.error('[INTRO] messageCreate:', err.message);
    }
  });

  client.on('messageDelete', async (message) => {
    try {
      if (message.partial) {
        await message.fetch().catch(() => {});
      }
      await handleIntroMessageDelete(message);
    } catch (err) {
      console.error('[INTRO] messageDelete:', err.message);
    }
  });

  client.on('messageUpdate', async (oldMessage, newMessage) => {
    try {
      if (newMessage.partial) {
        await newMessage.fetch().catch(() => {});
      }
      await handleIntroMessageUpdate(oldMessage, newMessage);
    } catch (err) {
      console.error('[INTRO] messageUpdate:', err.message);
    }
  });

  console.log('[INTRO] Introduction handlers registered (post / edit / delete)');
}

module.exports = {
  DEFAULT_GUILD,
  DEFAULT_GET_ROLE_CHANNEL,
  PINNED_INTRO_CHANNEL_ID,
  getIntroChannelId,
  isIntroChannel,
  getIntroTemplate,
  capsLabel,
  getGuildIntroConfig,
  getMemberIntro,
  hasRoleMenuIdentity,
  saveMemberIntro,
  clearMemberIntro,
  clearMemberIntroByMessageId,
  checkVerifyReadiness,
  resolveIntroForVerify,
  tryResyncIntroFromChannel,
  scanIntroChannelOnStartup,
  buildMemberViewEmbed,
  buildMemberStatusEmbed: buildMemberViewEmbed,
  buildIntroGuideEmbed,
  buildIntroFormatReminder,
  formatVerifyBlockMessage,
  setupIntroChannel,
  findOrCreateIntroChannel,
  syncIntroChannelToVerifyConfig,
  registerIntroHandlers,
  hasRoleMenuIdentity,
  isIntroComplete,
};
