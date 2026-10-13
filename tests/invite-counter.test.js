const test = require('node:test');
const assert = require('node:assert/strict');
const {
  INVITE_LOG_CHANNEL_ID,
  postViaWebhook,
} = require('../src/members/inviteCounter');

function makeDiscordMocks({ sendFails = false } = {}) {
  let sentPayload;
  const hook = {
    name: 'PLAYGROUND Invites',
    owner: { id: 'bot-user' },
    async send(payload) {
      if (sendFails) throw new Error('simulated webhook failure');
      sentPayload = payload;
    },
  };
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    fetchWebhooks: async () => [hook],
  };
  const guild = {
    id: 'guild-id',
    channels: {
      fetch: async (channelId) => {
        assert.equal(channelId, INVITE_LOG_CHANNEL_ID);
        return channel;
      },
    },
    members: { me: {} },
    iconURL: () => null,
  };
  const embed = {
    image: null,
    setImage(url) {
      this.image = url;
      return this;
    },
  };

  return {
    guild,
    hook,
    embed,
    getSentPayload: () => sentPayload,
  };
}

test('invite webhook posts under the requested PLAY GROUND display name', async () => {
  const mocks = makeDiscordMocks();
  const banner = { name: 'invite-joined.gif' };

  const sent = await postViaWebhook(
    mocks.guild,
    { id: 'bot-user' },
    mocks.embed,
    banner,
  );

  assert.equal(sent, true);
  assert.equal(mocks.getSentPayload().username, 'ᴘʟᴀʏ ɢʀᴏᴜɴᴅ');
  assert.equal(mocks.embed.image, 'attachment://invite-joined.gif');
  assert.deepEqual(mocks.getSentPayload().files, [banner]);
});

test('invite webhook reports a failed send instead of claiming success', async () => {
  const mocks = makeDiscordMocks({ sendFails: true });

  const sent = await postViaWebhook(
    mocks.guild,
    { id: 'bot-user' },
    mocks.embed,
    null,
  );

  assert.equal(sent, false);
});
