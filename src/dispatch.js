import { readFileSync } from 'node:fs';
import { decodeBase64Audio } from './asr.js';
import { faceMarker } from './faces.js';
import { prepareSpeech } from './tts.js';

export const EXPIRED_NOTICE = '这条消息发出时我不在线，已经跳过了。有事再发一次。';
export const RATE_LIMIT_NOTICE = '发得太快了，先歇一会儿再发吧。';

const CQ_CODE_SOURCE = '\\[CQ:([A-Za-z0-9_.-]+)((?:,[^\\]]*)?)\\]';

function unescapeCq(value) {
  return value
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

function parseCqParams(raw) {
  const params = {};
  if (!raw) return params;
  for (const part of raw.replace(/^,/, '').split(',')) {
    if (!part) continue;
    const index = part.indexOf('=');
    if (index === -1) {
      params[unescapeCq(part)] = '';
      continue;
    }
    params[unescapeCq(part.slice(0, index))] = unescapeCq(part.slice(index + 1));
  }
  return params;
}

/** OneBot message (segment array or CQ-code string) -> normalized segments. */
export function normalizeSegments(message) {
  if (Array.isArray(message)) {
    return message
      .filter((segment) => segment && typeof segment === 'object' && typeof segment.type === 'string')
      .map((segment) => ({
        type: segment.type,
        data: segment.data && typeof segment.data === 'object' ? segment.data : {},
      }));
  }
  if (typeof message === 'string') {
    const segments = [];
    let last = 0;
    const pattern = new RegExp(CQ_CODE_SOURCE, 'g');
    for (const match of message.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > last) segments.push({ type: 'text', data: { text: message.slice(last, index) } });
      segments.push({ type: match[1], data: parseCqParams(match[2]) });
      last = index + match[0].length;
    }
    if (last < message.length) segments.push({ type: 'text', data: { text: message.slice(last) } });
    return segments;
  }
  return [];
}

/** Segment types that carry fetchable picture bytes: plain images and QQ's market stickers. */
const PICTURE_SEGMENT_TYPES = new Set(['image', 'mface', 'marketface']);
/** Segment types that only carry an emoji id, never bytes. */
const EMOJI_SEGMENT_TYPES = new Set(['face', 'sface']);
/** Segment types holding a voice clip we can pull back through get_record. */
const VOICE_SEGMENT_TYPES = new Set(['record']);
/** Segment types holding a short video; we split it into frames + audio. */
const VIDEO_SEGMENT_TYPES = new Set(['video']);
/**
 * 没有字节、也不是表情，但仍然是一条消息的段。以前这些一律被丢掉，于是一条「分享的卡片」
 * 或「合并转发」到她那儿就是空字符串——线上他真的发了两条，她只能回「消息是空的，是手滑
 * 了吗」，连着问了两遍。宁可给她一个看得见的占位，也不要假装什么都没发生。
 */
const CARD_SEGMENT_MARKERS = new Map([
  ['json', '[卡片消息]'],
  ['xml', '[卡片消息]'],
  ['forward', '[合并转发]'],
  ['share', '[链接分享]'],
  ['music', '[音乐分享]'],
  ['file', '[文件]'],
  ['poke', '[戳一戳]'],
  ['dice', '[骰子]'],
  ['rps', '[猜拳]'],
]);
/** 这些段本来就不带文字：@ 会被剥掉，引用在历史里另算。别把它们当「看不懂的段」。 */
const SILENT_SEGMENT_TYPES = new Set(['text', 'at', 'reply']);

function pictureSource(segment) {
  return { url: String(segment.data?.url ?? ''), file: String(segment.data?.file ?? '') };
}

/** Plain text with @bot and CQ codes stripped (may be an empty string for image-only messages). */
export function extractText(segments) {
  return segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => String(segment.data?.text ?? ''))
    .join('')
    .replace(new RegExp(CQ_CODE_SOURCE, 'g'), '')
    .trim();
}

/**
 * OneBot 11 message event -> the pieces the queue needs.
 * Returns null for anything that is not a group/private message.
 */
