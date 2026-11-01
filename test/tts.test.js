import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSayArgs, buildSayEnv, createSynthesizer, prepareSpeech, synthesizerOptions } from '../src/tts.js';

function tempOut() {
  return mkdtempSync(join(tmpdir(), 'tts-'));
}

test('without python or script the synthesizer is off and never runs', async () => {
  for (const options of [{}, { python: '/opt/asr-venv/bin/python' }, { script: '/x/say.py' }]) {
    let called = false;
    const synthesizer = createSynthesizer({ ...options, run: async () => { called = true; } });
    assert.equal(synthesizer.enabled, false);
    assert.equal(await synthesizer.synthesize('你好'), null);
    assert.equal(called, false, 'a disabled engine must not spawn anything');
  }
});

test('a successful synthesis returns the file and its size', async () => {
  const outDir = tempOut();
  const seen = [];
  const synthesizer = createSynthesizer({
    python: '/venv/bin/python',
    script: '/srv/say.py',
    outDir,
    run: async (job) => {
      seen.push(job);
      writeFileSync(job.out, Buffer.alloc(4321, 7));
    },
  });
  const audio = await synthesizer.synthesize('  在呢，你说  ');
  assert.equal(audio.bytes, 4321);
  assert.equal(existsSync(audio.file), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, '在呢，你说。', 'the text is prepared before it reaches the engine');
  assert.equal(seen[0].out.startsWith(outDir), true);
});

test('empty text never reaches the engine', async () => {
  const synthesizer = createSynthesizer({
    python: '/venv/bin/python',
    script: '/srv/say.py',
    outDir: tempOut(),
    run: async () => {
      throw new Error('must not run');
    },
  });
  assert.equal(await synthesizer.synthesize('   '), null);
  assert.equal(await synthesizer.synthesize(undefined), null);
});

test('a failing engine returns null, warns once, and leaves no file behind', async () => {
  const outDir = tempOut();
  const warnings = [];
  const synthesizer = createSynthesizer({
    python: '/venv/bin/python',
    script: '/srv/say.py',
    outDir,
    log: { warn: (message, detail) => warnings.push([message, detail]) },
    run: async (job) => {
      writeFileSync(job.out, 'partial');
      throw new Error('say.py exited 1: boom');
    },
  });
  assert.equal(await synthesizer.synthesize('你好'), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][1].reason, /boom/);
  assert.deepEqual(readdirSync(outDir), [], 'the half-written file must be cleaned up');
});

test('audio older than six hours is swept away', async () => {
  const outDir = tempOut();
  const old = join(outDir, 'say-old.mp3');
  writeFileSync(old, 'x');
  const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
  utimesSync(old, eightHoursAgo, eightHoursAgo);

  const synthesizer = createSynthesizer({
    python: '/venv/bin/python',
    script: '/srv/say.py',
    outDir,
    run: async (job) => writeFileSync(job.out, 'fresh'),
  });
  await synthesizer.synthesize('你好');
  assert.equal(existsSync(old), false, 'stale audio is deleted');
  assert.equal(readdirSync(outDir).length, 1, 'the new file stays');
});

test('markdown, links and emoji never reach the speaker', () => {
  const spoken = prepareSpeech('**在呢**，看这个：https://example.com/a\n\n- 第一\n- 第二 😊');
  assert.equal(spoken.includes('*'), false, 'no emphasis markers');
  assert.equal(spoken.includes('http'), false, 'no raw urls');
  assert.match(spoken, /链接/);
  assert.equal(spoken.includes('😊'), false, 'no emoji');
  assert.match(spoken, /^在呢，看这个：链接，第一，第二。$/u);
});

test('a reply that is only code is not spoken at all', () => {
  assert.equal(prepareSpeech('```js\nconsole.log(1)\n```'), '');
  assert.equal(prepareSpeech('   '), '');
  assert.equal(prepareSpeech(undefined), '');
});

test('a sentence without an ending gets one, so it is not cut off flat', () => {
  assert.equal(prepareSpeech('在呢'), '在呢。');
  assert.equal(prepareSpeech('你吃饭了吗？'), '你吃饭了吗？');
});

test('synthesizerOptions — 音高必须活着走到合成器', () => {
  const options = synthesizerOptions({
    tts: {
      enabled: true,
      python: '/opt/asr-venv/bin/python',
      script: '/opt/dsh-qq-bridge/scripts/say.py',
      voice: 'zh-CN-XiaoyiNeural',
      rate: '+0%',
      pitch: '-5Hz',
      outDir: '/tmp/tts',
      timeoutMs: 20000,
    },
  });
  assert.equal(options.pitch, '-5Hz', 'pitch 漏传过一次：env 写着 -5Hz，实际却是 +0Hz');
  assert.equal(options.rate, '+0%');
  assert.equal(options.voice, 'zh-CN-XiaoyiNeural');
  assert.equal(options.python, '/opt/asr-venv/bin/python');
});

