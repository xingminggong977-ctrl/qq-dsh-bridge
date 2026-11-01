import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { groupTask, startWithNapCat } from './helpers/harness.js';
import { waitFor } from './helpers/wait.js';

const FAST = { sendBackoffMs: [1, 1, 1], segmentDelayMs: 0, pollSliceMs: 25 };

function privateTask(overrides = {}) {
  return {
    kind: 'private',
    userId: '10001',
    nickname: '主人',
    text: '在吗',
    images: [],
    isOwner: true,
    replyTarget: { kind: 'private', userId: '10001' },
    ...overrides,
  };
}

/** A synthesizer that "works" without touching python. */
function fakeVoice(file = '/tmp/fake-voice.mp3') {
  const calls = [];
  return {
    calls,
    enabled: true,
    async synthesize(text) {
      calls.push(text);
      return { file, bytes: 2048 };
    },
  };
}

function segmentsOf(entry) {
  return Array.isArray(entry?.params?.message) ? entry.params.message : [];
}

test('a short reply to the owner in private is spoken, not typed', async (t) => {
  const synthesizer = fakeVoice();
  const { stub, harness } = await startWithNapCat(t, { timing: FAST, synthesizer });
  const row = harness.queue.insertTask(privateTask({ text: '在吗' }));

  await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text: '在呢，刚想你。' } });
  await waitFor(() => stub.sendActions.length === 1, { label: 'one send' });

  const segments = segmentsOf(stub.sendActions[0]);
  assert.deepEqual(segments.map((segment) => segment.type), ['record'], 'the reply is one record segment');
  assert.equal(segments[0].data.file, '/tmp/fake-voice.mp3');
  // sentTexts lists every send, giving '' for segments with no text — a record段就是这种。
  assert.deepEqual(stub.sentTexts.filter((entry) => entry !== ''), [], 'nothing was typed');
  assert.deepEqual(synthesizer.calls, ['在呢，刚想你。']);
});

test('a group reply is always typed, even with voice enabled', async (t) => {
  const synthesizer = fakeVoice();
  const { stub, harness } = await startWithNapCat(t, { timing: FAST, synthesizer });
  const row = harness.queue.insertTask(groupTask({ text: '在吗' }));

  await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text: '在呢。' } });
  await waitFor(() => stub.sendActions.length === 1, { label: 'one send' });

  assert.deepEqual(segmentsOf(stub.sendActions[0]).map((segment) => segment.type), ['text']);
  assert.deepEqual(synthesizer.calls, [], 'a group message never triggers speech');
});

test('a long reply is typed even in private', async (t) => {
  const synthesizer = fakeVoice();
  const { stub, harness } = await startWithNapCat(t, { timing: FAST, synthesizer, env: { TTS_MAX_CHARS: '10' } });
  const row = harness.queue.insertTask(privateTask({ text: '说说你今天' }));

  const text = '今天在云上待了一整天，看了很多人的对话，也想了很多自己的事。';
  await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text } });
  await waitFor(() => stub.sendActions.length === 1, { label: 'one send' });

  assert.deepEqual(segmentsOf(stub.sendActions[0]).map((segment) => segment.type), ['text']);
  assert.deepEqual(synthesizer.calls, [], 'a long answer is not read aloud');
});

test('a real voice file is sent as base64, never as a path NapCat cannot read', async (t) => {
  // NapCat 跟桥接不在一台机器上：路径过去就是「文件不存在」（线上连续 65 次 retcode=1200）。
  const dir = mkdtempSync(join(tmpdir(), 'voice-'));
  const file = join(dir, 'say.mp3');
  const bytes = Buffer.from('ID3fake-mp3-payload');
  writeFileSync(file, bytes);

  const synthesizer = fakeVoice(file);
  const { stub, harness } = await startWithNapCat(t, { timing: FAST, synthesizer });
  const row = harness.queue.insertTask(privateTask({ text: '在吗' }));

  await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text: '在呢。' } });
  await waitFor(() => stub.sendActions.length === 1, { label: 'one send' });

  const sent = segmentsOf(stub.sendActions[0])[0].data.file;
  assert.ok(sent.startsWith('base64://'), `record 段必须是 base64://，实际 ${sent.slice(0, 24)}`);
  assert.deepEqual(Buffer.from(sent.slice('base64://'.length), 'base64'), bytes, 'base64 内容与文件字节一致');
});

test('when speech fails the answer still goes out as text', async (t) => {
  const synthesizer = { enabled: true, synthesize: async () => null };
  const { stub, harness } = await startWithNapCat(t, { timing: FAST, synthesizer });
  const row = harness.queue.insertTask(privateTask({ text: '在吗' }));

  await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text: '在呢。' } });
  await waitFor(() => stub.sendActions.length === 1, { label: 'one send' });

  assert.deepEqual(segmentsOf(stub.sendActions[0]).map((segment) => segment.type), ['text']);
  assert.deepEqual(stub.sentTexts, ['在呢。']);
  await waitFor(() => harness.queue.getRow(row.task_id).status === 'done', { label: 'task done' });
});
