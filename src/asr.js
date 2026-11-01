/**
 * Voice notes -> text.
 *
 * QQ voice arrives as a `record` segment holding SILK audio, which neither
 * ffmpeg nor anything else here decodes directly. NapCat's `get_record` action
 * converts it to mp3, and this module turns that mp3 into text两 ways:
 *
 *   1. 云端（优先，配了 `ASR_URL` + `ASR_API_KEY` + `ASR_MODEL` 才启用）：
 *      走 OpenAI 兼容的 /v1/audio/transcriptions，一条语音约 0.3 秒。
 *   2. 本地 faster-whisper venv（`ASR_PYTHON` + `ASR_SCRIPT`）：不联网，
 *      但一次要 9 秒左右，且与语音长短几乎无关。
 *
 * 两条都配时先试云端，失败再退本地——云端欠费或超时不该等于她听不见。
 * 两条都没配就整体关闭，语音退化成 `[语音]` 标记。任何失败都返回空串，
 * 绝不因为一条语音把整条消息弄丢。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DISABLED = Object.freeze({
  enabled: false,
  async transcribe() {
    return '';
  },
});

/** Longest clip worth transcribing; anything past this is almost certainly a stray file. */
export const MAX_VOICE_BYTES = 8 * 1024 * 1024;

/**
 * 云端转写：OpenAI 兼容的 `/v1/audio/transcriptions`（硅基流动、OpenAI 自建等）。
 *
 * 为什么值得多这一条路：本地 whisper-small 在这台 4 核机上**一条语音要 9 秒**，
 * 而且 2.7 秒和 6.1 秒的音频耗时几乎一样——whisper 把任意长度都填到同一个 30 秒
 * 窗口里算，固定成本就压在那儿。同一句话走云端是 0.3 秒，还更准。
 *
 * 只依赖全局 fetch/FormData/Blob（Node 18+ 自带），不引新依赖。
 */
export function createRemoteTranscriber({
  url,
  apiKey,
  model,
  language = 'zh',
  timeoutMs = 15000,
  log = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!url || !apiKey || !model) return null;

  return {
    enabled: true,
    model,
    async transcribe(buffer) {
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: 'audio/mpeg' }), 'clip.mp3');
      form.append('model', model);
      if (language !== '') form.append('language', language);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      if (!response.ok) {
        // 把响应体截下来：401 是 key 错、402 是欠费、422 多半是模型名写错，
        // 三种都只有一家能修，而它们长得一模一样。
        throw new Error(`asr http ${response.status}: ${body.slice(0, 200)}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(`asr reply not json: ${body.slice(0, 200)}`);
      }
      return typeof parsed?.text === 'string' ? parsed.text.trim() : '';
    },
  };
}

export function createTranscriber({ remote = null, python, script, modelDir = '/opt/asr-models', log = null, timeoutMs = 30000 } = {}) {
  const local = python && script ? { python, script } : null;
  if (!remote && !local) return DISABLED;

  // One clip at a time: faster-whisper is CPU-bound and four cores are shared
  // with everything else on this box. The chain also keeps temp dirs bounded.
  let chain = Promise.resolve();
  let warned = false;

  const warnOnce = (message, detail) => {
    if (warned) return;
    warned = true;
    log?.warn?.(message, detail);
  };

  async function runOnce(buffer) {
    if (buffer.length === 0) return '';
    if (buffer.length > MAX_VOICE_BYTES) {
      warnOnce('voice note skipped: too large', { bytes: buffer.length });
      return '';
    }
    if (remote) {
      try {
        return await remote.transcribe(buffer);
      } catch (error) {
        // 云端挂了不该等于听不见：本地引擎还在就继续试，只记一条 warn。
        log?.warn?.('cloud asr failed', { reason: error.message, bytes: buffer.length, model: remote.model });
        if (!local) return '';
      }
    }
    if (!local) return '';
    let dir = '';
    try {
      dir = await mkdtemp(join(tmpdir(), 'qq-voice-'));
      const clip = join(dir, 'clip.mp3');
      await writeFile(clip, buffer);
      const stdout = await spawnTranscript(local.python, [local.script, clip, modelDir], timeoutMs);
      const parsed = JSON.parse(stdout);
      const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
      return text;
    } catch (error) {
      // 每次都记：转写失败本来就不多（三天三条），而「只说一次」会把第二次、
      // 第三次坏掉的那几条永久藏起来——排查时正是它们最有用。
      log?.warn?.('voice transcription failed', {
        reason: error.message,
        bytes: buffer.length,
        head: buffer.subarray(0, 8).toString('hex'),
      });
      return '';
    } finally {
      if (dir !== '') await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    enabled: true,
    /** @param {Buffer} buffer mp3 bytes @returns {Promise<string>} transcript, '' when unavailable */
    transcribe(buffer) {
      const task = chain.then(() => runOnce(buffer));
      chain = task.then(
        () => {},
        () => {},
      );
      return task;
    },
  };
}

/** Run the helper and collect stdout; rejects on a non-zero exit or the deadline. */
function spawnTranscript(python, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`transcriber timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // 助手失败时把原因写成 JSON 到 stdout、stderr 留空；只读 stderr 会得到
        // 一句「exited 1: 」，等于什么都没说。两边都读，谁有内容用谁。
        const fromStderr = Buffer.concat(err).toString('utf8').trim();
        const fromStdout = Buffer.concat(out).toString('utf8').trim();
        const detail = (fromStderr !== '' ? fromStderr : fromStdout).split('\n').pop() ?? '';
        reject(new Error(`transcriber exited ${code}: ${detail.slice(0, 300)}`));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

/** Decode the base64 NapCat hands back, tolerating a data: prefix and stray whitespace. */
export function decodeBase64Audio(value) {
  if (typeof value !== 'string' || value === '') return null;
  const trimmed = value.trim();
  const payload = trimmed.startsWith('base64://') ? trimmed.slice('base64://'.length) : trimmed;
  const withoutPrefix = payload.includes(',') ? payload.slice(payload.indexOf(',') + 1) : payload;
  try {
    const buffer = Buffer.from(withoutPrefix, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}
