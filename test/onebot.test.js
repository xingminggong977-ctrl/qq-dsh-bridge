import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPIRED_NOTICE, extractMessage } from '../src/dispatch.js';
import { NAPCAT_TOKEN, OWNER_QQ, SELF_ID, startWithNapCat } from './helpers/harness.js';
import { atSegment, groupMessage, imageSegment, privateMessage, textSegment } from './helpers/ws-stub.js';
import { sleep, waitFor } from './helpers/wait.js';

const withOneBot = (t) => startWithNapCat(t);

test('the bridge is a websocket client that authenticates to NapCat', async (t) => {
  const { stub, harness } = await withOneBot(t);
  assert.equal(stub.upgradeHeaders.length, 1);
  assert.equal(stub.upgradeHeaders[0].authorization, `Bearer ${NAPCAT_TOKEN}`);
  assert.equal(harness.onebot.connected, true);
});

test('a group message that @s the bot is queued', async (t) => {
  const { stub, harness } = await withOneBot(t);
  stub.inject(
    groupMessage({
      selfId: SELF_ID,
      groupId: '123456',
      userId: OWNER_QQ,
      nickname: '小明',
      segments: [atSegment(SELF_ID), textSegment(' 今天天气怎么样 '), imageSegment('http://127.0.0.1:1/x.png')],
    }),
  );

  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'queued task' });
  const [task] = harness.queue.db.prepare('SELECT * FROM tasks').all();
  assert.equal(task.kind, 'group');
  assert.equal(task.group_id, '123456');
  assert.equal(task.user_id, OWNER_QQ);
  assert.equal(task.nickname, '小明');
  assert.equal(task.text, '今天天气怎么样');
  assert.equal(task.is_owner, 1);
  // The image host is unreachable, so the segment is dropped but the text survives.
  assert.equal(JSON.parse(task.images).length, 0);
  assert.deepEqual(JSON.parse(task.reply_target), { kind: 'group', groupId: '123456' });
});

test('group messages without an @ mention are ignored', async (t) => {
  const { stub, harness } = await withOneBot(t);
  stub.inject(groupMessage({ selfId: SELF_ID, segments: [textSegment('随便聊聊')] }));
  stub.inject(groupMessage({ selfId: SELF_ID, segments: [atSegment('99999'), textSegment('@别人')] }));
  await sleep(120);
  assert.equal(harness.queue.queuedCount(), 0);
});

test('private messages are always queued and carry a null groupId', async (t) => {
  const { stub, harness } = await withOneBot(t);
  stub.inject(privateMessage({ selfId: SELF_ID, userId: '20002', segments: [textSegment('私聊你一下')] }));
  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'private task' });
  const [task] = harness.queue.db.prepare('SELECT * FROM tasks').all();
  assert.equal(task.kind, 'private');
  assert.equal(task.group_id, null);
  assert.equal(task.is_owner, 0);
  assert.deepEqual(JSON.parse(task.reply_target), { kind: 'private', userId: '20002' });
});

test('CQ-code string messages are parsed like segment arrays', async (t) => {
  const { stub, harness } = await withOneBot(t);
  stub.inject({
    ...groupMessage({ selfId: SELF_ID, userId: OWNER_QQ }),
    message: `[CQ:at,qq=${SELF_ID}] 你好呀`,
    raw_message: `[CQ:at,qq=${SELF_ID}] 你好呀`,
  });
  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'cq-code task' });
  const [task] = harness.queue.db.prepare('SELECT * FROM tasks').all();
  assert.equal(task.text, '你好呀');
});

test('the bot ignores its own messages', async (t) => {
  const { stub, harness } = await withOneBot(t);
  stub.inject(
    groupMessage({ selfId: SELF_ID, userId: SELF_ID, segments: [textSegment('我自己说的')] }),
  );
  stub.inject(privateMessage({ selfId: SELF_ID, userId: SELF_ID, segments: [textSegment('我自己说的')] }));
  await sleep(120);
  assert.equal(harness.queue.queuedCount(), 0);
});

test('non-message events never reach the queue', async (t) => {
  const { stub, harness } = await withOneBot(t);
  stub.inject({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: Number(SELF_ID), time: 1 });
  stub.inject({ post_type: 'notice', notice_type: 'group_increase', self_id: Number(SELF_ID), group_id: 1 });
  stub.inject({ post_type: 'message', message_type: 'guild', self_id: Number(SELF_ID), message: [] });
  await sleep(120);
  assert.equal(harness.queue.queuedCount(), 0);
});

