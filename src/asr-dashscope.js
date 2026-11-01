/**
 * 第二条云端转写通道：阿里云百炼（DashScope）Paraformer。
 *
 * 和 `asr.js` 里的 `createRemoteTranscriber` 不是一回事：那条是 OpenAI 兼容的
 * `/v1/audio/transcriptions`（一个 multipart 请求就回文本），这条是百炼自己的
 * 异步任务协议，一个语音条要打四个 HTTP 请求。为什么要多这一条：用户手上有
 * 百炼账号和 paraformer，而 paraformer 不在 OpenAI 兼容面上。
 *
 * ── 接口形态（2025-11 查证，出处见文件末尾）──────────────────────────────
 *
 * 「一句话识别/同步返回」这条路**在 paraformer 上不存在**：《非实时语音识别》
 * 文档明确写「Qwen-Audio-3.x-ASR-Flash-Filetrans、Fun-ASR、Qwen3-ASR-Flash-Filetrans
 * 和 Paraformer 为异步调用，请求头需设置 X-DashScope-Async: enable；其他模型
 * （如 Fun-ASR-Flash、Qwen3-ASR-Flash）为同步调用」。也就是说同步模式（同一
 * URL + `X-DashScope-Async: disable`，body 仍是 file_urls）只属于 Fun-ASR-Flash
 * / Qwen3-ASR-Flash 那几个模型；`paraformer-realtime-v2` 只有 WebSocket 长连接。
 * 所以要用 paraformer 就必须走最长的链路：
 *
 *   1. 取临时上传凭证   GET  {base}/api/v1/uploads?action=getPolicy&model=<model>
 *        头：Authorization: Bearer <key>
 *        回：{ data: { policy, signature, upload_dir, upload_host,
 *                      oss_access_key_id, x_oss_object_acl, x_oss_forbid_overwrite } }
 *        注意：文件与模型绑定（model 必须等于后面提交任务用的 model），48 小时过期，
 *        凭证接口 100 QPS。
 *   2. 传文件到 OSS     POST {policy.upload_host}   （multipart/form-data）
 *        字段：OSSAccessKeyId / Signature / policy / x-oss-object-acl /
 *              x-oss-forbid-overwrite / key=<upload_dir>/<文件名> /
 *              success_action_status=200 / file=<音频二进制>
 *        回：200，body 空。临时 URL 即 `oss://<key>`。
 *   3. 提交任务         POST {base}/api/v1/services/audio/asr/transcription
 *        头：Authorization: Bearer <key>
 *            Content-Type: application/json
 *            X-DashScope-Async: enable              ← 缺了提交不了
 *            X-DashScope-OssResourceResolve: enable ← 缺了 oss:// 解析不出来
 *        body：{ model, input: { file_urls: ['oss://...'] },
 *                parameters: { channel_id: [0], language_hints: ['zh'] } }
 *        回：{ request_id, output: { task_id, task_status: 'PENDING' } }
 *   4. 轮询任务         GET {base}/api/v1/tasks/{task_id}
 *        头：Authorization: Bearer <key>
 *        回：{ request_id, output: { task_id, task_status, results: [
 *              { file_url, transcription_url, subtask_status,
 *                code?, message? } ], task_metrics: {TOTAL,SUCCEEDED,FAILED} },
 *            usage: { duration } }
 *        task_status 取值：PENDING（排队）/ RUNNING（处理中）/ SUCCEEDED /
 *        FAILED / UNKNOWN（任务不存在）；批量查询里还会出现 CANCELED。
 *        ⚠ 多子任务时「只要有一个子任务成功，整个任务就是 SUCCEEDED」——真结果
 *        必须看 results[].subtask_status，失败的原因此外只在 results[].code/
 *        message 里（output.code/message 是任务级失败时才有的）。
 *   5. 下载识别结果     GET {transcription_url}          （预签名 URL，24 小时有效）
 *        不要带 Authorization：这是 OSS 直链，不是百炼接口。
 *        JSON：{ file_url, properties:{...},
 *                transcripts: [{ channel_id, text, sentences: [...] }] }
 *
 * base 地域域名：北京 https://dashscope.aliyuncs.com
 *               新加坡 https://dashscope-intl.aliyuncs.com（API Key 不通用）
 * 文档现在推荐换成业务空间专属域名 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`，
 * 但旧域名仍可用；`region` 允许直接传一个 http(s) 前缀的 base，方便以后迁移。
 *
 * ── 错误分类（只看 error.message 的前缀就能判断，前缀都带 stage 便于定位）──
 *   dashscope asr <stage> key rejected (401):        → key 错/被删
 *   dashscope asr <stage> payment required (402):    → 欠费
 *   dashscope asr <stage> rate limited (429):        → 限流（已重试到上限）
 *   dashscope asr <stage> forbidden (403):           → 主账号/权限不对
 *   dashscope asr <stage> http <status>:             → 其它非 2xx
 *   dashscope asr <stage> reply not json:            → 回的不是 JSON（网关页/WAF）
 *   dashscope asr <stage> network:                   → fetch 本身抛了（断网/DNS/TLS）
 *   dashscope asr <stage> timeout after <n>ms:       → 该阶段把预算耗光
 *   dashscope asr poll timeout after <n>ms (last status X): → 轮询超时
 *   dashscope asr task failed <code>: <message>      → 任务/子任务 FAILED
 * stage ∈ policy | upload | submit | poll | result。
 *
 * ── 重试与超时 ───────────────────────────────────────────────────────────
 * 只对 429 / 5xx 重试，最多 2 次（共 3 次请求），首次间隔 500ms、之后翻倍。
 * `timeoutMs` 是**整条语音的总预算**（默认 20s），每个请求的 abort signal 取
 * 剩余预算——语音条是聊天里的在线操作，宁可整条超时报错，也不要一条请求挂着。
 *
 * 不引任何第三方依赖：只用全局 fetch / FormData / Blob / AbortSignal.timeout
 * 和 node:crypto 的 randomUUID。
 */
