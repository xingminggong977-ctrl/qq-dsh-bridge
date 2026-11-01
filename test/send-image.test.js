import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startWithNapCat } from './helpers/harness.js';

// 走真的 NapCat 桩：没有连接时 sendSegment 会直接抛，500 而不是 200。
const withHarness = (t) => startWithNapCat(t);

function tempImage(name = 'shot.png', bytes = 256) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-send-image-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

test('POST /node/send_image puts an image segment on the wire', async (t) => {
  const { harness, stub } = await withHarness(t);
  const file = tempImage();

  const reply = await harness.nodeFetch('/node/send_image', {
    method: 'POST',
    body: { to: '10001', file },
  });

  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
  const sent = stub.sendActions.at(-1);
  assert.equal(sent.action, 'send_private_msg');
  // 图片也走 base64：NapCat 在另一台机器上，路径过去就是「文件不存在」。
  const file64 = sent.params.message[0].data.file;
  assert.equal(sent.params.message[0].type, 'image');
  assert.ok(file64.startsWith('base64://'), 'image 段必须是 base64://，实际 ' + file64.slice(0, 24));
  assert.equal(Buffer.from(file64.slice('base64://'.length), 'base64').length, 256, '字节数跟文件一致');
  assert.equal(sent.params.user_id, 10001);
});

test('POST /node/send_image can address a group', async (t) => {
  const { harness, stub } = await withHarness(t);
  const file = tempImage('pack.gif');

  const reply = await harness.nodeFetch('/node/send_image', {
    method: 'POST',
    body: { to: '20001', kind: 'group', file },
  });

  assert.equal(reply.status, 200);
  const sent = stub.sendActions.at(-1);
  assert.equal(sent.action, 'send_group_msg');
  assert.equal(sent.params.group_id, 20001);
  // 图片也走 base64：NapCat 在另一台机器上，路径过去就是「文件不存在」。
  const file64 = sent.params.message[0].data.file;
  assert.equal(sent.params.message[0].type, 'image');
  assert.ok(file64.startsWith('base64://'), 'image 段必须是 base64://，实际 ' + file64.slice(0, 24));
  assert.equal(Buffer.from(file64.slice('base64://'.length), 'base64').length, 256, '字节数跟文件一致');
});

test('POST /node/send_image refuses anything that is not an image', async (t) => {
  const { harness, stub } = await withHarness(t);
  const secret = tempImage('shadow.txt');

  const reply = await harness.nodeFetch('/node/send_image', {
    method: 'POST',
    body: { to: '10001', file: secret },
  });

  assert.equal(reply.status, 400);
  assert.match(reply.body.error, /\.png/);
});

test('POST /node/send_image reports a missing file instead of throwing', async (t) => {
  const { harness, stub } = await withHarness(t);

  const reply = await harness.nodeFetch('/node/send_image', {
    method: 'POST',
    body: { to: '10001', file: '/tmp/definitely-not-here-8f2a.png' },
  });

  assert.equal(reply.status, 404);
  assert.equal(reply.body.error, 'file not found');
});

test('POST /node/send_image needs the node token', async (t) => {
  const { harness, stub } = await withHarness(t);
  const file = tempImage();

  const reply = await harness.nodeFetch('/node/send_image', {
    method: 'POST',
    body: { to: '10001', file },
    auth: false,
  });

  assert.equal(reply.status, 401);
});
