/**
 * 主动开口：没有新消息的时候，隔一会儿问她一句「有没有想跟他说的」。
 *
 * 闸门分开算，因为它们防的是不同的事：
 * - **日额度**按「真的发出去了几条」算。她回 NONE 表示没话可说，一条也没发出去，
 *   不该吃掉当天的额度。
 * - **询问额度**与**最小间隔**按「问过几次」算。一次没说话的询问也烧 token，那是钱的问题。
 * - **新素材**：上次问过之后主人说了话、有任务真的跑完、或者世界那边刚发生了特别的事，
 *   才值得再问一次。世界事件从不进 tasks 表，所以这一条必须自己去问 `world-life.js`——
 *   只看「主人说过话」会把「她自己盖好房子、死了一次，主人一声不吭」整类场景挡在门外。
 *   线上第一版没有这把闸门，13 次询问里 9 次跑完只回 NONE，每一轮都在重发整段上下文。
 *
 * 安静时段用的是服务器本地时区（线上是 Asia/Shanghai），别在人家睡觉时敲窗户。
 *
 * 世界生活线（`world-life.js`）不是另一条开口的路，只是这一条路上的**由头**：
 * 有新鲜事时，这件事被塞进那条 proactive 任务的 `proactiveCue` 字段，让那一轮知道
 * 「你刚在世界里做了什么，可以提一句」；没有新鲜事，行为和以前一模一样。
 * 所以静默时段、发送/询问上限、间隔、素材四道闸门一个都没绕过，`text` 也仍然是空串。
 */
export const PROACTIVE_DEFAULTS = Object.freeze({
  enabled: true,
  maxPerDay: 30,
  maxAsksPerDay: 8,
  minGapMs: 90 * 60 * 1000,
  requireActivitySinceLastAsk: true,
  // 额度按时间摊开：不摊的话，13 点就能把全天的额度发完，之后整个晚上都是哑的。
  spreadOverDay: true,
  quietFrom: 23,
  quietTo: 8,
  tickMs: 60 * 1000,
});

/** `reason()` 的取值集合。日志、测试、运维脚本都按这些字符串认，不要改名。 */
export const PROACTIVE_REASONS = Object.freeze([
  'ok',
  'disabled',
  'no-owner',
  'quiet',
  'quota',
  'asked-quota',
  'gap',
  'no-activity',
]);