export function extractMessage(event, { selfId = '', onSticker = null } = {}) {
  if (!event || event.post_type !== 'message') return null;
  const kind = event.message_type === 'group' ? 'group' : event.message_type === 'private' ? 'private' : null;
  if (!kind) return null;

  const userId = String(event.user_id ?? event.sender?.user_id ?? '');
  if (!userId) return null;
  const groupId = kind === 'group' ? String(event.group_id ?? '') : null;
  if (kind === 'group' && groupId === '') return null;

  const segments = normalizeSegments(event.message);
  const mentioned =
    selfId !== '' &&
    segments.some((segment) => segment.type === 'at' && String(segment.data?.qq ?? '') === String(selfId));
  const images = segments
    .filter((segment) => PICTURE_SEGMENT_TYPES.has(segment.type))
    .map(pictureSource)
    .filter((image) => image.url !== '' || image.file !== '');
  // A sticker with no fetchable bytes still means something, and so does a plain emoji
  // segment: drop neither into silence, turn them into text markers instead.
  const markers = [];
  for (const segment of segments) {
    if (PICTURE_SEGMENT_TYPES.has(segment.type)) {
      const source = pictureSource(segment);
      if (source.url === '' && source.file === '') {
        // 表情包经常只带 emoji_id/key，取不到字节。留个探针：真出问题时能看见
        // 服务端到底给了什么，而不是猜。
        onSticker?.(segment);
        markers.push(faceMarker(segment, { sticker: true }));
      }
    } else if (EMOJI_SEGMENT_TYPES.has(segment.type)) {
      markers.push(faceMarker(segment));
    } else if (VOICE_SEGMENT_TYPES.has(segment.type)) {
      markers.push('[语音]');
    } else if (VIDEO_SEGMENT_TYPES.has(segment.type)) {
      markers.push('[视频]');
    } else if (CARD_SEGMENT_MARKERS.has(segment.type)) {
      markers.push(CARD_SEGMENT_MARKERS.get(segment.type));
    } else if (!SILENT_SEGMENT_TYPES.has(segment.type)) {
      // 完全没见过的段：把类型名亮出来，比让她收到一条空消息强。
      markers.push(`[${segment.type}]`);
    }
  }
  const voice =
    segments
      .filter((segment) => VOICE_SEGMENT_TYPES.has(segment.type))
      .map((segment) => ({ file: String(segment.data?.file ?? ''), url: String(segment.data?.url ?? '') }))
      .find((clip) => clip.file !== '' || clip.url !== '') ?? null;
  const videos = segments
    .filter((segment) => VIDEO_SEGMENT_TYPES.has(segment.type))
    .map((segment) => ({ file: String(segment.data?.file ?? ''), url: String(segment.data?.url ?? '') }))
    .filter((clip) => clip.file !== '' || clip.url !== '');
  const plain = extractText(segments);
  const text = [plain, markers.join('')].filter((part) => part !== '').join(' ');
  const nickname = String(event.sender?.nickname || event.sender?.card || userId);

  return { kind, groupId, userId, nickname, text, images, mentioned, voice, videos };
}

