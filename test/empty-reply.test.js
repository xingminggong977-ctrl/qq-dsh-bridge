import assert from 'node:assert/strict';
import test from 'node:test';

import { startWithNapCat } from './helpers/harness.js';
import { waitFor } from './helpers/wait.js';

const FAST = { sendBackoffMs: [1, 1, 1], segmentDelayMs: 0, pollSliceMs: 25 };
const FALLBACK = '我在，你说。';

function ownerTask(overrides = {}) {
  return {
    kind: 'private',
    userId: '10001',
    nickname: '主人',
    text: '在吗',
    images: [],
    isOwner: true,
    mentioned: true,
    needsReply: true,
    replyTarget: { kind: 'private', userId: '10001' },
    ...overrides,
  };
}

async function claimOne(harness) {
  const polled = await harness.nodeFetch('/node/poll?wait=0');
  for (const task of polled.body.tasks) {
    await harness.nodeFetch('/node/status', { method: 'POST', body: { taskId: task.taskId, state: 'running' } });
  }
  return polled;
}

test('a reply made of nothing but spaces becomes one short line instead of an empty packet', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: FAST });
  const row = harness.queue.insertTask(ownerTask());
  await claimOne(harness);

  // 2026-11-01 16:08 那次就是这样：正文全是空白字符，`text !== ''` 放它过去，
  // NapCat 用 retcode=1200 拒发，对面只看到沉默。
  await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text: '  \n ' } });

  await waitFor(() => stub.sentTexts.includes(FALLBACK), { label: 'fallback line', timeoutMs: 4000 });
  assert.deepEqual(stub.sentTexts, [FALLBACK], '只发那一句兜底，不发空包');
});

test('nobody asked for an answer, so a blank reply stays unsent', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: FAST });
  const row = harness.queue.insertTask(
    ownerTask({ kind: 'group', groupId: '123456', userId: '20002', isOwner: false, needsReply: false, text: '群里闲聊' }),
  );
  await claimOne(harness);

  await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text: '   ' } });

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(stub.sentTexts, [], '没人问就什么都别发');
});