/** 当天零点（服务器本地时区）的时间戳。 */
export function startOfDay(at) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 安静时段可以跨零点（23 -> 8），from === to 视为没有安静时段。 */
export function inQuietHours(at, from, to) {
  if (from === to) return false;
  const hour = new Date(at).getHours();
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * 到此刻为止「按时间该放行几条」：把全天的额度摊在 24 小时上，最少 1 条。
 *
 * 一天的额度是 4 条时，不摊开就意味着早上能连着发完、晚上一句没有——而晚上才是他
 * 真在的时候。摊开之后 08:00 最多 2 条、18:00 最多 3 条、睡前才是 4 条。
 * @param at - 判定时刻（服务器本地时区）。
 * @param maxPerDay - 全天额度。
 */
export function paceLimit(at, maxPerDay) {
  if (!(maxPerDay > 0)) return 0;
  const elapsed = at - startOfDay(at);
  const fraction = elapsed <= 0 ? 0 : Math.min(1, elapsed / (24 * 60 * 60 * 1000));
  return Math.max(1, Math.min(maxPerDay, Math.ceil(fraction * maxPerDay)));
}

/**
 * @param config - the resolved bridge config（读 `ownerQq` 与 `proactive`）。
 * @param queue - the task queue（读当天已发条数、当天询问次数、上次询问时间、上次询问后的新素材）。
 * @param worldLife - 可选：`world-life.js` 的读取器。不给就是没有由头，行为和以前一样。
 * @returns `reason()` 说明现在为什么能问或不能问，`ask()` 在允许时真的入队。
 */
export function createProactivePlanner({ config, queue, now = () => Date.now(), log = () => {}, worldLife = null }) {
  const settings = { ...PROACTIVE_DEFAULTS, ...(config?.proactive ?? {}) };
  const owner = String((config?.ownerQq ?? [])[0] ?? '');

  const sentToday = (at = now()) => queue.countProactiveSent(startOfDay(at));
  const asksToday = (at = now()) => queue.countProactiveAsks(startOfDay(at));

  /**
   * 世界那边还没说过的特别的事。只看不落盘：evaluate() 必须能反复调用而不吃掉由头。
   * 判定与 `takeCue()` 共用它，否则两边条件一分开，就会出现「判定说有素材、takeCue 说没有」，
   * ask() 于是入队一条既没人说话也没有由头的询问——那正是这条闸门要防的空转。
   */
  const freshEvents = (at) => {
    if (worldLife === null || worldLife.enabled !== true) return [];
    if (queue.countWorldLifeCues(startOfDay(at)) >= worldLife.settings.maxPerDay) return [];
    return worldLife.pickFresh(at);
  };

  // 一次判定同时给出结论和人话：日志要说的数字必须和闸门用的是同一批查询，否则两边会各说各话。
  const evaluate = (at = now()) => {
    if (!settings.enabled) return { reason: 'disabled', detail: '主动开口已关闭' };
    if (owner === '') return { reason: 'no-owner', detail: '没有配置主人 QQ' };
    if (inQuietHours(at, settings.quietFrom, settings.quietTo)) {
      return {
        reason: 'quiet',
        detail: `现在 ${new Date(at).getHours()} 点，安静时段 ${settings.quietFrom}:00-${settings.quietTo}:00`,
      };
    }
    const sent = sentToday(at);
    if (sent >= settings.maxPerDay) {
      return { reason: 'quota', detail: `今天已发 ${sent} / 上限 ${settings.maxPerDay} 条` };
    }
    // 额度按时间摊开：不摊的话早上就能把一天的说满（线上 13:33 就已经 4/4），
    // 之后到睡觉前一句都没有。reason 仍是 `quota`，只是 detail 说了为什么现在不行。
    const paced = settings.spreadOverDay === true ? paceLimit(at, settings.maxPerDay) : settings.maxPerDay;
    if (sent >= paced) {
      return {
        reason: 'quota',
        detail: `今天已发 ${sent} 条，按时间这会儿最多 ${paced} 条（全天上限 ${settings.maxPerDay}）；留着晚上说`,
      };
    }
    const asks = asksToday(at);
    // 询问额度先于间隔：额度用尽是当天不会自己好的事，报它比报「刚问过」更接近真相。
    if (asks >= settings.maxAsksPerDay) {
      return { reason: 'asked-quota', detail: `今天已问 ${asks} / 上限 ${settings.maxAsksPerDay}` };
    }
    const last = queue.lastProactiveAt();
    // 间隔先于素材：刚问完就再说一次，缺的是时间；隔够久了没人说话，缺的才是素材。
    if (last !== null && at - last < settings.minGapMs) {
      const waitMin = Math.max(1, Math.ceil((settings.minGapMs - (at - last)) / 60000));
      return { reason: 'gap', detail: `距上次询问还有 ${waitMin} 分钟才能再问` };
    }
    // 从没问过就没有「上次之后」这个窗口，第一次开口不该被这条闸门卡住。
    if (settings.requireActivitySinceLastAsk && last !== null && !queue.hasActivitySince(last)) {
      // 世界里她自己干成的事也算素材。世界事件从不进 tasks 表，只看 hasActivitySince 会把
      // 「她盖好房子、死了一次，主人一声不吭」这整类最该开口的场景挡在门外。
      const events = freshEvents(at);
      if (events.length === 0) {
        return { reason: 'no-activity', detail: `距上次询问 ${Math.floor((at - last) / 60000)} 分钟，之后没有新素材` };
      }
      // 人话要能看出这一轮凭什么是 ok：主人在说话，还是只有世界那边发生了事。
      return {
        reason: 'ok',
        detail: `距上次询问 ${Math.floor((at - last) / 60000)} 分钟，之后只有世界里的 ${events.length} 件事`,
      };
    }
    return { reason: 'ok', detail: '可以问' };
  };

  /** 能不能问：只会是 `PROACTIVE_REASONS` 里的一个值，测试和运维脚本按它认。 */
  const reason = (at = now()) => evaluate(at).reason;

  /** 同一套判定的人话版，写日志用。 */
  const describeReason = (at = now()) => evaluate(at).detail;

  /**
   * 世界那边的由头：只用「刚发生、还没说过」的特别的事。
   * 上限数的是任务表里今天已经带过由头的开口——所以它跨重启有效，
   * 也不会因为读取器状态文件写失败而失效（那一侧只会退化成重说一次）。
   * @returns `{ events, text }`，或 `null`（没有由头，按老样子开口）。
   */
  const takeCue = (at) => {
    const events = freshEvents(at);
    if (events.length === 0) return null;
    return { events, text: worldLife.render(events) };
  };

  const ask = (at = now()) => {
    const why = reason(at);
    if (why !== 'ok') return { asked: false, reason: why, taskId: null };
    const cue = takeCue(at);
    const row = queue.insertTask({
      kind: 'private',
      userId: owner,
      nickname: '',
      // An empty text is the signal "nobody said anything": the node turns it into
      // an impulse prompt, never into a fake user message.
      text: '',
      images: [],
      isOwner: true,
      replyTarget: { kind: 'private', userId: owner },
      proactive: true,
      // 由头走独立字段：`text` 必须继续为空，否则她会以为主人说过话（那是这个字段
      // 存在的全部理由）。旧 node 不认识它，看到的就是一条没有由头的主动开口。
      ...(cue === null ? {} : { proactiveCue: cue.text }),
    });
    // 入队成功才算「用过了」：插入抛错时那几条事件还留着，下一次 tick 还有机会用。
    if (cue !== null) worldLife.markSpoken(cue.events);
    log.info('proactive ask queued', {
      taskId: row.task_id,
      sentToday: sentToday(at),
      asksToday: asksToday(at),
      ...(cue === null ? {} : { worldLife: cue.events.length }),
    });
    return { asked: true, reason: 'ok', taskId: row.task_id };
  };

  return { settings, owner, reason, describeReason, ask, sentToday, asksToday };
}
/**
 * 「为什么没问」的日志：只在闸门取值变化时打一行。
 *
 * 每 60 秒 tick 一次，值不变还打等于把日志变成噪声；但值变了必须留痕，否则部署后看不出闸门究竟有没有生效。
 * 上一次的取值放在闭包里，watcher 是新建的：进程重启后第一次 tick 必然有一行，不会沿用上一次的记忆。
 */
export function createReasonWatcher({ planner, log = {}, now = () => Date.now() }) {
  let last = null;
  return function watch() {
    const at = now();
    const why = planner.reason(at);
    if (why === last) return why;
    const previous = last;
    last = why;
    // ok 不打「skipped」：真正入队时 `ask()` 已经有一条 info。特意只在「从别的值切回来」时留一行，
    // 开头就 ok 的那种静默——那时没有任何被挡下的询问值得解释。
    if (why === 'ok' && previous === null) return why;
    log.info?.(why === 'ok' ? 'proactive resumed' : 'proactive skipped', {
      reason: why,
      detail: planner.describeReason(at),
    });
    return why;
  };
}
