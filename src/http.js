import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { rowToTask } from './queue.js';
import {
  ASK_CHANNELS,
  ASK_FROM_MAX_CHARS,
  ASK_MAX_BODY_BYTES,
  ASK_TEXT_MAX_CHARS,
  AskMediaError,
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_ASK_TIMEOUT_MS,
  parseAskMedia,
} from './ask.js';

const MAX_BODY_BYTES = 1024 * 1024;
// PC 通道的 write 要带最多 1MB 的文件内容，JSON 转义之后 1.5MB 才够。
const PC_MAX_BODY_BYTES = 1536 * 1024;
/** PC 通道的五条路由；名字就是 pc-relay 上的方法名。 */
const PC_ROUTES = new Map([
  ['/node/pc/heartbeat', { method: 'POST', name: 'heartbeat' }],
  ['/node/pc/poll', { method: 'POST', name: 'poll' }],
  ['/node/pc/result', { method: 'POST', name: 'result' }],
  ['/node/pc/enqueue', { method: 'POST', name: 'enqueue' }],
  ['/node/pc/status', { method: 'GET', name: 'status' }],
]);
const DEFAULT_WAIT_S = 25;
const MAX_WAIT_S = 30;
const DEFAULT_LIMIT = 2;
const MAX_LIMIT = 5;

// /send_image 只能发图片，且只认这些扩展名。表情包也走这条路，所以 .gif 要在。
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

// /node/send 只推纯文本，一条消息一个上限：晨报这类长得像文章的正文就到这里为止。
const TEXT_MAX_CHARS = 2000;

// /node/send_file 发的是她做好的东西（PPT、PDF、表格），不走消息段，也没有扩展名白名单：
// 只要求落在 QQ_FILE_ROOTS 里、是个常规文件、别超过 20 MB（base64 之后约 27 MB 上 WS）。
const FILE_MAX_BYTES = 20 * 1024 * 1024;
const FILE_NAME_MAX_CHARS = 100;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const badRequest = (message) => new HttpError(400, message);

function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  sendJson(res, 405, { ok: false, error: 'method not allowed' });
}

