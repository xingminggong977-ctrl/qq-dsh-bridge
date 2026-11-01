import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OWNER_QQ, startWithNapCat } from './helpers/harness.js';

/**
 * 路径白名单是这条路由的全部安全性：她做好的东西在工作区里，系统文件不在。
 * 测试把根目录指到临时目录上，跑完把整个目录删掉。
 */
function tempWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-send-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function withHarness(t, root) {
  return startWithNapCat(t, { env: { QQ_FILE_ROOTS: root } });
}

test('POST /node/send_file uploads the file as base64 to the owner', async (t) => {
  const root = tempWorkspace(t);
  const file = path.join(root, '汇报.pptx');
  fs.writeFileSync(file, Buffer.alloc(512, 3));
  const { harness, stub } = await withHarness(t, root);

  const reply = await harness.nodeFetch('/node/send_file', {
    method: 'POST',
    body: { path: file },
  });

  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
  assert.equal(reply.body.bytes, 512);
  assert.equal(reply.body.name, '汇报.pptx');
  const sent = stub.actions.at(-1);
  assert.equal(sent.action, 'upload_private_file');
  assert.equal(sent.params.user_id, Number(OWNER_QQ));
  assert.equal(sent.params.name, '汇报.pptx');
  const payload = sent.params.file;
  assert.ok(payload.startsWith('base64://'), '文件必须走 base64://，实际 ' + payload.slice(0, 24));
  assert.equal(Buffer.from(payload.slice('base64://'.length), 'base64').length, 512);
});

test('POST /node/send_file keeps the name she chose and never lets it look like a path', async (t) => {
  const root = tempWorkspace(t);
  const file = path.join(root, 'out.bin');
  fs.writeFileSync(file, 'x');
  const { harness, stub } = await withHarness(t, root);

  const reply = await harness.nodeFetch('/node/send_file', {
    method: 'POST',
    body: { path: file, name: '../../etc/passwd' },
  });

  assert.equal(reply.status, 200);
  assert.equal(reply.body.name, '.._.._etc_passwd');
  assert.equal(stub.actions.at(-1).params.name, '.._.._etc_passwd');
});

test('POST /node/send_file refuses a file outside the allowed roots', async (t) => {
  const root = tempWorkspace(t);
  const outside = path.join(path.dirname(root), `outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'not for QQ');
  const { harness, stub } = await withHarness(t, root);
  t.after(() => fs.rmSync(outside, { force: true }));

  const reply = await harness.nodeFetch('/node/send_file', {
    method: 'POST',
    body: { path: outside },
  });

  assert.equal(reply.status, 403);
  assert.equal(reply.body.error, 'not_in_allowed_roots');
  assert.equal(stub.actions.length, 0, '被拒的请求不该碰 NapCat');
});

test('POST /node/send_file says 404 when the file is not there', async (t) => {
  const root = tempWorkspace(t);
  const { harness } = await withHarness(t, root);

  const reply = await harness.nodeFetch('/node/send_file', {
    method: 'POST',
    body: { path: path.join(root, 'missing.pptx') },
  });

  assert.equal(reply.status, 404);
  assert.equal(reply.body.error, 'file not found');
});