import { randomUUID } from 'node:crypto';

/** 百炼两个地域的 base URL；`region` 也可以直接给一个 http(s) 前缀。 */
const REGIONS = Object.freeze({
  beijing: 'https://dashscope.aliyuncs.com',
  singapore: 'https://dashscope-intl.aliyuncs.com',
});

const DEFAULT_TIMEOUT_MS = 20000;
/** 429/5xx 最多重试几次（不含首次）。 */
const MAX_RETRIES = 2;
/** 首次重试等多久，之后每次翻倍。 */
const RETRY_DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 响应体/异常信息截一段进错误消息：够看清原因，又不至于把日志冲掉。 */
function snippet(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function httpFailure(stage, status, body, attempt) {
  const tried = attempt > 0 ? ` after ${attempt + 1} attempts` : '';
  const detail = snippet(body);
  if (status === 401) return new Error(`dashscope asr ${stage} key rejected (401)${tried}: ${detail}`);
  if (status === 402) return new Error(`dashscope asr ${stage} payment required (402)${tried}: ${detail}`);
  if (status === 403) return new Error(`dashscope asr ${stage} forbidden (403)${tried}: ${detail}`);
  if (status === 429) return new Error(`dashscope asr ${stage} rate limited (429)${tried}: ${detail}`);
  return new Error(`dashscope asr ${stage} http ${status}${tried}: ${detail}`);
}

/**
 * 建一个 paraformer 转写器。没给 apiKey 就返回 null（= 这条通道没开），
 * 和 `createRemoteTranscriber` 的约定一致，调用方据此决定要不要接线。
 *
 * @param {object} [options]
 * @param {string} [options.apiKey] 百炼 API Key（sk-...）
 * @param {string} [options.model] 默认 'paraformer-v2'
 * @param {string} [options.region] 'beijing' | 'singapore' | 自定义 http(s) base
 * @param {number} [options.timeoutMs] 整条语音的总预算，默认 20000
 * @param {number} [options.pollIntervalMs] 轮询间隔，默认 500
 * @param {number} [options.retryDelayMs] 首次重试间隔，默认 500（之后翻倍）
 * @param {string[]} [options.languageHints] 默认 ['zh']；[ ] 或 null 则不传
 * @param {{warn?: Function}} [options.log]
 * @param {Function} [options.fetchImpl] 测试注入用，默认全局 fetch
 * @returns {null | { enabled: true, model: string, transcribe: (buffer: Buffer) => Promise<string> }}
 */
export function createDashscopeTranscriber({
  apiKey,
  model = 'paraformer-v2',
  region = 'beijing',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = 500,
  retryDelayMs = RETRY_DELAY_MS,
  languageHints = ['zh'],
  log = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) return null;

  const base =
    typeof region === 'string' && /^https?:\/\//i.test(region) ? region.replace(/\/+$/, '') : REGIONS[region];
  if (!base) {
    // 地域写错等于用错地域的 API Key → 一路 401，比启动时就报出来难查得多。
    throw new TypeError(`dashscope asr unknown region: ${region}`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('dashscope asr needs a fetch implementation');
  }

  const budgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const intervalMs = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 0 ? pollIntervalMs : 500;
  const firstRetryMs = Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : RETRY_DELAY_MS;
  const hints = Array.isArray(languageHints) ? languageHints.filter((hint) => typeof hint === 'string' && hint !== '') : [];

  /**
   * 发一个请求，拿响应文本。只在这里做重试与超时，四个阶段共用同一套行为，
   * 免得某一条路偷偷没有重试、或者挂在一个不结束的 socket 上。
   */
  async function call(stage, url, init, deadline) {
    for (let attempt = 0; ; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`dashscope asr ${stage} timeout after ${budgetMs}ms`);
      let response;
      let text;
      try {
        response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(remaining) });
        text = await response.text();
      } catch (error) {
        const name = error?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new Error(`dashscope asr ${stage} timeout after ${budgetMs}ms`);
        }
        throw new Error(`dashscope asr ${stage} network: ${error?.message ?? String(error)}`);
      }
      if (response.ok) return text;
      const delay = firstRetryMs * 2 ** attempt;
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES && Date.now() + delay < deadline) {
        log?.warn?.('dashscope asr retry', { stage, status: response.status, attempt: attempt + 1, delay });
        await sleep(delay);
        continue;
      }
      throw httpFailure(stage, response.status, text, attempt);
    }
  }

  async function callJson(stage, url, init, deadline) {
    const text = await call(stage, url, init, deadline);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`dashscope asr ${stage} reply not json: ${snippet(text)}`);
    }
  }

  /** 1+2：取凭证 → 上传 → `oss://<upload_dir>/<文件名>`。 */
  async function uploadClip(buffer, deadline) {
    const policyUrl = `${base}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`;
    const policyReply = await callJson(
      'policy',
      policyUrl,
      { method: 'GET', headers: { authorization: `Bearer ${apiKey}` } },
      deadline,
    );
    const policy = policyReply?.data;
    if (!policy || typeof policy.upload_host !== 'string' || typeof policy.upload_dir !== 'string') {
      throw new Error(`dashscope asr policy reply unexpected: ${snippet(JSON.stringify(policyReply ?? null))}`);
    }

    // 文件名必须唯一：x-oss-forbid-overwrite 是真的禁覆盖，重名会 409。
    const fileName = `qq-voice-${randomUUID()}.mp3`;
    const objectKey = `${policy.upload_dir}/${fileName}`;
    const form = new FormData();
    const fields = {
      OSSAccessKeyId: policy.oss_access_key_id,
      Signature: policy.signature,
      policy: policy.policy,
      'x-oss-object-acl': policy.x_oss_object_acl,
      'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite,
      key: objectKey,
      success_action_status: '200',
    };
    for (const [name, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) form.append(name, String(value));
    }
    form.append('file', new Blob([buffer], { type: 'audio/mpeg' }), fileName);

    // 不能手写 content-type：multipart 的 boundary 必须由 fetch 自己生成。
    await call('upload', policy.upload_host, { method: 'POST', body: form }, deadline);
    return `oss://${objectKey}`;
  }

  /** 3：提交异步任务。 */
  async function submitTask(fileUrl, deadline) {
    const parameters = { channel_id: [0] };
    // language_hints 只有 paraformer-v2 认；别的模型传了会报错，所以按需带。
    if (hints.length > 0) parameters.language_hints = [...hints];
    const payload = await callJson(
      'submit',
      `${base}/api/v1/services/audio/asr/transcription`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'x-dashscope-async': 'enable',
          'x-dashscope-ossresourceresolve': 'enable',
        },
        body: JSON.stringify({ model, input: { file_urls: [fileUrl] }, parameters }),
      },
      deadline,
    );
    const taskId = payload?.output?.task_id;
    if (typeof taskId !== 'string' || taskId === '') {
      throw new Error(`dashscope asr submit reply unexpected: ${snippet(JSON.stringify(payload ?? null))}`);
    }
    return taskId;
  }

  /** 4：轮询到 SUCCEEDED / FAILED / 预算耗尽。 */
  async function pollTask(taskId, deadline) {
    const taskUrl = `${base}/api/v1/tasks/${encodeURIComponent(taskId)}`;
    const pollTimeout = (status) => new Error(`dashscope asr poll timeout after ${budgetMs}ms (last status ${status})`);
    let lastStatus = 'PENDING';

    for (;;) {
      if (Date.now() >= deadline) throw pollTimeout(lastStatus);
      let payload;
      try {
        payload = await callJson('poll', taskUrl, { method: 'GET', headers: { authorization: `Bearer ${apiKey}` } }, deadline);
      } catch (error) {
        // 轮询中途把预算烧完，对上层仍应表现为「轮询超时」而不是「网络异常」。
        if (String(error?.message).startsWith('dashscope asr poll timeout')) throw pollTimeout(lastStatus);
        throw error;
      }

      const output = payload?.output ?? {};
      lastStatus = typeof output.task_status === 'string' ? output.task_status : 'UNKNOWN';
      if (lastStatus === 'SUCCEEDED') return transcriptionUrlFrom(output);
      if (lastStatus === 'PENDING' || lastStatus === 'RUNNING') {
        await sleep(Math.max(0, Math.min(intervalMs, deadline - Date.now())));
        continue;
      }
      // FAILED / UNKNOWN / CANCELED：只有 code+message 能说清原因。
      throw new Error(
        `dashscope asr task failed ${output.code ?? lastStatus}: ${output.message ?? '(no message)'}`,
      );
    }
  }

  /** 5：下载识别结果 JSON（预签名 URL，别带 Authorization）。 */
  async function fetchTranscript(transcriptionUrl, deadline) {
    const payload = await callJson('result', transcriptionUrl, { method: 'GET' }, deadline);
    const transcripts = Array.isArray(payload?.transcripts) ? payload.transcripts : [];
    const text = transcripts.map((item) => (typeof item?.text === 'string' ? item.text : '')).join('');
    return text.trim();
  }

  return {
    enabled: true,
    model,
    /**
     * @param {Buffer} buffer mp3 字节
     * @returns {Promise<string>} 去掉首尾空白的转写文本；空音频返回 ''
     */
    async transcribe(buffer) {
      if (!buffer || buffer.length === 0) return '';
      const deadline = Date.now() + budgetMs;
      const fileUrl = await uploadClip(buffer, deadline);
      const taskId = await submitTask(fileUrl, deadline);
      const transcriptionUrl = await pollTask(taskId, deadline);
      return fetchTranscript(transcriptionUrl, deadline);
    },
  };
}

