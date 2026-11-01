import assert from 'node:assert/strict';
import test from 'node:test';

import { OWNER_QQ, startWithNapCat } from './helpers/harness.js';

// 走真的 NapCat 桩：断言的是「线上真的出现了 send_private_msg」，不是只看响应码。
const withHarness = (t) => startWithNapCat(t);

test('POST /node/send puts a text segment on the wire', async (t) => {
  const { harness, stub } = await withHarness(t);

  const reply = await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { to: OWNER_QQ, text: '早安，今天下雨。' },
  });

  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { ok: true, messageId: 1001 });
  const sent = stub.sendActions.at(-1);
  assert.equal(sent.action, 'send_private_msg');
  assert.equal(sent.params.user_id, Number(OWNER_QQ));
  assert.deepEqual(sent.params.message, [{ type: 'text', data: { text: '早安，今天下雨。' } }]);
});

test('POST /node/send trims the text it actually sends', async (t) => {
  const { harness, stub } = await withHarness(t);

  const reply = await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { to: OWNER_QQ, text: '  晨报：晴  \n' },
  });

  assert.equal(reply.status, 200);
  assert.deepEqual(stub.sendActions.at(-1).params.message, [{ type: 'text', data: { text: '晨报：晴' } }]);
});

test('POST /node/send accepts exactly 2000 characters', async (t) => {
  const { harness, stub } = await withHarness(t);

  const reply = await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { to: OWNER_QQ, text: '报'.repeat(2000) },
  });

  assert.equal(reply.status, 200);
  assert.equal(stub.sendActions.at(-1).params.message[0].data.text.length, 2000);
});

test('POST /node/send refuses anyone but the owner', async (t) => {
  const { harness, stub } = await withHarness(t);
  const before = stub.sendActions.length;

  const reply = await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { to: '99999', text: '早安' },
  });

  assert.equal(reply.status, 403);
  assert.deepEqual(reply.body, { ok: false, error: 'not_owner' });
  // 拒了就得真的一声不吭：不能先发出去再回 403。
  assert.equal(stub.sendActions.length, before);
});

test('POST /node/send rejects a text that is empty after trim', async (t) => {
  const { harness, stub } = await withHarness(t);
  const before = stub.sendActions.length;

  const reply = await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { to: OWNER_QQ, text: '   \n\t ' },
  });

  assert.equal(reply.status, 400);
  assert.equal(stub.sendActions.length, before);
});

test('POST /node/send rejects a text that is not a string', async (t) => {
  const { harness } = await withHarness(t);

  const reply = await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { to: OWNER_QQ, text: 2026 },
  });

  assert.equal(reply.status, 400);
  assert.match(reply.body.error, /text/);
});

test('POST /node/send rejects a text longer than 2000 characters', async (t) => {
  const { harness, stub } = await withHarness(t);
  const before = stub.sendActions.length;

  const reply = await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { to: OWNER_QQ, text: '报'.repeat(2001) },
  });

  assert.equal(reply.status, 400);
  assert.match(reply.body.error, /2000/);
  assert.equal(stub.sendActions.length, before);
});

test('POST /node/send rejects a to that is not a bare QQ number', async (t) => {
  const { harness, stub } = await withHarness(t);
  const before = stub.sendActions.length;

  for (const to of ['12ab', '1234', '1234567890123', 10001, undefined]) {
    const reply = await harness.nodeFetch('/node/send', { method: 'POST', body: { to, text: '早安' } });
    assert.equal(reply.status, 400, `to=${String(to)} must be a 400`);
  }
  assert.equal(stub.sendActions.length, before);
});

test('POST /node/send takes the body the morning report actually sends', async (t) => {
  const { harness, stub } = await withHarness(t);

  // nightly/bin/morning-report.mjs 发的就是这一坨（照 /node/send_image 的形状）。
  const reply = await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { kind: 'private', to: OWNER_QQ, text: '08:30 晨报' },
  });

  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
  assert.deepEqual(stub.sendActions.at(-1).params.message, [{ type: 'text', data: { text: '08:30 晨报' } }]);
});

test('POST /node/send refuses to be a group sender', async (t) => {
  const { harness, stub } = await withHarness(t);
  const before = stub.sendActions.length;

  const reply = await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { kind: 'group', to: '20001', text: '早安' },
  });

  assert.equal(reply.status, 400);
  assert.match(reply.body.error, /private/);
  assert.equal(stub.sendActions.length, before);
});

test('GET /node/send is not allowed', async (t) => {
  const { harness } = await withHarness(t);

  const reply = await harness.nodeFetch('/node/send?to=10001&text=hi', { method: 'GET' });

  assert.equal(reply.status, 405);
  assert.equal(reply.headers.get('allow'), 'POST');
});

test('POST /node/send needs the node token', async (t) => {
  const { harness, stub } = await withHarness(t);
  const before = stub.sendActions.length;

  const reply = await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { to: OWNER_QQ, text: '早安' },
    auth: false,
  });

  assert.equal(reply.status, 401);
  assert.equal(stub.sendActions.length, before);
});

test('POST /node/send logs the recipient and length, never the body', async (t) => {
  const { harness } = await withHarness(t);
  const secret = '晨报正文-8f2a-不该出现在日志里';

  const reply = await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { to: OWNER_QQ, text: secret },
  });

  assert.equal(reply.status, 200);
  const line = harness.lines.map((raw) => JSON.parse(raw)).find((entry) => entry.msg === 'node/send text');
  assert.ok(line, 'expected a "node/send text" info line');
  assert.equal(line.level, 'info');
  assert.equal(line.to, OWNER_QQ);
  assert.equal(line.chars, secret.length);
  assert.equal(line.ok, true);
  assert.equal(harness.lines.join('\n').includes(secret), false);
});

test('POST /node/send reports a OneBot rejection instead of a fake 200', async (t) => {
  const { harness, stub } = await withHarness(t);
  // NapCat 说失败（retcode 非 0）就是失败，哪怕 WebSocket 那头在线。
  stub.actionHandler = () => ({ status: 'failed', retcode: 100 });

  const reply = await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { to: OWNER_QQ, text: '早安' },
  });

  assert.equal(reply.status, 500);
  assert.deepEqual(reply.body, { ok: false, error: 'internal error' });
  assert.equal(harness.lines.some((raw) => JSON.parse(raw).msg === 'node/send text'), false);
});
