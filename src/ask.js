/**
 * 外部网关借她的大脑问一句，答案原路回 HTTP——不经过 QQ 投递。
 *
 * 这条路只多了一件事：把「谁在等这个 taskId 的答案」记在内存里。任务本身照旧入队，
 * 照旧由 node-plugin 轮询取走、照旧 POST /node/result；区别只在结果回来时，
 * 是发到 QQ 还是兑现给这里的等待方。
 *
 * 微信端能发的不只是文字：图片走 blob 落盘（和 QQ 图片同一种凭证），
 * 语音在入队前转写成 `[语音] …` 行拼在原文前面——听不懂也要留一行占位，
 * 绝不因为一条语音把整条问答弄丢。
 */

export const DEFAULT_ASK_TIMEOUT_MS = 60000;
export const MAX_ASK_TIMEOUT_MS = 120000;
export const ASK_TEXT_MAX_CHARS = 4000;
export const ASK_FROM_MAX_CHARS = 64;
export const ASK_CHANNELS = Object.freeze(['wechat', 'api']);

// 图片：九宫格一次能发九张，但每一张都要过一遍她的大脑，四张已经够说清一件事。
export const ASK_IMAGE_MAX_COUNT = 4;
export const ASK_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
export const ASK_IMAGE_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// 语音：云端转写一条 1.5–3 秒、本地 whisper 一条 9 秒，两条是这条同步路上的上限。
export const ASK_AUDIO_MAX_COUNT = 2;
export const ASK_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
/** 转写不出来时的占位行：听不懂不等于「他没说话」。 */
export const ASK_VOICE_UNHEARD = '[语音（没听清）]';
/**
 * /node/ask 的请求体上限：base64 比原始字节胖 4/3，按媒体上限折算后
 * 再留 64 KiB 给 text 与 JSON 外壳。默认的 1 MiB 连一张图都装不下。
 */
export const ASK_MAX_BODY_BYTES =
  Math.ceil(((ASK_IMAGE_MAX_COUNT * ASK_IMAGE_MAX_BYTES + ASK_AUDIO_MAX_COUNT * ASK_AUDIO_MAX_BYTES) * 4) / 3) + 64 * 1024;

const MEDIA_SPECS = Object.freeze({
  image: { field: 'images', maxCount: ASK_IMAGE_MAX_COUNT, maxBytes: ASK_IMAGE_MAX_BYTES, mimes: ASK_IMAGE_MIMES },
  audio: { field: 'audios', maxCount: ASK_AUDIO_MAX_COUNT, maxBytes: ASK_AUDIO_MAX_BYTES, mimes: null },
});

/**
 * 入参不合法（400）或超限（413）。http 层照 status 落成响应码，
 * 调用方据此能分清「重发也没用」和「少发两MB就能过」。
 */
export class AskMediaError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AskMediaError';
    this.status = status;
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// 有些网关会把整串 data URL 塞进来，前缀认掉，剩下的仍然是纯 base64。
const DATA_URL_RE = /^data:[^,]*;base64,/;

/** base64 解码后的字节数——不解码就能判上限，省掉一次几 MB 的分配。 */
function base64Bytes(value) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function parseMediaItem(spec, item, index) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new AskMediaError(400, `${spec.field}[${index}] must be an object with mime and dataBase64`);
  }
  const mime = typeof item.mime === 'string' ? item.mime.split(';')[0].trim().toLowerCase() : '';
  if (mime === '') throw new AskMediaError(400, `${spec.field}[${index}].mime is required`);
  // 只有图片有白名单：语音的容器（silk/mp3/amr/wav）太多，硬列反而会误拒。
  if (spec.mimes !== null && !spec.mimes.includes(mime)) {
    throw new AskMediaError(400, `${spec.field}[${index}].mime must be one of ${spec.mimes.join(', ')}`);
  }
  if (typeof item.dataBase64 !== 'string' || item.dataBase64 === '') {
    throw new AskMediaError(400, `${spec.field}[${index}].dataBase64 is required`);
  }
  const dataBase64 = item.dataBase64.replace(DATA_URL_RE, '');
  // 长度 %4==1 是任何编码器都不会产出的残局；再配上字符集检查，Buffer.from 就不会偷笑。
  if (!BASE64_RE.test(dataBase64) || dataBase64.length % 4 === 1) {
    throw new AskMediaError(400, `${spec.field}[${index}].dataBase64 is not valid base64`);
  }
  if (base64Bytes(dataBase64) > spec.maxBytes) {
    throw new AskMediaError(413, `${spec.field}[${index}] is larger than ${spec.maxBytes} bytes`);
  }
  return { mime, dataBase64 };
}

/**
 * 校验并归一 images / audios：未传就是空数组，传了就必须是 [{mime, dataBase64}]。
 * 数量超限算 413（多传没用），格式错算 400（改一改能过）。
 */
export function parseAskMedia(kind, raw) {
  const spec = MEDIA_SPECS[kind];
  if (spec === undefined) throw new TypeError(`unknown ask media kind: ${kind}`);
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AskMediaError(400, `${spec.field} must be an array`);
  if (raw.length > spec.maxCount) throw new AskMediaError(413, `${spec.field} must be at most ${spec.maxCount} items`);
  return raw.map((item, index) => parseMediaItem(spec, item, index));
}

