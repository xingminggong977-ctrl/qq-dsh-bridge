# dsh-qq-bridge

NapCat(OneBot 11) ⇄ SQLite 队列 ⇄ 本机 DSH node 的云端桥接服务。协议契约见 `../PROTOCOL.md`，
本实现不增删任何字段或端点。

零运行时依赖（`dependencies: {}`），只用 Node 24 内建能力：`node:http`、`node:sqlite`（`DatabaseSync`）、
`node:crypto`、`node:fs`、全局 `WebSocket`（客户端）与 `fetch`。

## 运行

```bash
node bin/bridge.js          # 或 npm start
node --test test/           # 或 npm test
```

配置全部来自环境变量，不读配置文件、不新增变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_TOKEN` | 必填 | `/node/*`、`/blob/*` 的 Bearer token；缺失即启动失败 |
| `NAPCAT_WS_URL` | `ws://127.0.0.1:3001` | NapCat 的 OneBot 11 正向 WS 地址（bridge 是客户端） |
| `NAPCAT_ACCESS_TOKEN` | 空 | 连 NapCat 时作为 `Authorization: Bearer` 头发送 |
| `BRIDGE_HOST` | `127.0.0.1` | 只绑回环；`0.0.0.0` 等通配地址启动即退出 |
| `BRIDGE_PORT` | `8787` | |
| `OWNER_QQ` | 空 | 逗号分隔，匹配的 userId 在 Task 里 `isOwner: true` |
| `BACKLOG_TTL_MS` | `1800000` | 队列存活上限，超时丢弃并发固定文案 |
| `INBOUND_SILENT_MS` | `180000` | WebSocket 连着却不来任何帧超过这么久，就给主人发一句「我这边好像收不到消息了」。NapCat 每 30 秒推一次心跳，正常聊天碰不到这个阈值 |
| `DB_PATH` | `/var/lib/dsh-qq-bridge/queue.db` | |
| `BLOB_DIR` | `/var/lib/dsh-qq-bridge/blobs` | 图片落盘目录 |
| `QQ_FILE_ROOTS` | `/var/lib/dsh-qq-agent/workspace` | `/node/send_file` 肯打开哪些目录（分隔符跟平台走）。默认**不含 `/tmp``：线上单元开了 `PrivateTmp=yes`，服务眼里的 `/tmp` 是它自己的私有目录（2026-11-02 自检得到 `404 file not found`）。这是那条路由的全部安全性：路径先 `realpath` 再按前缀判，`/etc/shadow` 发不出去 |
| `PROACTIVE_ENABLED` | `on` | `off` 一次关掉「主动开口」 |
| `PROACTIVE_MAX_PER_DAY` | `30` | 主动发出的条数上限（线上现设 **4**） |
| `PROACTIVE_SPREAD_OVER_DAY` | `on` | 额度按时间摊开：到 25% 的钟点最多 1 条、50% 最多 2 条……否则早上就能把一天的说完，晚上一句没有 |
| `PROACTIVE_MAX_ASKS_PER_DAY` | `8` | 询问次数上限（问了没话也算钱，线上现设 4） |
| `PROACTIVE_MIN_GAP_MS` | `5400000` | 两次询问的最小间隔（线上现设 3 小时） |
| `PROACTIVE_REQUIRE_ACTIVITY` | `on` | 只有「上次问过之后有新素材」才再问；世界里的新鲜事也算素材 |
| `PROACTIVE_QUIET_FROM` / `_TO` | `23` / `8` | 安静时段（服务器本地时区），跨零点 |
| `WORLD_LIFE_ENABLED` | `on` | 她的世界事件（`life-feed.jsonl`）能不能当开口由头 |
| `WORLD_LIFE_MAX_PER_DAY` | `2` | 一天最多几次「拿特别的事当由头」开口 |
| `WORLD_LIFE_WINDOW_HOURS` | `6` | 只在几小时内发生的事才算新鲜 |
| `WORLD_LIFE_FILE` | `/opt/whale-craft/life-feed.jsonl` | 事件流路径（由 whale-craft 侧写，bridge 只读） |
| `WORLD_LIFE_STATE` | `/var/lib/dsh-qq-bridge/world-life.json` | 已说过哪些事件的去重状态 |

日志为 JSON 行（stdout），`NODE_TOKEN`/`NAPCAT_ACCESS_TOKEN` 与 `Bearer …`、`access_token=…` 一律打码。

## 模块

| 文件 | 职责 |
| --- | --- |
| `bin/bridge.js` | 入口：读 env、建服务、优雅退出 |
| `src/config.js` | env 解析与校验（含通配 host 拒绝） |
| `src/onebot.js` | OneBot 11 WS 客户端：握手鉴权、事件解析、action 调用、指数退避重连 |
| `src/dispatch.js` | 事件 → 入队（群需 @、私聊直通、限流）、结果 → 分段回发、过期文案 |
| `src/queue.js` | SQLite 任务状态机：queued/delivering/running/done/failed/expired，租约重投 |
| `src/ratelimit.js` | 每用户 6 次/分钟，提示 5 分钟一次 |
| `src/blobs.js` | 图片下载（http/base64/file/绝对路径）与 blob 取回 |
| `src/asr.js` | 语音转写：`get_record` 取 mp3 → 本地 faster-whisper venv → 文本 |
| `src/http.js` | `/health`、`/node/poll`（长轮询）、`/node/status`、`/node/result`、`/node/ask`、`/node/send`（发一句话；带 `taskId` 时顺手把这一轮的罐头垫话停掉）、`/node/send_image`、`/node/send_file`（把她做好的文件发给主人，只认主人 + `QQ_FILE_ROOTS`）、`/node/remind`、`/blob/<id>` |
| `src/watchdog.js` | 入站静默监视：心跳停了超过 `INBOUND_SILENT_MS`（默认 180 秒）就替她喊一句「我这边好像收不到消息了」，只喊一次 |
| `src/ask.js` | `/node/ask` 的等待台：谁在等哪个 taskId 的答案，超时与迟到结果的丢弃 |
| `src/proactive.js` | 主动开口的闸门：安静时段 / 日额度 / 间隔 / 素材（主人说话、任务跑完、她世界里的新鲜事都算素材） |
| `src/world-life.js` | 读她的世界事件流、挑没说过又够新鲜的几条、渲染成一段由头；读不到就当没有，绝不影响开口本身 |
| `src/db.js` `src/log.js` `src/notifier.js` | 建表与 WAL、打码日志、长轮询唤醒 |

`test/` 全部使用假 NapCat WS 服务端桩与假 node HTTP 客户端，不依赖真实 NapCat。

- `test/index.js` 只是聚合入口：Node 24 把 `--test` 的位置参数当 glob，`node --test test/` 会落到
  目录本身，靠 index 解析才能加载全部用例；`node --test test/*.test.js` 亦可。

## 慢回合里的垫话

一个回合最长可以跑 240 秒，中间一声不响，对面会以为消息丢了。所以跑过 `SLOW_ACK_MS`（默认 22 秒）
先垫一句，`SLOW_LATE_MS`（90 秒）与 `SLOW_DEEP_MS`（180 秒）再各补一句。

垫的话要分开说：任务还停在 `queued` / `delivering`（node 那一侧在等并发槽，线上最长等过 187 秒）
说明她连想都还没开始想，这时说「在呢，我想一下」是把排队装成思考，得说「前面那条我还在弄」；
只有真到 `running` 才是「我想一下」。四组文案都在 `timing.slow*Text` 里，可逐句改。

她自己在回合中途开口（`/node/send` 带 `taskId`）之后，剩下的罐头话一律不发——刚说完一句真话，
90 秒再补「还在弄」只会显得吵。

## 排队的顺序：主人的私聊先走

她一次只能跑 `maxConcurrentTurns` 个回合（线上是 2）。群聊热闹的下午，一次取任务如果按到达时间
排队，他发的「在吗」要等群里那七条走完——线上量到过 187 秒、604 秒的等待，几乎全是这么来的。

所以 `queue.claim()` 的顺序是：**主人私聊（`is_owner = 1` 且 `kind = 'private'`）→ 其它（群聊）
→ 主动搭话（`proactive = 1`）**，同一档内仍按 `received_at`、`rowid` 先来先走。主动搭话排最后
是有意的：那是她找话题，不该挡着真实的消息。

## 提醒 `/node/remind`

一条提醒是一行 `reminders`（`at_ms` / `text` / `target` / `fired_at`），由 `src/reminders.js` 的
`createReminderStore` + `createReminderTicker`（15 秒一跳）负责到点推送——不依赖她那一轮还活着。

**同一句话、同一个时间（±5 分钟）、同一个收件人，只存一条。** 第二遍不报错，返回已有那条的
`reminderId` 并带 `duplicate: true`，插件那边就把话改成「这条本来就定着了」。加这条是因为线上
真发生过：11-01 晚上排过一条「七点了，记得给爸爸打个电话」，第二天早上 11:00 她又不放心地排了
一遍，两条都 `pending`，到点他会收到两遍同样的话。

另外两条边界写在 `add()` 里：时间必须比现在晚 1 秒以上、不能超过 30 天；`due()` 会把迟到超过
30 分钟的行直接判死（重启之后不把三天前的提醒砸过去）。

## 回合挂了要说话

私聊里一个回合彻底失败、又一个字都没有时，沉默比一句坏消息更糟，所以桥会补一句。补哪句取决于
**她停下的方式**：`result_error` 是 `turn timeout` 或 `tool budget`（撞时间墙 / 用完一个回合的工具
预算）时，说的是「这事儿比我想的费时间，我先停在这儿了。你说句「继续」，我接着弄。」；其它错误
（模型连不上、进程崩）才是「我这边卡了一下，你再说一次好吗？」。

这两种情况都不是「卡了」——她已经干到一半了，让她从头再说一遍是最坏的回答。群里、`ask` 任务、
不是 `needs_reply` 的消息都不会收到这句。

### 空回复也别发出去

`text !== ''` 挡不住「全是空白字符」：2026-11-01 16:08 的那次就是这样，一串看不见的字符被送出去，
NapCat 用 `retcode=1200` 拒发，对面只看到十几秒的沉默。现在发送前先 `trim()` 判空：

| 情况 | 结果 |
|---|---|
| 去掉空白后为空，且这轮**该回话**（`needs_reply` + 主人私聊） | 改发一句「我在，你说。」，日志 `empty reply replaced with a fallback line` |
| 去掉空白后为空，但没人要回答（群里的上下文消息、主动搭话自己收回） | 什么都不发，也不记 `task finished` 的分段数 |

### 这些时间点能不能改

垫话、兜底、收尾都读同一个 `timing` 对象（`createApp({ timing })` 传进来，与 `DEFAULT_TIMING` 合并），
所以不用改代码就能调：

| 键 | 默认 | 什么时候说话 |
|---|---|---|
| `slowAckMs` / `slowAckText` | `22000` / 「在呢，我想一下。」 | 任务还在跑，22 秒没动静 |
| `slowLateMs` / `slowLateText` | `90000` / 「还在弄，别急，一会儿就说。」 | 90 秒 |
| `slowDeepMs` / `slowDeepText` | `180000` / 「这条比平时长，我还在弄。」 | 180 秒 |
| `slowQueuedText` / `slowQueuedLateText` / `slowQueuedDeepText` | 见 `dispatch.js` | 同上三档，但任务是 `queued`/`delivering`（在等并发槽，不是在想） |
| `slowTimeoutText` | 「这事儿比我想的费时间，我先停在这儿了。你说句「继续」，我接着弄。」 | 撞上 `turn timeout` 或 `tool budget` |
| `slowFailureText` | 「我这边卡了一下，你再说一次好吗？」 | 真的挂了，且不是上面两种 |
| `emptyReplyText` | 「我在，你说。」 | 去掉空白后正文为空，且这轮该回话 |
| `segmentChars` / `segmentDelayMs` | `1800` / `300` | 长回复怎么切段、段间停多久 |
## 发文件 `/node/send_file`

她做好的东西（PPT、PDF、表格、压缩包）从这条路交给主人：

```
POST /node/send_file      Authorization: Bearer $NODE_TOKEN
{ "path": "/var/lib/dsh-qq-agent/workspace/汇报.pptx", "name": "汇报.pptx" }
→ { "ok": true, "name": "汇报.pptx", "bytes": 5242880, "fileId": "…" }
```

- **只发给主人**：收件人由 `OWNER_QQ` 的第一个决定，请求里没有 `to`，也就没有「发给别人」这条路。
- **只打开 `QQ_FILE_ROOTS` 里的文件**：`path` 先 `realpath`（软链接按真实位置判），再按目录前缀放行，
  所以 `/etc/shadow`、`/root/.ssh/id_ed25519` 一律 403 `not_in_allowed_roots`。
  默认 `/var/lib/dsh-qq-agent/workspace:/tmp`——她自己写的东西都在工作区。
- **内容走 base64**：NapCat 在另一台机器上，传路径过去那边只会说「文件不存在」（语音那 65 次 `retcode=1200` 就是这么来的）。
  上限 20 MB（base64 之后约 27 MB 上 WebSocket）。
- 文件名里的路径分隔符一律抹成 `_`，长度截到 100：它要显示在对方的会话列表里，不能让它看起来像去别的地方。
- **图片按图片发**：`.png/.jpg/.jpeg/.gif/.webp/.bmp` 且 ≤ 10 MB 时走 `send_private_msg` 的 `image` 段，
  会话里直接看得见（文件卡片要下载一次才打开）。这条一旦被 NapCat 拒（个别版本对 base64 图片会回 1200），
  自动退回 `upload_private_file`——宁可对方多下载一次，也不能什么都不发。
  返回体里 `inline: true` 表示它是图片段发的。

## 一条消息里她到底看得见什么

入站的每个段都会变成她读得到的文字，看不见的段也不能变成空字符串——空字符串在她那边就是
「他刚才好像发了什么，可是什么都没有」，线上他真的发过两条，她只能回「消息是空的，是手滑了
吗」，连问两遍。

| 段 | 她看到的 |
| --- | --- |
| `text` / `at` / `reply` | 原文；@ 直接剥掉，引用不留占位 |
| `image` / `mface` / `marketface`（有 URL 或 file） | 图片本体进 `images`，她自己看图 |
| `mface`（只有 emoji_id，取不到字节） | `[表情包]`，同时把原始段交给 `onSticker` 探针 |
| `face` / `sface` | `[微笑]`、`[流泪]`…（`src/faces.js` 的 105 个经典脸；表里没有就 `[表情#147]`） |
| `record` / `video` | `[语音]` + 转写正文（见下）、`[视频]` |
| `json` / `xml` | `[卡片消息]` |
| `forward` / `file` / `share` / `music` / `poke` / `dice` / `rps` | `[合并转发]` `[文件]` `[链接分享]` `[音乐分享]` `[戳一戳]` `[骰子]` `[猜拳]` |
| 完全没见过的类型 | `[类型名]`，宁可让她看见一个陌生的词，也别让她以为自己收了个空包 |

## 语音消息

QQ 语音是 SILK，ffmpeg 解不了；`get_record` 让 NapCat 自己转成 mp3，再由 `scripts/transcribe.py`
喂给 `/opt/asr-venv` 里的 faster-whisper（small / CPU / int8，模型在 `/opt/asr-models`）。
转写在 **bridge 内**完成，结果直接拼回 `text`（`[语音] 今天天气不错`）——Task 结构和协议都不用改。

三个 env 全为空即**整条链路关闭**，语音只剩 `[语音]` 标记：

| 变量 | 说明 |
| --- | --- |
| `ASR_PYTHON` | 装了 faster-whisper 的解释器，如 `/opt/asr-venv/bin/python` |
| `ASR_SCRIPT` | `scripts/transcribe.py` 的绝对路径 |
| `ASR_MODEL_DIR` | 模型目录，默认 `/opt/asr-models` |
| `ASR_TIMEOUT_MS` | 单条超时，默认 30000 |

任何失败（取不到音频、引擎崩、超时、超过 8 MB）都返回空串并只 warn 一次：
**听不懂也不能丢消息**。

## 问答 `/node/ask`（文字 / 图片 / 语音）

外部网关（微信之类）借她的大脑答一句话，答案直接回 HTTP，**完全不碰 QQ 投递**。

```
POST /node/ask            Authorization: Bearer $NODE_TOKEN
{"text":"在吗，用一句话回我","from":"wechat:wxid_xxx","channel":"wechat","timeoutMs":60000}

200 {"ok":true,"taskId":"…","text":"在呀，我在呢。","ms":2647}
504 {"ok":false,"error":"timeout","taskId":"…"}
502 {"ok":false,"error":"agent_failed","taskId":"…","message":"…"}
400 {"ok":false,"error":"images[0].mime must be one of image/jpeg, image/png, image/webp, image/gif"}
413 {"ok":false,"error":"images[0] is larger than 6291456 bytes"}
```

带图带语音的同一句话：

```
{"text":"这是啥","from":"wechat:wxid_xxx","channel":"wechat",
 "images":[{"mime":"image/jpeg","dataBase64":"/9j/4AAQ…"}],
 "audios":[{"mime":"audio/silk","dataBase64":"…"}]}
```

| 字段 | 规则 |
| --- | --- |
| `text` | 1–4000 字，仍必填；语音转出的字会补在它**前面** |
| `from` | ≤64，就是她在记忆里看到的那个身份 |
| `channel` | `wechat` / `api`，默认 `api` |
| `timeoutMs` | 默认 60000，上限 120000 |
| `images` | 最多 **4** 张；每张解码后 ≤ **6 MiB**；`mime` 只收 `image/jpeg`/`image/png`/`image/webp`/`image/gif` |
| `audios` | 最多 **2** 条；每条 ≤ **8 MiB**；`mime` 不限（silk/mp3/amr/wav 都行） |

`dataBase64` 是裸 base64，也容忍整串 `data:image/png;base64,…`。图片经 blob 落盘，任务里带
`{blobId,mime,bytes}`，网关可以 `GET /blob/<id>` 取回原件；语音在入队**之前**转写成 `[语音] …`
逐行放在 `text` 前面——没配 ASR 或转写失败就降级成 `[语音（没听清）]` 并 warn 一次，
**绝不因为一条语音听不清就让整次问答失败**。格式错 400，超数量/超体积 413，无 token 401。

任务照旧入队、照旧由 node-plugin 轮询取走、照旧 POST `/node/result`。区别只有一处：这一行带
`origin:'ask'`，于是 `rowToTask` 多给一个 `deliver:false`，而 `dispatch.deliverResult` 见到
`origin:'ask'` 直接收摊——**少发一条可以补，错发一条到别人 QQ 上收不回来**。QQ 入站那一侧一个字都没变。

同一个 taskId 只兑现一次；超时之后迟到的结果返回 `{"ok":true,"dropped":true}` 并丢弃，不抛异常、不写别处。
等待表在内存里：桥重启就等于没人等了，和 PC 通道是同一个取舍。
