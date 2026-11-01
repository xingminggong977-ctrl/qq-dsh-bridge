import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 合成失败就把话用文字发出去，永远不能因为「说不出声」而丢一条回复。 */
export const TTS_DEFAULTS = Object.freeze({
  enabled: false,
  python: '',
  script: '',
  provider: 'edge',
  apiKey: '',
  model: 'cosyvoice-v2',
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+8%',
  pitch: '+0Hz',
  speechRate: 1,
  pitchRate: 1,
  instruction: '',
  maxChars: 60,
  dailyMax: 20,
  outDir: '/var/lib/dsh-qq-bridge/tts',
  timeoutMs: 20_000,
})

/** 多久清一次旧音频：留着没用，磁盘却是有限的。 */
const KEEP_MS = 6 * 60 * 60 * 1000

/**
 * 她说的话是写给人看的，不是念给人听的。
 * 把 Markdown、链接、表情从「要说的话」里拿掉——念出「星号星号」是最重的机器味。
 * 代码整段丢掉：念代码没有意义，丢干净之后如果什么都不剩，就老实打字。
 */
const SPEECH_RULES = [
  [/```[\s\S]*?```/gu, ''],
  [/`([^`]*)`/gu, '$1'],
  [/!\[[^\]]*\]\([^)]*\)/gu, ''],
  [/\[([^\]]*)\]\([^)]*\)/gu, '$1'],
  [/https?:\/\/\S+/gu, '链接'],
  [/^\s*#{1,6}\s*/gmu, ''],
  [/^\s*>\s?/gmu, ''],
  [/^\s*(?:[-*•]|\d+[.)])\s+/gmu, ''],
  [/(\*\*|__|\*|_|~~)/gu, ''],
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ''],
]

export function prepareSpeech(text) {
  if (typeof text !== 'string') return ''
  let out = text
  for (const [pattern, replacement] of SPEECH_RULES) out = out.replace(pattern, replacement)
  out = out.replace(/[ \t]+/gu, ' ')
  out = out.replace(/\s*\n+\s*/gu, '，')
  out = out.replace(/，{2,}/gu, '，')
  out = out.replace(/^[，、\s]+|[，、\s]+$/gu, '')
  if (out === '') return ''
  if (!/[。！？…～~,，、;；:：]$/u.test(out)) out += '。'
  return out
}

/**
 * 两条合成路线的参数表。
 *
 * edge：`say.py <out> <voice> <rate> <pitch>`，rate/pitch 是 "+8%" 这种字符串。
 * dashscope：`say-cosyvoice.py <out> <voice> <model> <speechRate> <pitchRate> <instruction>`，
 * 语速音高是倍率；第 6 个参数是风格指令（空字符串＝不加指令，v1/v2 忽略它）；
 * key 通过环境变量传，绝不进 argv（ps 里能看见）。
 */
function spawnArgs({ provider, script, out, voice, rate, pitch, model, speechRate, pitchRate, instruction }) {
  if (provider === 'dashscope') {
    return [script, out, voice, model, String(speechRate), String(pitchRate), instruction ?? '']
  }
  return [script, out, voice, rate, pitch]
}

/** 给测试用：两条路线的 argv 是契约，写错了只会在线上听着不对。 */
export function buildSayArgs(job) {
  return spawnArgs(job)
}

/** 复刻音色的 key 只走环境变量：argv 在 ps 里是全机器可见的。 */
export function buildSayEnv({ provider, apiKey }) {
  return provider === 'dashscope' ? { ...process.env, DASHSCOPE_API_KEY: apiKey } : undefined
}

function spawnSay({ python, script, voice, rate, pitch, out, text, timeoutMs, provider, model, speechRate, pitchRate, instruction, apiKey }) {
  const args = spawnArgs({ provider, script, out, voice, rate, pitch, model, speechRate, pitchRate, instruction })
  const env = buildSayEnv({ provider, apiKey })
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`tts timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${script.split('/').pop()} exited ${code}: ${stderr.trim().slice(0, 300)}`))
    })
    child.stdin.end(text, 'utf8')
  })
}

/**
 * 把 config.tts 摊成 createSynthesizer 的参数。
 *
 * 存在的理由很具体：这一层曾经漏传 pitch，于是 env 里写着 -5Hz、自检听着对，
 * 生产却仍是 +0Hz —— 合成没报错，声音只是不对。参数表写在一处，才不会漏。
 */
export function synthesizerOptions(config = {}) {
  const tts = config.tts ?? {}
  return {
    python: tts.enabled === true ? tts.python : '',
    script: tts.script ?? '',
    provider: tts.provider ?? TTS_DEFAULTS.provider,
    apiKey: tts.apiKey ?? '',
    model: tts.model ?? TTS_DEFAULTS.model,
    voice: tts.voice,
    rate: tts.rate,
    pitch: tts.pitch,
    speechRate: tts.speechRate ?? TTS_DEFAULTS.speechRate,
    pitchRate: tts.pitchRate ?? TTS_DEFAULTS.pitchRate,
    instruction: tts.instruction ?? TTS_DEFAULTS.instruction,
    outDir: tts.outDir,
    timeoutMs: tts.timeoutMs,
  }
}

/**
 * 把文字变成一条语音。
 *
 * 任何失败都返回 null 而不是抛：说话是锦上添花，丢回复才是事故。
 */
export function createSynthesizer({
  python,
  script,
  provider = TTS_DEFAULTS.provider,
  apiKey = TTS_DEFAULTS.apiKey,
  model = TTS_DEFAULTS.model,
  voice = TTS_DEFAULTS.voice,
  rate = TTS_DEFAULTS.rate,
  pitch = TTS_DEFAULTS.pitch,
  speechRate = TTS_DEFAULTS.speechRate,
  pitchRate = TTS_DEFAULTS.pitchRate,
  instruction = TTS_DEFAULTS.instruction,
  outDir = TTS_DEFAULTS.outDir,
  timeoutMs = TTS_DEFAULTS.timeoutMs,
  log = () => {},
  now = Date.now,
  run = spawnSay,
} = {}) {
  const hasScript = typeof python === 'string' && python !== '' && typeof script === 'string' && script !== ''
  // dashscope 没 key 就等于没接通：这时候宁可退回打字，也不要每次合成撞一次 401。
  const enabled = hasScript && (provider !== 'dashscope' || (typeof apiKey === 'string' && apiKey !== ''))

  function sweep(at) {
    try {
      for (const name of readdirSync(outDir)) {
        if (!name.endsWith('.mp3')) continue
        const path = join(outDir, name)
        if (at - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log.warn('tts sweep failed', { reason: error.message })
    }
  }

  async function synthesize(text) {
    if (!enabled) return null
    const body = prepareSpeech(text)
    if (body === '') return null
    const at = now()
    const out = join(outDir, `say-${at}-${Math.random().toString(16).slice(2, 8)}.mp3`)
    try {
      mkdirSync(outDir, { recursive: true })
      await run({ python, script, voice, rate, pitch, out, text: body, timeoutMs, provider, model, speechRate, pitchRate, instruction, apiKey })
      const bytes = statSync(out).size
      if (bytes === 0) throw new Error('empty audio')
      sweep(at)
      return { file: out, bytes }
    } catch (error) {
      rmSync(out, { force: true })
      log.warn('tts failed, falling back to text', { reason: error.message })
      return null
    }
  }

  return { enabled, outDir, synthesize }
}