export function createAskInbox({ queue, notifier, log, blobs = null, transcriber = null }) {
  /** taskId -> 等待项。内存表：桥重启就没人等了，和 PC 通道同一个取舍。 */
  const waiting = new Map();

  /** 图片落盘成 blob，task 里带的是和 QQ 图片一样的 {blobId, mime, bytes} 凭证。 */
  function storeImages(list) {
    if (list.length === 0) return [];
    // 没注入 blob store 说明部署漏了一环：宁可回 503，也不能装作收下了图。
    if (blobs === null || typeof blobs.save !== 'function') {
      throw new AskMediaError(503, 'image storage is not configured');
    }
    return list.map((item) => {
      const stored = blobs.save(Buffer.from(item.dataBase64, 'base64'), item.mime);
      return { blobId: stored.blobId, mime: stored.mime, bytes: stored.bytes };
    });
  }

  /** 一条语音 -> 一行 `[语音] …`；没转写器、转写抛错、转出空串都只降级，不失败。 */
  async function voiceLine(item, index) {
    const buffer = Buffer.from(item.dataBase64, 'base64');
    if (transcriber === null || typeof transcriber.transcribe !== 'function') {
      log.warn('ask voice not transcribed', { index, bytes: buffer.byteLength, reason: 'no transcriber' });
      return ASK_VOICE_UNHEARD;
    }
    try {
      const spoken = await transcriber.transcribe(buffer);
      const clean = typeof spoken === 'string' ? spoken.trim() : '';
      if (clean !== '') return `[语音] ${clean}`;
      log.warn('ask voice transcribed to nothing', { index, bytes: buffer.byteLength });
    } catch (error) {
      log.warn('ask voice transcription failed', {
        index,
        bytes: buffer.byteLength,
        reason: error?.message ?? String(error),
      });
    }
    return ASK_VOICE_UNHEARD;
  }

  /** 逐条转写后拼在原文**前面**：她读到的第一行是他嘴里说出来的那句话。 */
  async function withVoices(text, list) {
    if (list.length === 0) return text;
    const lines = [];
    for (const [index, item] of list.entries()) lines.push(await voiceLine(item, index));
    return `${lines.join('\n')}\n${text}`;
  }

  /**
   * 入队并等她回答。
   *
   * images/audios 是网关原样塞进来的 [{mime, dataBase64}]；落盘与转写都在入队前做完，
   * 于是 she 那一侧看到的就是一条普通的带图任务 + 已经转写好的文字。
   *
   * 返回 { status, row, ms }，status 取 settled / timeout / aborted。
   * 超时后这里就把等待项删掉，迟到的 /node/result 找不到人会走 settle 的丢弃分支。
   */
  async function ask({ text, from, channel, timeoutMs, signal, images, audios }) {
    // http 层已经验过一遍；这里再验一次，是为了 ask.js 被单独调用时也一样安全。
    const imageList = parseAskMedia('image', images);
    const audioList = parseAskMedia('audio', audios);
    const storedImages = storeImages(imageList);
    const finalText = await withVoices(text, audioList);

    // replyTarget 给 null：即便别的路径把这一行交给 dispatch，也没有 QQ 目标可发。
    // 真正的开关是 origin:'ask'（dispatch.deliverResult 里的硬拦截），这里是第二道。
    const row = queue.insertTask({
      kind: 'private',
      groupId: null,
      userId: from,
      nickname: from,
      text: finalText,
      images: storedImages,
      // 外部网关不是主人：主人身份会点亮语音回复、也算作「他跟我说话了」的活跃度，
      // 这两件事都只属于 QQ 上的主人本人。
      isOwner: false,
      replyTarget: null,
      mentioned: true,
      needsReply: true,
      origin: 'ask',
    });
    // 不唤醒的话，这条要等一个停着的 /node/poll 到点才有人看见。
    notifier.notify();
    log.info('ask enqueued', {
      taskId: row.task_id,
      channel,
      from,
      textChars: finalText.length,
      images: storedImages.length,
      audios: audioList.length,
      timeoutMs,
    });

    const startedAt = performance.now();
    return new Promise((resolve) => {
      const entry = { timer: null, onAbort: null };
      const finish = (status, settledRow) => {
        // 只认第一次：超时先到就再没有第二次兑现，反过来也一样。
        if (waiting.get(row.task_id) !== entry) return false;
        waiting.delete(row.task_id);
        clearTimeout(entry.timer);
        if (entry.onAbort !== null) signal?.removeEventListener('abort', entry.onAbort);
        resolve({
          status,
          row: settledRow ?? row,
          ms: Math.round(performance.now() - startedAt),
        });
        return true;
      };
      entry.finish = finish;

      entry.timer = setTimeout(() => finish('timeout'), timeoutMs);
      entry.timer.unref?.();
      if (signal) {
        if (signal.aborted) {
          finish('aborted');
          return;
        }
        entry.onAbort = () => finish('aborted');
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      waiting.set(row.task_id, entry);
    });
  }

  /**
   * /node/result 认领这个 taskId。认领到才兑现；超时之后才回来的结果没人等，
   * 直接丢弃——不抛异常，也不写进队列以外的地方。
   */
  function settle(row) {
    const entry = waiting.get(row.task_id);
    if (!entry) return false;
    return entry.finish('settled', row);
  }

  return {
    ask,
    settle,
    get pendingCount() {
      return waiting.size;
    },
  };
}
