import assert from 'node:assert/strict';
import test from 'node:test';

import { startWithNapCat } from './helpers/harness.js';
import { waitFor } from './helpers/wait.js';

/**
 * 2026-11-02 线上两次「napcat websocket is not connected」把话发丢了：
 * 1/2/4 秒三次重试全烧在同一段掉线里。掉线是秒级的事，发送端应该等它回来。
 */
const TIMING = { sendBackoffMs: [1, 1, 1], segmentDelayMs: 0, pollSliceMs: 25, waitForSocketMs: 8000 };

test('a line written while NapCat is down waits for the socket and then goes out', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: TIMING });
  await waitFor(() => harness.onebot.connected === true, { label: 'connected', timeoutMs: 8000 });

  // 把重连故意拖慢，保证「掉线中写入」这件事真的发生，而不是被一次快速重连掩盖。
  harness.onebot.reconnectBaseMs = 2500;
  for (const connection of stub.connections) connection.socket.destroy();
  await waitFor(() => harness.onebot.connected === false, { label: 'dropped', timeoutMs: 8000 });

  const sending = harness.dispatch.sendChunk({ kind: 'private', userId: '20002' }, '掉线时说的话');

  await waitFor(() => stub.sentTexts.includes('掉线时说的话'), { label: 'delivered after reconnect', timeoutMs: 15000 });
  const response = await sending;
  assert.equal(response.retcode, 0);
  assert.ok(stub.upgradeHeaders.length >= 2, 'should have reconnected rather than given up');
});

test('when the socket never comes back, the send fails instead of hanging forever', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: { ...TIMING, waitForSocketMs: 120 } });
  await waitFor(() => harness.onebot.connected === true, { label: 'connected', timeoutMs: 8000 });

  // 把客户端的重连入口堵死，模拟 NapCat 彻底不回来。
  harness.onebot.stopped = true;
  for (const connection of stub.connections) connection.socket.destroy();
  await waitFor(() => harness.onebot.connected === false, { label: 'dropped', timeoutMs: 8000 });

  await assert.rejects(
    harness.dispatch.sendChunk({ kind: 'private', userId: '20002' }, '永远发不出去的话'),
    (error) => /not connected|did not come back|failed/i.test(error.message),
  );
});
