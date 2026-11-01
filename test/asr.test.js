import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTranscriber, decodeBase64Audio } from '../src/asr.js';

test('decodeBase64Audio strips the prefixes NapCat and data: URLs use', () => {
  const plain = decodeBase64Audio('aGk=');
  assert.equal(plain.toString('utf8'), 'hi');
  assert.equal(decodeBase64Audio('base64://aGk=').toString('utf8'), 'hi');
  assert.equal(decodeBase64Audio('data:audio/mp3;base64,aGk=').toString('utf8'), 'hi');
  assert.equal(decodeBase64Audio(''), null);
  assert.equal(decodeBase64Audio(null), null);
  assert.equal(decodeBase64Audio('!!!!'), null);
});

test('without a configured engine the transcriber is off and says nothing', async () => {
  for (const options of [{}, { python: '/opt/asr-venv/bin/python' }, { script: '/x/y.py' }]) {
    const transcriber = createTranscriber(options);
    assert.equal(transcriber.enabled, false);
    assert.equal(await transcriber.transcribe(Buffer.from('anything')), '');
  }
});

test('a configured engine reads the helper JSON off stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asr-test-'));
  const helper = join(dir, 'helper.mjs');
  writeFileSync(helper, 'console.log(JSON.stringify({ text: " 今天天气不错 ", lang: "zh", dur: 1.5 }))\n');

  const transcriber = createTranscriber({ python: process.execPath, script: helper, log: { warn() {} } });
  assert.equal(transcriber.enabled, true);
  assert.equal(await transcriber.transcribe(Buffer.from('fake-mp3')), '今天天气不错');
});

test('a broken engine costs an empty string, never an exception', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asr-fail-'));
  const helper = join(dir, 'boom.mjs');
  writeFileSync(helper, 'process.stderr.write("model not found\\n"); process.exit(3)\n');

  const warns = [];
  const transcriber = createTranscriber({
    python: process.execPath,
    script: helper,
    log: { warn: (message, detail) => warns.push({ message, detail }) },
  });
  assert.equal(await transcriber.transcribe(Buffer.from('fake-mp3')), '');
  assert.equal(warns.length, 1);
  assert.match(warns[0].detail.reason, /exited 3/);
  assert.match(warns[0].detail.reason, /model not found/);

  // 每次坏都要记：三天的坏语音也就三条，藏起来只会让人查不到第二、第三次。
  assert.equal(await transcriber.transcribe(Buffer.from('fake-mp3')), '');
  assert.equal(warns.length, 2);
  assert.match(warns[1].detail.reason, /model not found/);
});

test('an unreadable engine binary is swallowed too', async () => {
  const transcriber = createTranscriber({
    python: '/nonexistent/python-bin',
    script: '/nonexistent/transcribe.py',
    log: { warn() {} },
  });
  assert.equal(await transcriber.transcribe(Buffer.from('fake-mp3')), '');
});