test('synthesizerOptions — 关掉时不给 python，等于不开', () => {
  const options = synthesizerOptions({ tts: { enabled: false, python: '/opt/asr-venv/bin/python' } });
  assert.equal(options.python, '');
});

test('buildSayArgs — 复刻音色走七参数（末位是风格指令），本地 edge 仍是五参数', () => {
  const clone = buildSayArgs({
    provider: 'dashscope',
    script: '/srv/say-cosyvoice.py',
    out: '/tmp/a.mp3',
    voice: 'cosyvoice-v2-lenovo-abc',
    model: 'cosyvoice-v2',
    speechRate: 0.95,
    pitchRate: 1,
    rate: '+8%',
    pitch: '+0Hz',
  });
  // 没配指令时末位传空串：参数个数固定，脚本那边才好按位置取值。
  assert.deepEqual(clone, ['/srv/say-cosyvoice.py', '/tmp/a.mp3', 'cosyvoice-v2-lenovo-abc', 'cosyvoice-v2', '0.95', '1', '']);

  const styled = buildSayArgs({
    provider: 'dashscope',
    script: '/srv/say-cosyvoice.py',
    out: '/tmp/a.mp3',
    voice: 'cosyvoice-v3.5-plus-x',
    model: 'cosyvoice-v3.5-plus',
    speechRate: 1.1,
    pitchRate: 1,
    instruction: '像跟熟人聊天，别念稿',
  });
  assert.deepEqual(styled, ['/srv/say-cosyvoice.py', '/tmp/a.mp3', 'cosyvoice-v3.5-plus-x', 'cosyvoice-v3.5-plus', '1.1', '1', '像跟熟人聊天，别念稿']);

  const edge = buildSayArgs({
    provider: 'edge',
    script: '/srv/say.py',
    out: '/tmp/b.mp3',
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+0%',
    pitch: '-5Hz',
  });
  assert.deepEqual(edge, ['/srv/say.py', '/tmp/b.mp3', 'zh-CN-XiaoyiNeural', '+0%', '-5Hz']);
});

test('buildSayEnv — key 只走环境变量，不进 argv', () => {
  const env = buildSayEnv({ provider: 'dashscope', apiKey: 'sk-test-key' });
  assert.equal(env.DASHSCOPE_API_KEY, 'sk-test-key');
  assert.equal(buildSayEnv({ provider: 'edge', apiKey: 'sk-test-key' }), undefined, 'edge 不该拿到云端 key');
  const args = buildSayArgs({ provider: 'dashscope', script: '/s/x.py', out: '/tmp/c.mp3', voice: 'v', model: 'm', speechRate: 1, pitchRate: 1 });
  assert.equal(args.some((part) => String(part).includes('sk-test-key')), false, 'argv 在 ps 里全机器可见');
});

test('dashscope 没 key 就等于没接通，一次都不 spawn', async () => {
  let called = false;
  const synthesizer = createSynthesizer({
    python: '/opt/asr-venv/bin/python',
    script: '/opt/dsh-qq-bridge/scripts/say-cosyvoice.py',
    provider: 'dashscope',
    apiKey: '',
    voice: 'cosyvoice-v2-x',
    outDir: tempOut(),
    run: async () => {
      called = true;
    },
  });
  assert.equal(synthesizer.enabled, false);
  assert.equal(await synthesizer.synthesize('你好'), null);
  assert.equal(called, false);
});

test('synthesizerOptions — 复刻音色的五个新字段必须活着走到合成器', () => {
  const options = synthesizerOptions({
    tts: {
      enabled: true,
      python: '/opt/asr-venv/bin/python',
      script: '/opt/dsh-qq-bridge/scripts/say-cosyvoice.py',
      provider: 'dashscope',
      apiKey: 'sk-x',
      model: 'cosyvoice-v2',
      voice: 'cosyvoice-v2-lenovo-abc',
      speechRate: 0.9,
      pitchRate: 1.1,
      outDir: '/tmp/tts',
      timeoutMs: 20000,
    },
  });
  assert.equal(options.provider, 'dashscope');
  assert.equal(options.apiKey, 'sk-x');
  assert.equal(options.model, 'cosyvoice-v2');
  assert.equal(options.speechRate, 0.9);
  assert.equal(options.pitchRate, 1.1);
  assert.equal(options.voice, 'cosyvoice-v2-lenovo-abc');
});