/** Split on code points so a surrogate pair is never cut in half. */
export function chunkText(text, max) {
  const points = Array.from(String(text));
  if (points.length === 0) return [];
  const chunks = [];
  for (let index = 0; index < points.length; index += max) chunks.push(points.slice(index, index + max).join(''));
  return chunks;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const toOneBotId = (value) => (/^\d+$/.test(String(value)) ? Number(value) : value);

export function createDispatch({
  config,
  queue,
  ratelimiter,
  blobs,
  notifier,
  log,
  now = () => Date.now(),
  getClient = () => null,
  transcriber = { enabled: false, transcribe: async () => '' },
  synthesizer = { enabled: false, synthesize: async () => null },
  video = { enabled: false, extract: async () => ({ frames: [], audio: null }) },
  timing = {},
}) {
  const segmentChars = timing.segmentChars ?? 1800;
  const segmentDelayMs = timing.segmentDelayMs ?? 300;
  const sendBackoffMs = timing.sendBackoffMs ?? [1000, 2000, 4000];
  // 慢回合先垫一句：她 180 秒的上限里，超过这么久还没结果就先让对面知道有人在。
  const slowAckMs = timing.slowAckMs ?? 22_000;
  const slowAckText = timing.slowAckText ?? '在呢，我想一下。';
  // 第二句更晚：一个回合跑进一分钟，说明她真的在干活（工具调用多的回合均值 133 秒），
  // 这时候再补一句「还在弄」，别让对方以为这条消息丢了。
  const slowLateMs = timing.slowLateMs ?? 90_000;
  const slowLateText = timing.slowLateText ?? '还在弄，别急，一会儿就说。';
  // 第三句更晚：超时上限提到 240 秒之后，90 秒到 240 秒之间是一段新的空白，
  // 而这正是做 PPT、批量看图那种长回合最常见的时段。
  const slowDeepMs = timing.slowDeepMs ?? 180_000;
  const slowDeepText = timing.slowDeepText ?? '这条比平时长，我还在弄。';
  // 还在等并发槽（`queued` / `delivering`）时说的那三句：她连想都还没开始想，
  // 说「在呢，我想一下」是把排队装成思考。线上排过 187 秒，得说真话。
  const slowQueuedText = timing.slowQueuedText ?? '前面那条我还在弄，你这条我记下了，稍等一下就到。';
  const slowQueuedLateText = timing.slowQueuedLateText ?? '还在排队：前面那条比平时长，轮到你就说。';
  const slowQueuedDeepText = timing.slowQueuedDeepText ?? '这条排得有点久了，我没忘，前一条一完就回你。';
  const slowFailureText = timing.slowFailureText ?? '我这边卡了一下，你再说一次好吗？';
  // 超时的回合往往干到一半（样本：一口气 41 步在做 PPT），说「卡了」既不准也没下文。
  const slowTimeoutText = timing.slowTimeoutText ?? '这事儿比我想的费时间，我先停在这儿了。你说句「继续」，我接着弄。';
  const slowAcks = new Map();
  // 这一轮她已经自己开口过的任务：垫话阶梯对这些任务静默（见 `markSpoke`）。
  const spokeEarly = new Set();
  const owners = new Set((config.ownerQq ?? []).map(String));
  const groupMode = config.groupMode ?? 'mention';
  const pending = new Map();
  let selfId = '';

  function track(key, promise) {
    pending.set(key, promise);
    promise
      .catch(() => {})
      .finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
    return promise;
  }

  function noteSelf(event) {
    if (event && event.self_id !== undefined && event.self_id !== null) selfId = String(event.self_id);
  }

  async function sendChunk(target, text) {
    const client = getClient();
    if (!client) throw new Error('onebot client unavailable');
    const isGroup = target.kind === 'group';
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const params = {
      ...(isGroup ? { group_id: toOneBotId(target.groupId) } : { user_id: toOneBotId(target.userId) }),
      message: [{ type: 'text', data: { text } }],
    };
    const attempts = sendBackoffMs.length + 1; // 3 retries after the first try (1s/2s/4s)
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(sendBackoffMs[attempt - 2]);
      try {
        const response = await client.call(action, params);
        const rejected = !response || response.status === 'failed' || (response.retcode !== undefined && response.retcode !== 0);
        if (rejected) throw new Error(`onebot rejected ${action} (status=${response?.status} retcode=${response?.retcode})`);
        return response;
      } catch (error) {
        lastError = error;
        log.warn('qq send attempt failed', { action, attempt, attempts, reason: error.message });
      }
    }
    throw lastError ?? new Error(`${action} failed`);
  }

  async function sendReply(target, text) {
    const chunks = chunkText(text, segmentChars);
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) await sleep(segmentDelayMs);
      await sendChunk(target, chunks[index]);
    }
    return { segments: chunks.length };
  }

  /**
   * 一条语音 = 一个 record 段，一张图 = 一个 image 段。
   * 两者都不切分：切开的半句话没法听，切开的半张图没法看。
   *
   * 负载一律 base64：NapCat 现在跑在另一台机器上（见 DECISIONS D47 的隧道方案），
   * 传本机路径过去那边就是「文件不存在」，语音连续 65 次 retcode=1200 全是这个原因。
   * 内容跟着协议走，谁在哪台机器上都无所谓。
   */
  function segmentFile(file, type) {
    if (typeof file !== 'string' || file === '') return file;
    // 已经是 base64:// 或 http(s):// 的原样发；其余一律当本地文件读成 base64。
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(file)) return file;
    try {
      return `base64://${readFileSync(file).toString('base64')}`;
    } catch (err) {
      log?.warn?.(`${type} file unreadable, send the path as-is`, { file, reason: err.message });
      return file;
    }
  }

  async function sendSegment(target, file, type) {
    const client = getClient();
    if (!client) throw new Error('onebot client unavailable');
    const isGroup = target.kind === 'group';
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const params = {
      ...(isGroup ? { group_id: toOneBotId(target.groupId) } : { user_id: toOneBotId(target.userId) }),
      message: [{ type, data: { file: segmentFile(file, type) } }],
    };
    const response = await client.call(action, params);
    const rejected = !response || response.status === 'failed' || (response.retcode !== undefined && response.retcode !== 0);
    if (rejected) throw new Error(`onebot rejected ${type} (status=${response?.status} retcode=${response?.retcode})`);
    return response;
  }

  const sendVoice = (target, file) => sendSegment(target, file, 'record');
  const sendImage = (target, file) => sendSegment(target, file, 'image');

  /**
   * 一个文件走 upload_*_file 这条动作，不是消息段：OneBot 没有「文件段」这种东西。
   *
   * 内容照样读成 base64（`segmentFile`）——她做好的 PPT 在她那台机器上，
   * NapCat 在另一台，传路径过去那边只会说文件不存在。
   */
  async function sendFile(target, file, name) {
    const client = getClient();
    if (!client) throw new Error('onebot client unavailable');
    const isGroup = target.kind === 'group';
    const action = isGroup ? 'upload_group_file' : 'upload_private_file';
    const params = {
      ...(isGroup ? { group_id: toOneBotId(target.groupId) } : { user_id: toOneBotId(target.userId) }),
      file: segmentFile(file, 'file'),
      name,
    };
    const response = await client.call(action, params);
    const rejected = !response || response.status === 'failed' || (response.retcode !== undefined && response.retcode !== 0);
    if (rejected) throw new Error(`onebot rejected file (status=${response?.status} retcode=${response?.retcode})`);
    return response;
  }

  const voiceQuota = { day: '', used: 0 };
  const stickerTypes = new Set();
  const voiceMaxChars = config.tts?.maxChars ?? 60;
  const voiceDailyMax = config.tts?.dailyMax ?? 0;

  /**
   * 这一条该不该用说的。
   *
   * 只给主人的私聊——群里一条语音会把所有人的注意力拽过来，那是打扰不是陪伴。
   * 只给短句——长段文字念出来又慢又难懂，她真正想「说」的往往是那一两句。
   * 额度用完就闭嘴打字，明天再说。
   */
  async function speakInstead(target, row, text) {
    if (synthesizer.enabled !== true) return null;
    if (target.kind !== 'private') return null;
    // 这一行拿到的是队列转换过的任务（`isOwner` 布尔），不是原始行（`is_owner` 0/1）。
    if (row.is_owner !== 1 && row.isOwner !== true) return null;
    if (voiceDailyMax <= 0) return null;
    // 长度按「要念出来的那句话」算，不按写给人看的原文算：
    // 满屏 Markdown 的短句念出来其实很短，反过来也可能相反。
    if ([...prepareSpeech(text)].length > voiceMaxChars) return null;
    const day = new Date(now()).toISOString().slice(0, 10);
    if (voiceQuota.day !== day) {
      voiceQuota.day = day;
      voiceQuota.used = 0;
    }
    if (voiceQuota.used >= voiceDailyMax) return null;
    const audio = await synthesizer.synthesize(text);
    if (!audio) return null;
    voiceQuota.used += 1;
    log.info('qq voice reply', { taskId: row.task_id, bytes: audio.bytes, usedToday: voiceQuota.used });
    return audio;
  }

  function parseTarget(raw) {
    try {
      const target = JSON.parse(raw);
      return target && typeof target === 'object' && target.kind ? target : null;
    } catch {
      return null;
    }
  }

  /** Deliver a recorded result to QQ, then settle the task as done/failed. */
  function deliverResult(row) {
    // ask 任务的答案是 /node/ask 的 HTTP 回复，这条通路永远不该发出 QQ 消息。
    // 正常情况下 http 那边根本不会把 ask 行送到这里；这一道是为了「万一」而留：
    // 少发一条消息可以补，错发一条到别人 QQ 上就收不回来了。
    if (row.origin === 'ask') {
      log.info('ask task not delivered to qq', { taskId: row.task_id, ok: row.result_ok === 1 });
      queue.finish(row.task_id, { ok: row.result_ok === 1 });
      return Promise.resolve();
    }
    const promise = (async () => {
      const text = row.result_text ?? '';
      const resultOk = row.result_ok === 1;
      const target = parseTarget(row.reply_target);
      let delivered = true;
      // 回合挂了（超时 / 模型报错）时她一个字都没有，对面只能干等——私聊里说一句总比沉默强。
      // 群里不说：一群人正在聊天时突然插一句「我卡了」是噪音。
      if (!resultOk && text === '' && target && row.needs_reply === 1 && row.is_owner === 1 && row.kind === 'private') {
        // 超时和工具预算都不是「卡了」，是「还没弄完就停下了」——让她从头再来一遍是最坏的回答。
        // 插件那边这两种情况上报的 error 分别是 `turn timeout` 与 `tool budget`。
        const stoppedMidway = /turn timeout|tool budget/i.test(String(row.result_error ?? ''));
        try {
          await sendReply(target, stoppedMidway ? slowTimeoutText : slowFailureText);
          log.info(stoppedMidway ? 'stopped turn explained to the user' : 'failed turn explained to the user', {
            taskId: row.task_id,
            reason: row.result_error,
          });
        } catch (error) {
          delivered = false;
          log.error('failure notice failed', { taskId: row.task_id, reason: error.message });
        }
      }
      if (text !== '' && target) {
        try {
          const audio = await speakInstead(target, row, text);
          if (audio) {
            try {
              await sendVoice(target, audio.file);
            } catch (error) {
              log.warn('qq voice send failed, falling back to text', { taskId: row.task_id, reason: error.message });
              await sendReply(target, text);
            }
          } else {
            await sendReply(target, text);
          }
        } catch (error) {
          delivered = false;
          log.error('qq reply failed after retries', { taskId: row.task_id, reason: error.message });
        }
      }
      const success = resultOk && delivered;
      const finished = queue.finish(row.task_id, { ok: success });
      log[success ? 'info' : 'warn']('task finished', {
        taskId: row.task_id,
        status: finished?.status,
        resultOk,
        delivered,
        segments: chunkText(text, segmentChars).length,
      });
    })();
    return track(row.task_id, promise);
  }

  /** queued tasks past their deadline are dropped; only tasks that needed a reply get the notice. */
  function sweepExpired(at = now()) {
    const rows = queue.expireOverdue(at);
    for (const row of rows) {
      log.info('task expired', { taskId: row.task_id, deadlineAt: row.deadline_at, needsReply: row.needs_reply === 1 });
      // GROUP_MODE=all context-only tasks expire silently: nobody asked the bot anything.
      if (row.needs_reply !== 1) continue;
      const target = parseTarget(row.reply_target);
      if (!target) continue;
      track(
        `expired:${row.task_id}`,
        sendReply(target, EXPIRED_NOTICE).catch((error) => {
          log.warn('expired notice failed', { taskId: row.task_id, reason: error.message });
        }),
      );
    }
    return rows.length;
  }

  /**
   * Pull the clip back through NapCat and transcribe it. Every failure path
   * returns '' and leaves the bare [语音] marker in place: a voice note she
   * cannot hear still beats a message that never arrives.
   */
  async function transcribeVoice(clip) {
    const client = getClient();
    if (!client || typeof client.call !== 'function') return '';
    try {
      const response = await client.call('get_record', { file: clip.file || clip.url, out_format: 'mp3' });
      // NapCat answers with status:"failed" and a retcode rather than throwing.
      if (response?.status === 'failed' || (typeof response?.retcode === 'number' && response.retcode !== 0)) {
        log.warn('voice: get_record refused', { retcode: response?.retcode, reason: response?.message });
        return '';
      }
      const bytes = decodeBase64Audio(response?.data?.base64 ?? response?.base64 ?? '');
      if (!bytes) {
        log.warn('voice: get_record returned no audio', { file: clip.file });
        return '';
      }
      return await transcriber.transcribe(bytes);
    } catch (error) {
      log.warn('voice: get_record failed', { reason: error.message });
      return '';
    }
  }

  async function handleOne(event) {
    if (!event || typeof event !== 'object') return null;
    noteSelf(event);
    if (event.post_type !== 'message') return null;
    if (selfId !== '' && String(event.user_id) === selfId) return null; // never answer ourselves

    const message = extractMessage(event, {
      selfId: selfId || String(event.self_id ?? ''),
      // 每种表情类型只报一次，够看清服务端给了什么，又不会刷屏。
      onSticker: (segment) => {
        if (stickerTypes.has(segment.type)) return;
        stickerTypes.add(segment.type);
        log.info('sticker without bytes', {
          type: segment.type,
          data: JSON.stringify(segment.data ?? {}).slice(0, 300),
        });
      },
    });
    if (!message) return null;
    const isGroup = message.kind === 'group';
    // D8: in `mention` mode a group message that never @s the bot is not for us.
    // GROUP_MODE=all keeps it as context instead: it is queued but never answered.
    if (isGroup && !message.mentioned && groupMode !== 'all') return null;

    // Private chat always answers and always counts as an @; in a group both follow the @.
    const mentioned = isGroup ? message.mentioned : true;
    const needsReply = mentioned;

    const replyTarget =
      message.kind === 'group'
        ? { kind: 'group', groupId: message.groupId }
        : { kind: 'private', userId: message.userId };

    const rate = ratelimiter.register(message.userId);
    if (!rate.allowed) {
      log.warn('message dropped by rate limit', { userId: message.userId, count: rate.count });
      if (rate.noticeAllowed) {
        track(
          `rate:${message.userId}:${now()}`,
          sendReply(replyTarget, RATE_LIMIT_NOTICE).catch((error) => {
            log.warn('rate limit notice failed', { reason: error.message });
          }),
        );
      }
      return null;
    }

    const images = [];
    for (const image of message.images) {
      const stored = await blobs.download(image);
      if (stored) images.push({ blobId: stored.blobId, mime: stored.mime, bytes: stored.bytes });
      else log.warn('image skipped', { userId: message.userId });
    }

    let text = message.text;
    if (text.includes('[语音]')) {
      // Always say something when a voice note lands: without this line a note
      // with no fetchable handle looks exactly like "she never got it".
      log.info('voice note seen', {
        enabled: transcriber.enabled,
        file: message.voice?.file ?? '',
        url: message.voice?.url ?? '',
      });
    }
    if (message.voice && transcriber.enabled) {
      const spoken = await transcribeVoice(message.voice);
      if (spoken !== '') text = text.replace('[语音]', `[语音] ${spoken}`);
    }

    // 视频拆成「几帧画面 + 一段音轨」，走的是她已经会的两条路：
    // 画面进 images 当图片，音轨进 transcriber 当语音。协议一个字都不用改。
    if (video.enabled && message.videos.length > 0) {
      for (const clip of message.videos) {
        const loaded = await blobs.load(clip.url !== '' ? clip.url : clip.file);
        if (!loaded) {
          log.warn('video skipped: cannot load', { userId: message.userId, file: clip.file });
          continue;
        }
        const split = await video.extract(loaded.buffer);
        for (const frame of split.frames) {
          const stored = blobs.save(frame, 'image/jpeg');
          if (stored) images.push({ blobId: stored.blobId, mime: stored.mime, bytes: stored.bytes });
        }
        let spoken = '';
        if (split.audio && transcriber.enabled) {
          spoken = await transcriber.transcribe(split.audio);
        }
        log.info('video split', { frames: split.frames.length, audio: split.audio !== null, spoken: spoken !== '' });
        const label = spoken === '' ? '[视频]' : `[视频] ${spoken}`;
        text = text.replace('[视频]', label);
      }
    }

    const row = queue.insertTask({
      kind: message.kind,
      groupId: message.groupId,
      userId: message.userId,
      nickname: message.nickname,
      text,
      images,
      isOwner: owners.has(message.userId),
      replyTarget,
      mentioned,
      needsReply,
    });
    notifier.notify();
    log.info('task enqueued', {
      taskId: row.task_id,
      kind: row.kind,
      userId: row.user_id,
      images: images.length,
      textChars: text.length,
      isOwner: row.is_owner === 1,
      needsReply,
    });
    return row;
  }

  /** Accepts one event or an array of events; a broken event never kills the listener. */
  async function handleEvent(raw) {
    const events = Array.isArray(raw) ? raw : [raw];
    for (const event of events) {
      try {
        await handleOne(event);
      } catch (error) {
        log.error('event handling failed', { reason: error.message });
      }
    }
  }

  /**
   * 回合慢了就先垫一句「在呢」，再慢就补一句「还在弄」。
   *
   * 只垫主人私聊里真要回的那条：群里垫一句会打断所有人，ask 行的答案本来就由 HTTP 兑现，
   * proactive 是她主动开口、不需要再确认。垫过就不再垫，真正的回复到了照常发。
   */
  function noteSlowAck(task) {
    if (!task || task.needsReply !== true || task.isOwner !== true) return;
    if (task.proactive === true) return;
    if (task.origin === 'ask') return;
    const target = task.replyTarget ?? (task.kind === 'group'
      ? { kind: 'group', groupId: task.groupId }
      : { kind: 'private', userId: task.userId });
    if (!target) return;
    const taskId = task.taskId;
    // 她自己在回合中途已经说过真话（`/node/send` 带 taskId），后面的罐头垫话就免了：
    // 75 秒刚发完一句真话，90 秒再补一句「还在弄」只会显得吵。
    if (slowAcks.has(taskId) || spokeEarly.has(taskId)) return;
    const timers = new Set();
    slowAcks.set(taskId, timers);
    const schedule = (delayMs, texts, message) => {
      const timer = setTimeout(async () => {
        timers.delete(timer);
        try {
          const fresh = queue.getRow(taskId);
          if (!fresh || fresh.status === 'done' || fresh.status === 'failed') return;
          // 排队和在想的差别对方是能感觉到的：`queued`/`delivering` 表示她连话都还没开始想
          // （node 那一侧还在等并发槽，线上最长等过 187 秒）。这时候说「在呢，我想一下」
          // 是在撒谎，说「前面那条还在弄」才对得上他的体感。
          const waiting = fresh.status === 'queued' || fresh.status === 'delivering';
          await sendChunk(target, waiting ? texts.waiting : texts.working);
          log.info(message, { taskId, waitedMs: delayMs, status: fresh.status });
        } catch (err) {
          log.warn('slow ack failed', { taskId, reason: err.message });
        }
      }, delayMs);
      timer.unref?.();
      timers.add(timer);
    };
    schedule(slowAckMs, { waiting: slowQueuedText, working: slowAckText }, 'slow turn acked');
    if (slowLateMs > slowAckMs) schedule(slowLateMs, { waiting: slowQueuedLateText, working: slowLateText }, 'slow turn still working');
    if (slowDeepMs > slowLateMs) schedule(slowDeepMs, { waiting: slowQueuedDeepText, working: slowDeepText }, 'slow turn still running');
  }

  /** 结果回来了就把垫话撤掉：别在她已经说完之后又冒一句「在呢」。 */
  function clearSlowAck(taskId) {
    const timers = slowAcks.get(taskId);
    if (timers) {
      for (const timer of timers) clearTimeout(timer);
      slowAcks.delete(taskId);
    }
    spokeEarly.delete(taskId);
  }

  /**
   * 节点在这一轮里已经自己开口了（`/node/send` 带 taskId）：撤掉还没发出去的
   * 垫话，并且这一轮不再排新的。结果回来时 `clearSlowAck` 会把标记一起清掉。
   */
  function markSpoke(taskId) {
    if (typeof taskId !== 'string' || taskId === '') return;
    clearSlowAck(taskId);
    spokeEarly.add(taskId);
  }

  return {
    handleEvent,
    handleOne,
    sweepExpired,
    deliverResult,
    sendReply,
    sendChunk,
    sendImage,
    sendFile,
    noteSlowAck,
    clearSlowAck,
    markSpoke,
    whenSettled: (key) => pending.get(key) ?? Promise.resolve(),
    get pendingCount() {
      return pending.size;
    },
    get selfId() {
      return selfId;
    },
  };
}