test('replies go back through send_group_msg / send_private_msg', async (t) => {
  const { stub, harness } = await withOneBot(t);
  await harness.dispatch.sendReply({ kind: 'group', groupId: '123456' }, '群里回复');
  await harness.dispatch.sendReply({ kind: 'private', userId: '20002' }, '私聊回复');

  assert.equal(stub.sendActions.length, 2);
  assert.equal(stub.sendActions[0].action, 'send_group_msg');
  assert.equal(stub.sendActions[0].params.group_id, 123456);
  assert.deepEqual(stub.sendActions[0].params.message, [{ type: 'text', data: { text: '群里回复' } }]);
  assert.equal(stub.sendActions[1].action, 'send_private_msg');
  assert.equal(stub.sendActions[1].params.user_id, 20002);
  assert.deepEqual(stub.sentTexts, ['群里回复', '私聊回复']);
});

test('a dropped NapCat connection is retried', async (t) => {
  const { stub, harness } = await withOneBot(t);
  for (const connection of stub.connections) connection.socket.destroy();
  await waitFor(() => stub.openCount === 0, { label: 'socket closed' });
  await waitFor(() => stub.openCount === 1, { label: 'reconnect', timeoutMs: 8000 });
  // openCount 只是桩这侧收下了连接；connected 要等客户端的 'open' 事件真正跑到。
  // 线上 3 核机上这两步之间能差几十毫秒，直接断言会偶发失败（我抓到过一次）。
  await waitFor(() => harness.onebot.connected === true, { label: 'connected flag', timeoutMs: 8000 });
  assert.ok(stub.upgradeHeaders.length >= 2);
});

test('expired backlog is answered with the fixed notice', async (t) => {
  const { stub, harness } = await withOneBot(t);
  const row = harness.queue.insertTask({
    kind: 'group',
    groupId: '123456',
    userId: OWNER_QQ,
    nickname: '小明',
    text: '在吗',
    images: [],
    isOwner: true,
    replyTarget: { kind: 'group', groupId: '123456' },
  });
  harness.clock.advance(1800001);
  const response = await harness.nodeFetch('/node/poll?wait=0');
  assert.deepEqual(response.body.tasks, []);
  await waitFor(() => stub.sentTexts.length === 1, { label: 'expiry notice' });
  assert.deepEqual(stub.sentTexts, [EXPIRED_NOTICE]);
  assert.equal(harness.queue.getRow(row.task_id).status, 'expired');
  harness.clock.advance(0);
  await harness.nodeFetch('/node/poll?wait=0');
  await sleep(60);
  assert.equal(stub.sentTexts.length, 1);
});

test('mface stickers become pictures, and un-fetchable emotes become text', () => {
  const base = { post_type: 'message', message_type: 'private', user_id: '20002', sender: { nickname: '小红' } };

  // A market face with a URL is just another picture: queued as an image, no text.
  const withUrl = extractMessage({
    ...base,
    message: [{ type: 'mface', data: { url: 'https://example.test/sticker.gif', summary: '[开心]' } }],
  });
  assert.deepEqual(withUrl.images, [{ url: 'https://example.test/sticker.gif', file: '' }]);
  assert.equal(withUrl.text, '');

  // No URL means the whole sticker would be lost, so its summary has to survive as text.
  const noUrl = extractMessage({ ...base, message: [{ type: 'mface', data: { summary: '[贴贴]' } }] });
  assert.deepEqual(noUrl.images, []);
  assert.equal(noUrl.text, '[贴贴]');

  // Plain emoji segments carry no bytes at all; they still must not vanish silently.
  // 178 不在经典名字表里，所以标记带上 id——不认识就说不知道，别假装看懂。
  const emoji = extractMessage({ ...base, message: [{ type: 'face', data: { id: '178' } }] });
  assert.deepEqual(emoji.images, []);
  assert.equal(emoji.text, '[表情#178]');

  const mixed = extractMessage({ ...base, message: [textSegment('看这个'), { type: 'face', data: { id: '178' } }] });
  assert.equal(mixed.text, '看这个 [表情#178]');
});

test('a voice note keeps a marker and carries the clip reference', () => {
  const base = { post_type: 'message', message_type: 'private', user_id: '20002', sender: { nickname: '小红' } };

  const clip = extractMessage({
    ...base,
    message: [{ type: 'record', data: { file: 'abc.silk', url: 'https://example.test/abc.silk' } }],
  });
  // Without a transcriber the marker is all she gets; it must never be silence.
  assert.equal(clip.text, '[语音]');
  assert.deepEqual(clip.voice, { file: 'abc.silk', url: 'https://example.test/abc.silk' });

  const withWords = extractMessage({
    ...base,
    message: [textSegment('听一下'), { type: 'record', data: { file: 'abc.silk' } }],
  });
  assert.equal(withWords.text, '听一下 [语音]');
  assert.deepEqual(withWords.voice, { file: 'abc.silk', url: '' });

  // A record with no handle at all is unplayable: marker only, nothing to fetch.
  const nothing = extractMessage({ ...base, message: [{ type: 'record', data: {} }] });
  assert.equal(nothing.text, '[语音]');
  assert.equal(nothing.voice, null);
});
