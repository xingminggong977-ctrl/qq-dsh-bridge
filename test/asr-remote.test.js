import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRemoteTranscriber, createTranscriber } from '../src/asr.js';

/** 一个记下请求、按脚本作答的假 fetch。 */
function fakeFetch(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const body = typeof reply === 'function' ? reply(url, init) : reply;
    if (body instanceof Error) throw body;
    return {
      ok: (body.status ?? 200) < 400,
      status: body.status ?? 200,
      text: async () => body.text ?? '',
    };
  };
  return { impl, calls };
}

function recorder() {
  const warns = [];
  return { warns, log: { warn: (message, detail) => warns.push({ message, detail }) } };
}

const clip = Buffer.from('ID3fake-mp3-bytes');

test('cloud transcriber stays off until url + key + model are all present', () => {
  assert.equal(createRemoteTranscriber({}), null);
  assert.equal(createRemoteTranscriber({ url: 'https://x/v1/audio/transcriptions' }), null);
  assert.equal(
    createRemoteTranscriber({ url: 'https://x/v1/audio/transcriptions', apiKey: 'k' }),
    null,
  );
});

test('a successful upload posts multipart form data and returns the trimmed text', async () => {
  const { impl, calls } = fakeFetch({ text: JSON.stringify({ text: ' 我到楼下了 ' }) });
  const remote = createRemoteTranscriber({
    url: 'https://api.example/v1/audio/transcriptions',
    apiKey: 'secret-key',
    model: 'FunAudioLLM/SenseVoiceSmall',
    fetchImpl: impl,
  });
  assert.equal(remote.enabled, true);
  assert.equal(await remote.transcribe(clip), '我到楼下了');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example/v1/audio/transcriptions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-key');
  const body = calls[0].init.body;
  assert.equal(body.get('model'), 'FunAudioLLM/SenseVoiceSmall');
  assert.equal(body.get('language'), 'zh');
  assert.equal(body.get('file').type, 'audio/mpeg');
  assert.equal(body.get('file').size, clip.length);
});

test('language can be turned off and still sends the model', async () => {
  const { impl, calls } = fakeFetch({ text: '{"text":"ok"}' });
  const remote = createRemoteTranscriber({
    url: 'https://api.example/v1/audio/transcriptions',
    apiKey: 'k',
    model: 'whisper-large-v3',
    language: '',
    fetchImpl: impl,
  });
  assert.equal(await remote.transcribe(clip), 'ok');
  assert.equal(calls[0].init.body.get('language'), null);
  assert.equal(calls[0].init.body.get('model'), 'whisper-large-v3');
});

test('an http error carries the status and the first 200 characters of the body', async () => {
  const { impl } = fakeFetch({ status: 402, text: 'insufficient balance: 余额不足' });
  const remote = createRemoteTranscriber({
    url: 'https://api.example/v1/audio/transcriptions',
    apiKey: 'k',
    model: 'm',
    fetchImpl: impl,
  });
  await assert.rejects(remote.transcribe(clip), /asr http 402: insufficient balance/);
});

test('a non-json body is reported as such, not as an empty transcript', async () => {
  const { impl } = fakeFetch({ status: 200, text: '<html>502 Bad Gateway</html>' });
  const remote = createRemoteTranscriber({
    url: 'https://api.example/v1/audio/transcriptions',
    apiKey: 'k',
    model: 'm',
    fetchImpl: impl,
  });
  await assert.rejects(remote.transcribe(clip), /asr reply not json/);
});

test('a network failure surfaces as a rejection so the caller can fall back', async () => {
  const { impl } = fakeFetch(new Error('fetch failed'));
  const remote = createRemoteTranscriber({
    url: 'https://api.example/v1/audio/transcriptions',
    apiKey: 'k',
    model: 'm',
    fetchImpl: impl,
  });
  await assert.rejects(remote.transcribe(clip), /fetch failed/);
});

test('cloud first: a working cloud engine never spawns the local helper', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asr-cloud-'));
  const helper = join(dir, 'boom.mjs');
  // 本地引擎一旦被调用就留痕，这样"云端成功时没跑本地"是可验证的。
  writeFileSync(helper, 'process.stderr.write("LOCAL RAN\\n"); process.exit(3)\n');
  const { warns, log } = recorder();
  const { impl } = fakeFetch({ text: '{"text":"云端结果"}' });
  const transcriber = createTranscriber({
    remote: createRemoteTranscriber({
      url: 'https://api.example/v1/audio/transcriptions',
      apiKey: 'k',
      model: 'm',
      fetchImpl: impl,
    }),
    python: process.execPath,
    script: helper,
    log,
  });
  assert.equal(await transcriber.transcribe(clip), '云端结果');
  assert.equal(warns.length, 0);
});

test('cloud down: falls back to the local engine and warns once about it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asr-fallback-'));
  const helper = join(dir, 'helper.mjs');
  writeFileSync(helper, 'console.log(JSON.stringify({ text: "本地兜底", lang: "zh", dur: 2 }))\n');
  const { warns, log } = recorder();
  const { impl } = fakeFetch({ status: 500, text: 'upstream boom' });
  const transcriber = createTranscriber({
    remote: createRemoteTranscriber({
      url: 'https://api.example/v1/audio/transcriptions',
      apiKey: 'k',
      model: 'm',
      fetchImpl: impl,
    }),
    python: process.execPath,
    script: helper,
    log,
  });
  assert.equal(await transcriber.transcribe(clip), '本地兜底');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].message, 'cloud asr failed');
  assert.match(warns[0].detail.reason, /asr http 500/);
});

test('cloud down with no local engine resolves to empty text, not a throw', async () => {
  const { warns, log } = recorder();
  const { impl } = fakeFetch({ status: 401, text: 'unauthorized' });
  const transcriber = createTranscriber({
    remote: createRemoteTranscriber({
      url: 'https://api.example/v1/audio/transcriptions',
      apiKey: 'k',
      model: 'm',
      fetchImpl: impl,
    }),
    log,
  });
  assert.equal(transcriber.enabled, true);
  assert.equal(await transcriber.transcribe(clip), '');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].message, 'cloud asr failed');
});

test('the size guard runs before the cloud call', async () => {
  const { impl, calls } = fakeFetch({ text: '{"text":"不该走到这里"}' });
  const { warns, log } = recorder();
  const transcriber = createTranscriber({
    remote: createRemoteTranscriber({
      url: 'https://api.example/v1/audio/transcriptions',
      apiKey: 'k',
      model: 'm',
      fetchImpl: impl,
    }),
    log,
  });
  assert.equal(await transcriber.transcribe(Buffer.alloc(9 * 1024 * 1024)), '');
  assert.equal(calls.length, 0);
  assert.equal(warns[0].message, 'voice note skipped: too large');
});