/** Constant-time-ish comparison; hashing first keeps lengths equal. */
function tokenMatches(presented, expected) {
  const a = crypto.createHash('sha256').update(String(presented)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function authorized(req, expectedToken) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  if (!match) return false;
  return tokenMatches(match[1], expectedToken);
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      // 把剩下的请求体读完丢掉，再回 413。直接在传输中间挂断的话，客户端往往
      // 只看到 EPIPE 而不是那条 413，等于白拒一次。
      req.resume();
      throw new HttpError(413, 'request body too large');
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw badRequest('request body must be a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw badRequest('request body is not valid JSON');
  }
}

function parseBounded(searchParams, name, fallback, min, max) {
  const raw = searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw badRequest(`${name} must be a non-negative integer`);
  return Math.min(max, Math.max(min, Number(raw)));
}

export function createHttpServer({
  config,
  queue,
  blobs,
  dispatch,
  notifier,
  log,
  now = () => Date.now(),
  state = { closed: false },
  timing = {},
  napcatUp = null,
  pcRelay = null,
  ask = null,
  reminders = null,
}) {
  const startedAt = now();
  const pollSliceMs = timing.pollSliceMs ?? 1000;
  const pcBodyLimit = config.pc?.maxBodyBytes ?? PC_MAX_BODY_BYTES;

  async function handleHealth(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    // `ok` 只说「桥自己活着」，不代表 QQ 那条线活着——17:35 那次掉线就是这样：
    // 进程好好的、端口在听、/health 一直 ok，但 NapCat 停在登录页，她其实聋了。
    // 所以把连线上报出来，让巡检有东西可判。
    const link = typeof napcatUp === 'function' ? (napcatUp() ? 'up' : 'down') : undefined;
    return sendJson(res, 200, {
      ok: true,
      queued: queue.queuedCount(),
      uptimeMs: Math.max(0, now() - startedAt),
      ...(link === undefined ? {} : { napcat: link }),
    });
  }

  async function handlePoll(req, res, searchParams) {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    const waitSec = parseBounded(searchParams, 'wait', DEFAULT_WAIT_S, 0, MAX_WAIT_S);
    const limit = parseBounded(searchParams, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
    // The wait window is wall clock on purpose: task deadlines come from the injected
    // clock, so a parked poll must never depend on it advancing to terminate.
    const waitBudgetMs = waitSec * 1000;
    const pollStartedAt = performance.now();
    for (;;) {
      if (state.closed) return sendJson(res, 200, { tasks: [] });
      dispatch.sweepExpired();
      const rows = queue.claim({ limit, at: now() });
      if (rows.length > 0) {
        const tasks = rows.map(rowToTask);
        // 交出去的那一刻开始计时：过了 slowAckMs 还没结果就先垫一句，别让对面干等。
        for (const task of tasks) dispatch.noteSlowAck(task);
        return sendJson(res, 200, { tasks });
      }
      const remaining = waitBudgetMs - (performance.now() - pollStartedAt);
      if (remaining <= 0) return sendJson(res, 200, { tasks: [] });
      if (res.destroyed || res.writableEnded) return undefined;
      // Bounded slices keep expiry notices prompt even while a poll is parked.
      await notifier.wait(Math.min(remaining, pollSliceMs));
    }
  }

  /**
   * 她给自己排一个闹钟。
   *
   * 只有主人在场时插件才会调这条路，但桥接这一层也自己再判一次：
   * 一条能往任意 QQ 号准点推消息的接口，不该信任调用方。
   */
  async function handleRemind(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    if (!reminders) return sendJson(res, 503, { ok: false, error: 'reminders disabled' });
    const body = await readJsonBody(req);
    const text = body.text;
    if (typeof text !== 'string' || text.trim() === '') throw badRequest('text is required');
    const at = Number(body.at);
    if (!Number.isFinite(at)) throw badRequest('at must be epoch milliseconds');
    const to = body.to === undefined ? String(config.ownerQq?.[0] ?? '') : String(body.to);
    if (!/^\d{5,12}$/.test(to)) throw badRequest('to must be a QQ number');
    try {
      const created = reminders.add({ at, text, target: JSON.stringify({ kind: 'private', userId: to }), atNow: now() });
      log.info('reminder accepted', { reminderId: created.reminderId, at: created.at, duplicate: created.duplicate === true });
      return sendJson(res, 200, { ok: true, reminderId: created.reminderId, at: created.at, duplicate: created.duplicate === true });
    } catch (err) {
      if (err.code === undefined) throw err;
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  async function handleStatus(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    const body = await readJsonBody(req);
    if (typeof body.taskId !== 'string' || body.taskId === '') throw badRequest('taskId is required');
    if (body.state !== 'accepted' && body.state !== 'running') {
      throw badRequest('state must be "accepted" or "running"');
    }
    const outcome = queue.markRunning(body.taskId, { at: now() });
    if (!outcome.found) return sendJson(res, 404, { ok: false, error: 'unknown taskId' });
    log.info('task status updated', { taskId: body.taskId, state: body.state });
    return sendJson(res, 200, { ok: true });
  }

  async function handleResult(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    const body = await readJsonBody(req);
    if (typeof body.taskId !== 'string' || body.taskId === '') throw badRequest('taskId is required');
    if (typeof body.ok !== 'boolean') throw badRequest('ok must be a boolean');
    if (typeof body.text !== 'string') throw badRequest('text must be a string');
    const error = body.error === undefined ? null : body.error;
    if (error !== null && typeof error !== 'string') throw badRequest('error must be a string or null');

    const outcome = queue.recordResult(body.taskId, { ok: body.ok, text: body.text, error, at: now() });
    dispatch.clearSlowAck(body.taskId);
    if (!outcome.found) return sendJson(res, 404, { ok: false, error: 'unknown taskId' });
    if (outcome.duplicate) {
      log.warn('duplicate result ignored', { taskId: body.taskId });
      return sendJson(res, 200, { ok: true, duplicate: true });
    }
    log.info('result recorded', { taskId: body.taskId, ok: body.ok, textChars: body.text.length, error });
    // ask 行不走 QQ：答案由 /node/ask 那条还在等着的请求兑现。认领不到（已经超时）就丢弃。
    if (outcome.row.origin === 'ask') {
      const claimed = ask === null ? false : ask.settle(outcome.row);
      queue.finish(outcome.row.task_id, { ok: outcome.row.result_ok === 1 });
      if (!claimed) log.info('late ask result dropped', { taskId: body.taskId });
      return sendJson(res, 200, claimed ? { ok: true } : { ok: true, dropped: true });
    }
    dispatch.deliverResult(outcome.row);
    return sendJson(res, 200, { ok: true });
  }

  async function handleBlob(req, res, blobId) {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    const blob = blobId === '' ? null : blobs.find(blobId);
    if (!blob) return sendJson(res, 404, { ok: false, error: 'unknown blobId' });
    const bytes = fs.readFileSync(blob.path);
    if (res.writableEnded || res.destroyed) return undefined;
    res.writeHead(200, {
      'Content-Type': blob.mime,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store',
    });
    res.end(bytes);
    return undefined;
  }

  async function handleSendImage(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    const body = await readJsonBody(req);
    const kind = body.kind === undefined ? 'private' : body.kind;
    if (kind !== 'private' && kind !== 'group') throw badRequest('kind must be "private" or "group"');
    const to = body.to;
    if (typeof to !== 'string' || !/^\d{5,12}$/.test(to)) throw badRequest('to must be a QQ number or group id');
    const file = body.file;
    if (typeof file !== 'string' || file === '') throw badRequest('file is required');
    // 只按扩展名放行：这条路能读服务器上的任意文件，不能让它变成「把 /etc/shadow 发出去」。
    const dot = file.lastIndexOf('.');
    const ext = dot < 0 ? '' : file.slice(dot).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) throw badRequest(`file must end with ${[...IMAGE_EXTENSIONS].join(' / ')}`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return sendJson(res, 404, { ok: false, error: 'file not found' });
    }
    if (!stat.isFile()) throw badRequest('file must be a regular file');
    if (stat.size === 0) throw badRequest('file is empty');
    if (stat.size > IMAGE_MAX_BYTES) throw badRequest('file is larger than 10 MB');

    const target = kind === 'group' ? { kind: 'group', groupId: to } : { kind: 'private', userId: to };
    const response = await dispatch.sendImage(target, file);
    log.info('image sent', { to, kind, bytes: stat.size, file });
    return sendJson(res, 200, { ok: true, messageId: response?.data?.message_id });
  }

  /**
   * 服务器上的定时脚本（晨报之类）往主人私聊推一条纯文本。
   *
   * 只认主人：这条路是要被 cron 调的，不能变成「往任意 QQ 号推消息」的口子。
   * 主人取 proactive.js 用的同一个字段（OWNER_QQ 的第一个）；没配主人时一律拒，
   * 宁可这条路由哑掉，也不要它变成谁都能用的广播器。
   */
  async function handleSendText(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    const body = await readJsonBody(req);
    const to = body.to;
    if (typeof to !== 'string' || !/^\d{5,12}$/.test(to)) throw badRequest('to must be a QQ number');
    // 晨报那边照 /node/send_image 的形状发，会多带一个 kind:'private'。
    // 只认 private：这条路就是「给主人私聊」，别让它被当成群发口子。
    if (body.kind !== undefined && body.kind !== 'private') throw badRequest('kind must be "private"');
    const owner = String((config.ownerQq ?? [])[0] ?? '');
    if (owner === '' || to !== owner) return sendJson(res, 403, { ok: false, error: 'not_owner' });
    if (typeof body.text !== 'string') throw badRequest('text must be a string');
    // 前后空白对收信人没有意义，发出去的是 trim 过的那份，长度也按它算。
    const text = body.text.trim();
    if (text.length < 1 || text.length > TEXT_MAX_CHARS) {
      throw badRequest(`text must be 1-${TEXT_MAX_CHARS} characters`);
    }
    // 复用 dispatch 里那条 send_private_msg 口径（同样的 text 段、同样的重试与拒绝判定），
    // 不在这里另拼 HTTP、也不另建连接。
    const response = await dispatch.sendChunk({ kind: 'private', userId: to }, text);
    // 节点在回合中途先开口时会把 taskId 带上：这一轮后面的罐头垫话就不用再发了。
    if (typeof body.taskId === 'string' && body.taskId !== '') dispatch.markSpoke(body.taskId);
    // 正文不进日志：审计留痕在 node-plugin 那边，这里只说发给谁、多少字。
    log.info('node/send text', { to, chars: text.length, ok: true, taskId: body.taskId ?? null });
    return sendJson(res, 200, { ok: true, messageId: response?.data?.message_id ?? null });
  }

  /**
   * 她把自己做好的文件发给主人（PPT、PDF、表格都走这条）。
   *
   * 只认主人、只在 QQ_FILE_ROOTS 里取文件：这条路能把服务器上的文件发到 QQ，
   * 不能让它变成「任意收件人 + 任意路径」的口子。软链接按 realpath 后的真实位置判。
   */
  async function handleSendFile(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    const body = await readJsonBody(req);
    if (typeof body.path !== 'string' || body.path.trim() === '') throw badRequest('path is required');
    let real;
    try {
      real = fs.realpathSync(body.path.trim());
    } catch {
      return sendJson(res, 404, { ok: false, error: 'file not found' });
    }
    const roots = Array.isArray(config.fileRoots) ? config.fileRoots : [];
    // 用 relative 判断而不是拼 '/' 前缀：分隔符跟平台走，`/tmpfoo` 也不该被当成 `/tmp` 里的。
    const allowed = roots.some((root) => {
      const rel = path.relative(root, real);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!allowed) return sendJson(res, 403, { ok: false, error: 'not_in_allowed_roots' });
    let stat;
    try {
      stat = fs.statSync(real);
    } catch {
      return sendJson(res, 404, { ok: false, error: 'file not found' });
    }
    if (!stat.isFile()) throw badRequest('file must be a regular file');
    if (stat.size === 0) throw badRequest('file is empty');
    if (stat.size > FILE_MAX_BYTES) throw badRequest(`file is larger than ${FILE_MAX_BYTES / (1024 * 1024)} MB`);
    const owner = String((config.ownerQq ?? [])[0] ?? '');
    if (owner === '') return sendJson(res, 403, { ok: false, error: 'not_owner' });
    // 名字会显示在对方的会话列表里：路径分隔符一律抹掉，长度也截断。
    const fallbackName = path.basename(real);
    const rawName = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : fallbackName;
    const name = rawName.replace(/[/\\]/g, '_').slice(0, FILE_NAME_MAX_CHARS);
    // 图片按图片发：文件卡片要下载一次才看得见，截图和图表直接显示更好。
    // 失败一律退回文件通道——base64 图片在个别 NapCat 版本上会被 1200 拒掉，
    // 那时候她至少还能把图当文件交出去，而不是两边都不知道发生了什么。
    const ext = path.extname(real).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext) && stat.size <= IMAGE_MAX_BYTES) {
      try {
        const sent = await dispatch.sendImage({ kind: 'private', userId: owner }, real);
        log.info('node/send file as inline image', { to: owner, name, bytes: stat.size });
        return sendJson(res, 200, {
          ok: true,
          name,
          bytes: stat.size,
          inline: true,
          messageId: sent?.data?.message_id ?? null,
        });
      } catch (error) {
        log.warn('inline image rejected, falling back to a file', {
          name,
          bytes: stat.size,
          reason: error?.message ?? String(error),
        });
      }
    }

    // 先记一笔再发：NapCat 拒收（retcode 1200）时，光有「request failed」看不出是哪个文件。
    log.info('node/send file attempt', { to: owner, name, bytes: stat.size });
    let response;
    try {
      response = await dispatch.sendFile({ kind: 'private', userId: owner }, real, name);
    } catch (error) {
      log.warn('node/send file rejected', { to: owner, name, bytes: stat.size, reason: error?.message ?? String(error) });
      throw error;
    }
    // 文件名进日志，内容不进。
    log.info('node/send file', { to: owner, name, bytes: stat.size, ok: true });
    return sendJson(res, 200, { ok: true, name, bytes: stat.size, fileId: response?.data?.file_id ?? null });
  }

  /**
   * 外部网关（微信之类）借她的大脑问一句：入队、等她那条 /node/result，
   * 然后把纯文本答案原路回 HTTP。
   *
   * 全程不碰 QQ：任务行带 origin:'ask' 且没有 replyTarget，dispatch 那边另有一道硬拦截。
   */
  async function handleAsk(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    if (ask === null) return sendJson(res, 404, { ok: false, error: 'ask channel is not configured' });
    // 图片/语音都以 base64 进 body：默认那 1 MiB 连一张图都装不下，所以单给这条路由放宽。
    const body = await readJsonBody(req, ASK_MAX_BODY_BYTES);

    if (typeof body.text !== 'string') throw badRequest('text is required');
    // 微信那边发纯图/纯语音时没有文字可带：只要有媒体就允许为空，
    // 纯图再补一句 [图片]，否则她收到的 prompt 是空的。
    const hasMedia = (Array.isArray(body.images) && body.images.length > 0)
      || (Array.isArray(body.audios) && body.audios.length > 0);
    let text = body.text.trim();
    if (!hasMedia && (text.length < 1 || text.length > ASK_TEXT_MAX_CHARS)) {
      throw badRequest(`text must be 1-${ASK_TEXT_MAX_CHARS} characters`);
    }
    if (text.length > ASK_TEXT_MAX_CHARS) {
      throw badRequest(`text must be 1-${ASK_TEXT_MAX_CHARS} characters`);
    }
    if (text === '' && hasMedia) {
      text = Array.isArray(body.images) && body.images.length > 0 ? '[图片]' : '';
    }
    // from 就是「谁在问」，回给她的记忆里要有个稳定的身份；没它就退化成匿名广播。
    if (typeof body.from !== 'string') throw badRequest('from is required');
    const from = body.from.trim();
    if (from.length < 1 || from.length > ASK_FROM_MAX_CHARS) {
      throw badRequest(`from must be 1-${ASK_FROM_MAX_CHARS} characters`);
    }
    const channel = body.channel === undefined ? 'api' : body.channel;
    if (!ASK_CHANNELS.includes(channel)) throw badRequest(`channel must be ${ASK_CHANNELS.map((c) => `"${c}"`).join(' or ')}`);
    // 超时上限是硬的：这条请求占着一个 HTTP 连接，等的又是一次完整的模型回合。
    let timeoutMs = DEFAULT_ASK_TIMEOUT_MS;
    if (body.timeoutMs !== undefined) {
      if (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs) || body.timeoutMs <= 0) {
        throw badRequest('timeoutMs must be a positive number');
      }
      timeoutMs = Math.min(MAX_ASK_TIMEOUT_MS, Math.round(body.timeoutMs));
    }
    // 图/语音的格式错是 400（改一改能过），数量或体积超限是 413（少发一点就能过）。
    // 这里先验一遍再入队：验不过的请求不该占着队列、也不该等她跑完一回合才知道错了。
    const images = parseAskMedia('image', body.images);
    const audios = parseAskMedia('audio', body.audios);

    // 调用方断开后这次等待就没有意义了：作废等待项，让迟到的结果走正常的丢弃分支。
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    let outcome;
    try {
      outcome = await ask.ask({ text, from, channel, timeoutMs, signal: controller.signal, images, audios });
    } finally {
      res.off('close', abort);
    }

    const taskId = outcome.row.task_id;
    if (outcome.status === 'aborted') {
      log.info('ask abandoned by caller', { taskId });
      return undefined;
    }
    if (outcome.status === 'timeout') {
      log.warn('ask timed out', { taskId, timeoutMs, channel });
      return sendJson(res, 504, { ok: false, error: 'timeout', taskId });
    }
    // 她的回合跑挂了：这不是调用方的错，也不是超时，单独给一个 502 让它能区分重试。
    if (outcome.row.result_ok !== 1) {
      log.warn('ask turn failed', { taskId, reason: outcome.row.result_error });
      return sendJson(res, 502, {
        ok: false,
        error: 'agent_failed',
        taskId,
        message: outcome.row.result_error ?? '',
      });
    }
    const answer = outcome.row.result_text ?? '';
    log.info('ask answered', { taskId, ms: outcome.ms, chars: answer.length });
    return sendJson(res, 200, { ok: true, taskId, text: answer, ms: outcome.ms });
  }

  /**
   * PC 通道的统一入口：PC 路由全是「读 body → 交给 relay → 原样回 {status, body}」，
   * 差异只在 HTTP 方法和 relay 上那个方法名。relay 自己判入参、自己决定 200 还是 400，
   * HTTP 这层只负责搬 body、搬回复、以及把「客户端走了」告诉它。
   */
  async function handlePc(pathname, req, res) {
    const spec = PC_ROUTES.get(pathname);
    if (spec === undefined) return sendJson(res, 404, { ok: false, error: 'not found' });
    if (req.method !== spec.method) return methodNotAllowed(res, [spec.method]);
    if (pcRelay === null) return sendJson(res, 404, { ok: false, error: 'pc channel is not configured' });
    const body = spec.method === 'GET' ? {} : await readJsonBody(req, pcBodyLimit);
    // 等待方断开（node-plugin 超时 / 客户端关闭）时，正在排队的命令必须作废，
    // 否则 pc-agent 会捡到一条没人在等的命令并白跑一遍。'close' 是唯一可靠的信号。
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const reply = await pcRelay[spec.name](body, { signal: controller.signal });
      return sendJson(res, reply.status, reply.body);
    } finally {
      res.off('close', abort);
    }
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname === '/health') return handleHealth(req, res);

    const needsAuth = pathname.startsWith('/node/') || pathname.startsWith('/blob/');
    if (!needsAuth) return sendJson(res, 404, { ok: false, error: 'not found' });
    if (!authorized(req, config.nodeToken)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

    if (pathname.startsWith('/node/pc/')) return handlePc(pathname, req, res);
    if (pathname === '/node/poll') return handlePoll(req, res, url.searchParams);
    if (pathname === '/node/send_image') return handleSendImage(req, res);
    if (pathname === '/node/send_file') return handleSendFile(req, res);
    if (pathname === '/node/remind') return handleRemind(req, res);
    if (pathname === '/node/send') return handleSendText(req, res);
    if (pathname === '/node/status') return handleStatus(req, res);
    if (pathname === '/node/result') return handleResult(req, res);
    if (pathname === '/node/ask') return handleAsk(req, res);
    if (pathname.startsWith('/blob/')) {
      let blobId = pathname.slice('/blob/'.length);
      try {
        blobId = decodeURIComponent(blobId);
      } catch {
        throw badRequest('blobId is not valid percent-encoding');
      }
      return handleBlob(req, res, blobId);
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => route(req, res))
      .catch((error) => {
        // ask.js 自己带着 status 抛（图/语音的 400/413），和 HttpError 一样按它落码。
        const status = error instanceof HttpError || error instanceof AskMediaError ? error.status : 500;
        if (status >= 500) log.error('request failed', { method: req.method, path: req.url, reason: error.message });
        else log.warn('request rejected', { method: req.method, path: req.url, status, reason: error.message });
        sendJson(res, status, { ok: false, error: status >= 500 ? 'internal error' : error.message });
      });
  });

  return server;
}