/**
 * 从 output 里捞结果下载地址。
 *
 * 任务级 SUCCEEDED 不代表这个文件成功（多子任务时任一成功即 SUCCEEDED），
 * 所以按 subtask_status 挑，挑不到就把第一个失败的 code/message 抛出去。
 */
function transcriptionUrlFrom(output) {
  const results = Array.isArray(output.results) ? output.results : [];
  const done = results.find((item) => item?.subtask_status === 'SUCCEEDED' && typeof item.transcription_url === 'string');
  if (done) return done.transcription_url;
  const failure = results.find((item) => item?.subtask_status !== 'SUCCEEDED') ?? results[0];
  throw new Error(
    `dashscope asr task failed ${failure?.code ?? 'NoTranscription'}: ${failure?.message ?? 'no transcription result'}`,
  );
}

/**
 * 出处（2025-11 抓取正文核对）：
 * - 录音文件识别 HTTP API（提交/查询/结果 JSON/状态取值）
 *   https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful-api
 * - 非实时语音识别用户指南（async 与 sync 模型的分野、transcription_url 24h）
 *   https://help.aliyun.com/zh/model-studio/recording-file-recognition
 * - 上传本地文件获取临时 URL（getPolicy / OSS 表单字段 / X-DashScope-OssResourceResolve）
 *   https://help.aliyun.com/zh/model-studio/get-temporary-file-url
 * - 异步任务管理（GET /api/v1/tasks/{task_id}、20 QPS、PENDING/RUNNING/SUCCEEDED/FAILED/UNKNOWN）
 *   https://help.aliyun.com/zh/model-studio/manage-asynchronous-tasks
 */
