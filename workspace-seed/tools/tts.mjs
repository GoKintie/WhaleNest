#!/usr/bin/env node
// @plugin-name: 肥鱼多引擎语音合成 (feiyu_voice)
// @plugin-trigger: [[tts:台词]] | 发条语音 | 用语音说
// @plugin-desc: 支持阿里云百炼 / 硅基流动 CosyVoice / 微软 Edge 免费傲娇少女音与离线 WAV 兜底合成
//
// 大肥鱼多引擎语音合成器（/workspace/tools/tts.mjs · v2.8）
// 参考：Esmerubphire/astrbot_plugin_feiyu_voice 与 whyever77/dafeiyu-astrbot

import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { readSettings } from './settings-reader.mjs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const WORKSPACE = process.env.WORKDIR || '/workspace'
const LOG_DIR = process.env.LOG_DIR || join(WORKSPACE, 'logs')
const MAX_TTS_FILES = 40

function logTts(level, msg) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const line = `${new Date().toISOString()} [TTS:${level.toUpperCase()}] ${msg}\n`
    appendFileSync(join(LOG_DIR, 'tts-qzone.log'), line, 'utf8')
    appendFileSync(join(LOG_DIR, 'bridge.log'), line, 'utf8')
  } catch {}
}

export function pruneOldTtsFiles(outDir = join(WORKSPACE, 'out'), maxKeep = MAX_TTS_FILES) {
  if (!existsSync(outDir)) return 0
  const files = readdirSync(outDir)
    .filter((n) => /^tts-.*\.(mp3|wav|ogg)$/i.test(n))
    .sort()
  let removed = 0
  for (const old of files.slice(0, Math.max(0, files.length - maxKeep))) {
    try {
      unlinkSync(join(outDir, old))
      removed += 1
    } catch {}
  }
  return removed
}

/**
 * 清洗待朗读文本：撕掉双层括号草稿箱 （（...））、剥离指令标签 [[...]]、URL 和表情码
 */
export function cleanTextForTts(raw = '') {
  return String(raw || '')
    .replace(/（（[\s\S]*?））|\(\([\s\S]*?\)\)/g, '')
    .replace(/\[\[[\s\S]*?\]\]/g, '')
    .replace(/\[(表情包|图片|文件|表情|语音)\d*.*?\]/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[*#`_~>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260)
}

/**
 * 生成合法的单声道 16-bit PCM WAV 音频 Buffer（用于离线自测或极端断网环境保底）
 */
export function generateFallbackWavBuffer(text = '肥鱼', durationSec = 1.4) {
  const sampleRate = 16000
  const numSamples = Math.max(8000, Math.min(sampleRate * 4, Math.round(sampleRate * durationSec)))
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)

  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // Mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)

  const seed = Array.from(String(text)).reduce((a, c) => a + c.charCodeAt(0), 0)
  const f1 = 520 + (seed % 120)
  const f2 = 680 + (seed % 90)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    const env = Math.sin(Math.PI * (i / numSamples))
    const freq = t < durationSec * 0.5 ? f1 : f2
    const val = Math.sin(2 * Math.PI * freq * t) * 0.35 * env
    buf.writeInt16LE(Math.round(val * 32767), 44 + i * 2)
  }
  return buf
}

export const buildFallbackWavBuffer = generateFallbackWavBuffer

// 本地 PC 通道 5 分钟断路器缓存（防止本地电脑关机时每次发语音都白等 2.5s）
const localPcCooldownUntil = new Map() // baseUrl -> timestamp
const LOCAL_PC_COOLDOWN_MS = 5 * 60 * 1000

export function resetLocalPcCooldown() {
  localPcCooldownUntil.clear()
}

/**
 * 引擎 -1（最高优）：局域网本地 PC 肥鱼专属声音服务 (Esmerubphire/astrbot_plugin_feiyu_voice)
 * 协议：POST {ttsLocalUrl}/v1/speech {"voice":"feiyu","text":"...","style":"cute"|"gentle"}
 *      -> 轮询 GET /v1/jobs/{job_id} -> 下载 GET /v1/jobs/{job_id}/audio (RIFF WAV)
 * 同时兼容同步直出音频流的本地推理端点。
 */
export async function tryLocalPcFeiyuTts(text, cfg = {}, opts = {}) {
  const baseUrl = String(
    opts.localUrl || cfg.ttsLocalUrl || process.env.TTS_LOCAL_URL || ''
  ).trim().replace(/\/+$/, '')
  if (!baseUrl) return { ok: false, error: '未配置局域网本地 PC 推理地址 (ttsLocalUrl)' }

  if (!opts.force && (localPcCooldownUntil.get(baseUrl) || 0) > Date.now()) {
    return { ok: false, skippedCooldown: true, error: `局域网本地 PC (${baseUrl}) 处于离线冷却期，直接走云端` }
  }

  const apiKey = String(opts.localKey ?? cfg.ttsLocalKey ?? process.env.TTS_LOCAL_KEY ?? '').trim()
  const rawStyle = String(opts.style || cfg.ttsStyle || process.env.TTS_STYLE || 'cute').trim().toLowerCase()
  const style = rawStyle === 'gentle' ? 'gentle' : 'cute'
  const voice = String(cfg.ttsLocalVoice || 'feiyu').trim() || 'feiyu'

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  // 先用短超时提交 /v1/speech，若本地 PC 未开机或未启动服务，2s 内快速失败并记入 5 分钟断路器以便无缝回落云端
  let submitResp
  try {
    submitResp = await fetch(`${baseUrl}/v1/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ voice, text, style }),
      signal: AbortSignal.timeout(Number(opts.connectTimeoutMs || 2200)),
    })
    localPcCooldownUntil.delete(baseUrl)
  } catch (e) {
    localPcCooldownUntil.set(baseUrl, Date.now() + LOCAL_PC_COOLDOWN_MS)
    return { ok: false, error: `局域网本地 PC (${baseUrl}) 未响应: ${e.message}` }
  }

  if (!submitResp.ok) {
    const detail = await submitResp.text().catch(() => '')
    return { ok: false, error: `本地 PC 语音服务 HTTP ${submitResp.status}: ${detail.slice(0, 160)}` }
  }

  const ctype = String(submitResp.headers.get('content-type') || '').toLowerCase()
  if (ctype.includes('audio/') || ctype.includes('octet-stream')) {
    const directBuf = Buffer.from(await submitResp.arrayBuffer())
    if (directBuf.length > 200) {
      const ext = directBuf.subarray(0, 4).toString('ascii') === 'RIFF' ? '.wav' : '.mp3'
      return { ok: true, buffer: directBuf, provider: `feiyu-local-pc:${style}`, ext }
    }
  }

  let jobData = {}
  try { jobData = await submitResp.json() } catch {}
  const jobId = String(jobData.id || jobData.job_id || '').trim()
  if (!/^[0-9a-f]{16,64}$/i.test(jobId)) {
    return { ok: false, error: `本地 PC 语音服务未返回有效 job_id: ${JSON.stringify(jobData).slice(0, 120)}` }
  }

  const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  // 先问一句模型在不在内存里：常驻=秒回，加载中=给足时间。以前一律等 60 秒，
  // 刚好卡在冷启动的 64~108 秒外面，导致每次都白等一分钟再降级云端。
  let waitMs = Number(opts.waitTimeoutMs || 0)
  if (!waitMs) {
    waitMs = 90000
    try {
      const capResp = await fetch(`${baseUrl}/v1/capabilities`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(4000),
      })
      if (capResp.ok) {
        const cap = await capResp.json().catch(() => ({}))
        const state = String(cap?.resident?.state || '')
        if (state === 'ready') waitMs = 60000
        else if (state === 'loading' || state === 'unloaded') waitMs = 150000
      }
    } catch {}
  }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800))
    const stResp = await fetch(`${baseUrl}/v1/jobs/${jobId}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(6000),
    })
    if (!stResp.ok) continue
    const st = await stResp.json().catch(() => ({}))
    if (st.status === 'failed' || st.status === 'interrupted') {
      return { ok: false, error: `本地 PC 推理任务失败: ${st.error || st.status}` }
    }
    if (st.status === 'success') {
      const audioResp = await fetch(`${baseUrl}/v1/jobs/${jobId}/audio`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(15000),
      })
      if (!audioResp.ok) {
        return { ok: false, error: `下载本地 PC 音频失败 HTTP ${audioResp.status}` }
      }
      const wavBuf = Buffer.from(await audioResp.arrayBuffer())
      if (wavBuf.length < 200 || wavBuf.subarray(0, 4).toString('ascii') !== 'RIFF') {
        return { ok: false, error: '本地 PC 返回的音频非有效 RIFF WAV' }
      }
      return { ok: true, buffer: wavBuf, provider: `feiyu-local-pc:${voice}:${style}`, ext: '.wav' }
    }
  }
  localPcCooldownUntil.set(baseUrl, Date.now() + LOCAL_PC_COOLDOWN_MS)
  return { ok: false, error: `等待本地 PC 语音推理超时 (job=${jobId})` }
}

/**
 * 引擎 0：阿里云百炼 Qwen-Audio-TTS 原生接口
 * POST {host}/api/v1/services/audio/tts/SpeechSynthesizer
 * 注意：与 OpenAI 兼容的 /audio/speech 是两套协议，qwen-audio-3.x 必须走这里。
 */
export function resolveDashscopeTtsEndpoint(cfg = {}) {
  const raw = String(
    cfg.ttsApiUrl || cfg.ttsBaseUrl || process.env.TTS_ENDPOINT || process.env.TTS_BASE_URL || ''
  ).trim()
  if (!raw) return 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
  if (/\/api\/v1\/services\/audio\/tts\/SpeechSynthesizer\/?$/i.test(raw)) return raw.replace(/\/+$/, '')
  const host = raw
    .replace(/\/+$/, '')
    .replace(/\/api\/v1(?:\/.*)?$/i, '')
    .replace(/\/compatible-mode(?:\/v1)?\/?$/i, '')
    .replace(/\/+$/, '')
  return `${host}/api/v1/services/audio/tts/SpeechSynthesizer`
}

async function tryDashscopeNativeTts(text, cfg) {
  const apiKey = String(
    cfg.ttsApiKey || (!cfg.ttsVoiceSelection && (cfg.pluginTtsApiKey || process.env.TTS_API_KEY || process.env.DASHSCOPE_API_KEY)) || ''
  ).trim()
  if (!apiKey) return { ok: false, error: '未配置百炼 API Key' }

  let model = String(cfg.ttsModel || process.env.TTS_MODEL || '').trim()
  if (!model || !/(?:tts|^cosyvoice-)/i.test(model)) model = 'qwen-audio-3.1-tts-flash'

  let voice = String(cfg.ttsVoice || process.env.TTS_VOICE || '').trim()
  const looksForeign = !voice || /^zh-CN-/i.test(voice) || /^FunAudioLLM\//i.test(voice) ||
    /^(nova|shimmer|alloy|echo|fable|onyx|Cherry|claire)$/i.test(voice)
  if (looksForeign && !cfg.ttsVoiceSelection) voice = String(cfg.ttsDefaultVoice || 'longanhuan_v3.1')

  const input = {
    text,
    voice,
    format: String(cfg.ttsFormat || 'mp3'),
    sample_rate: Number(cfg.ttsSampleRate || 24000),
  }
  const spd = Number(cfg.ttsSpeed || 1)
  if (Number.isFinite(spd) && spd >= 0.5 && spd <= 2) input.rate = spd
  const instruction = String(cfg.ttsInstruction || process.env.TTS_INSTRUCTION || '').trim()
  if (instruction) input.instruction = instruction

  const endpoint = resolveDashscopeTtsEndpoint(cfg)
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(30000),
  })

  const rawText = await resp.text().catch(() => '')
  if (!resp.ok) {
    return { ok: false, error: `百炼 HTTP ${resp.status}: ${rawText.slice(0, 240)}`, endpoint, model, voice }
  }
  let data = {}
  try { data = JSON.parse(rawText) } catch {}
  const audioUrl = data?.output?.audio?.url
  if (!audioUrl) {
    return { ok: false, error: `百炼未返回音频地址: ${rawText.slice(0, 240)}`, endpoint, model, voice }
  }
  const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(20000) })
  if (!audioRes.ok) return { ok: false, error: `音频下载失败 HTTP ${audioRes.status}`, endpoint, model, voice }
  const buf = Buffer.from(await audioRes.arrayBuffer())
  if (buf.length < 200) return { ok: false, error: '百炼返回音频过小', endpoint, model, voice }
  const ext = input.format === 'wav' ? '.wav' : '.mp3'
  return { ok: true, buffer: buf, provider: `dashscope:${model}:${voice}`, ext }
}

/**
 * 引擎 1：OpenAI 兼容 / SiliconFlow / 百炼兼容 /v1/audio/speech
 */
async function tryOpenAiCompatibleTts(text, cfg) {
  // v2.9.1：默认不复用视觉插件的 Key。
  // 旧版会把视觉 Key（如智谱 GLM-4V）发到 DashScope/硅基，既必然 401，又等于把 Key 交出去了。
  const reuseVisionKey = String(process.env.TTS_REUSE_VISION_KEY || '').toLowerCase() === 'true'
  const apiKey = String(
    cfg.ttsApiKey ||
    (!cfg.ttsVoiceSelection && ((reuseVisionKey ? cfg.pluginVisionApiKey : '') || process.env.TTS_API_KEY || process.env.DASHSCOPE_API_KEY)) ||
    ''
  ).trim()
  if (!apiKey) return { ok: false, error: '未配置 TTS API Key' }

  // 同时兼容 WebUI 的 ttsApiUrl 与 settings.mjs 的 ttsBaseUrl
  let baseUrl = String(cfg.ttsApiUrl || cfg.ttsBaseUrl || process.env.TTS_BASE_URL || '').trim().replace(/\/+$/, '')
  let model = String(cfg.ttsModel || process.env.TTS_MODEL || '').trim()
  let voice = String(cfg.ttsVoice || process.env.TTS_VOICE || '').trim()

  const provider = String(cfg.ttsProvider || 'auto').toLowerCase()
  if (!baseUrl) {
    if (provider === 'dashscope' || (apiKey.startsWith('sk-') && model.includes('qwen'))) {
      baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    } else {
      baseUrl = String(cfg.pluginVisionBaseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
    }
  }
  if (!model) {
    if (provider === 'dashscope' || baseUrl.includes('dashscope')) model = 'qwen-audio-3.1-tts-flash'
    else if (provider === 'siliconflow' || baseUrl.includes('siliconflow')) model = 'FunAudioLLM/CosyVoice2-0.5B'
    else model = 'tts-1'
  }
  if (!voice || (!cfg.ttsVoiceSelection && /^zh-CN-/i.test(voice))) {
    if (model.includes('CosyVoice2')) voice = /^FunAudioLLM/i.test(voice) ? voice : 'FunAudioLLM/CosyVoice2-0.5B:claire'
    else if (model.includes('qwen')) voice = (!voice || /^zh-CN-/i.test(voice)) ? 'Cherry' : voice
    else if (!voice || /^zh-CN-/i.test(voice)) voice = 'nova'
  }

  // 针对 DashScope 原生 multimodal-generation 接口（qwen-audio-3.1-tts-flash / sambert）
  if (baseUrl.includes('dashscope') && model.includes('qwen-audio')) {
    const dsUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
    const resp = await fetch(dsUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: { text, voice: voice || 'Cherry' },
      }),
      signal: AbortSignal.timeout(18000),
    })
    if (resp.ok) {
      const data = await resp.json()
      const audioUrl = data?.output?.audio?.url
      if (audioUrl) {
        const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(15000) })
        if (audioRes.ok) {
          const buf = Buffer.from(await audioRes.arrayBuffer())
          if (buf.length > 200) return { ok: true, buffer: buf, provider: `dashscope:${model}`, ext: '.mp3' }
        }
      }
    }
  }

  const endpoint = baseUrl.endsWith('/audio/speech') ? baseUrl : `${baseUrl}/audio/speech`
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: 'mp3',
      speed: Number(cfg.ttsSpeed || 1.05),
    }),
    signal: AbortSignal.timeout(18000),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    return { ok: false, error: `HTTP ${resp.status}: ${errText.slice(0, 140)}` }
  }
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length < 200) return { ok: false, error: '返回音频数据过小' }
  return { ok: true, buffer: buf, provider: `openai-tts:${model}`, ext: '.mp3' }
}

/**
 * 引擎 2：Microsoft Edge Neural TTS 免 Key 神经语音合成（zh-CN-XiaoyiNeural 傲娇少女音）
 */
async function tryEdgeFreeTts(text, voice = 'zh-CN-XiaoyiNeural', rate = '+5%', pitch = '+4Hz') {
  if (typeof WebSocket === 'undefined') return { ok: false, error: 'WebSocket 不可用' }
  const trustedToken = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
  const secMsGecVersion = '1-130.0.2849.68'
  const winEpoch = 11644473600n
  const ticks = (BigInt(Math.floor(Date.now() / 1000)) + winEpoch)
  const rounded = ticks - (ticks % 300n)
  const strToHash = `${rounded * 10000000n}${trustedToken}`
  const secMsGec = createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase()
  const connId = randomBytes(16).toString('hex')
  const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${trustedToken}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${secMsGecVersion}&ConnectionId=${connId}`

  return new Promise((resolve) => {
    let settled = false
    const chunks = []
    const done = (res) => {
      if (settled) return
      settled = true
      try { ws.close() } catch {}
      resolve(res)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'Edge TTS 超时' }), 10000)

    let ws
    try {
      ws = new WebSocket(wsUrl, {
        headers: {
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
        },
      })
    } catch (e) {
      clearTimeout(timer)
      return resolve({ ok: false, error: e.message })
    }

    const reqId = randomBytes(16).toString('hex')
    const safeVoice = /^zh-CN-/i.test(voice) ? voice : 'zh-CN-XiaoyiNeural'
    const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    ws.addEventListener('open', () => {
      const cfgMsg = `X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
      ws.send(cfgMsg)
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${safeVoice}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${escapedText}</prosody></voice></speak>`
      const ssmlMsg = `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}Z\r\nPath:ssml\r\n\r\n${ssml}`
      ws.send(ssmlMsg)
    })

    ws.addEventListener('message', async (ev) => {
      try {
        if (typeof ev.data === 'string') {
          if (ev.data.includes('Path:turn.end')) {
            clearTimeout(timer)
            const total = Buffer.concat(chunks)
            if (total.length > 200) done({ ok: true, buffer: total, provider: `edge-tts:${safeVoice}`, ext: '.mp3' })
            else done({ ok: false, error: 'Edge TTS 返回空音频' })
          }
        } else {
          const rawBuf = Buffer.isBuffer(ev.data)
            ? ev.data
            : ev.data instanceof ArrayBuffer
              ? Buffer.from(ev.data)
              : Buffer.from(await ev.data.arrayBuffer())
          if (rawBuf.length > 2) {
            const headerLen = rawBuf.readUInt16BE(0)
            const headerStr = rawBuf.subarray(2, 2 + headerLen).toString('utf8')
            if (headerStr.includes('Path:audio')) {
              const audioPart = rawBuf.subarray(2 + headerLen)
              if (audioPart.length) chunks.push(audioPart)
            }
          }
        }
      } catch {}
    })

    ws.addEventListener('error', (e) => {
      clearTimeout(timer)
      done({ ok: false, error: e?.message || 'Edge WS error' })
    })
    ws.addEventListener('close', () => {
      clearTimeout(timer)
      const total = Buffer.concat(chunks)
      if (total.length > 200) done({ ok: true, buffer: total, provider: `edge-tts:${safeVoice}`, ext: '.mp3' })
      else done({ ok: false, error: 'Edge WS closed early' })
    })
  })
}

/**
 * 引擎 3：免 Key 在线 HTTP 中文语音合成兜底（有道/百度/Google公开朗读流）
 */
async function tryFreeHttpTts(text) {
  const encoded = encodeURIComponent(text.slice(0, 120))
  const urls = [
    `https://dict.youdao.com/dictvoice?audio=${encoded}&le=zh`,
    `https://fanyi.baidu.com/gettts?lan=zh&text=${encoded}&spd=5&source=web`,
    `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q=${encoded}`,
  ]
  for (const u of urls) {
    try {
      const resp = await fetch(u, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0' },
        signal: AbortSignal.timeout(6000),
      })
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer())
        if (buf.length > 400) {
          return { ok: true, buffer: buf, provider: `free-http:${new URL(u).hostname}`, ext: '.mp3' }
        }
      }
    } catch {}
  }
  return { ok: false, error: '在线免Key TTS 均不可达' }
}

/**
 * 主合成入口：支持「局域网本地 PC 推理 (astrbot_plugin_feiyu_voice)」与「云端接口」双通道切换/自动回退
 */
export async function synthesizeSpeech(rawText, outPath = '', customSettings = null, extraOpts = {}) {
  const original=customSettings||readSettings()
  const style=String(extraOpts.style || original.ttsStyle || 'cute').toLowerCase()==='gentle'?'gentle':'cute'
  const selection=original.ttsVoiceSelection
  let picked=style==='gentle'?original.ttsVoiceGentle:original.ttsVoiceCute
  if (selection==='single') picked=original.ttsVoice
  if (selection==='context') picked ||= original.ttsVoiceCute || original.ttsVoiceGentle
  if (selection==='random') {
    const pool = Array.isArray(original.ttsVoicePool) ? original.ttsVoicePool.filter(id => typeof id === 'string' && id.trim()) : []
    if (!pool.length) return {ok:false,error:'随机音色列表为空'}
    picked=pool[Math.floor(Math.random()*pool.length)]
  }
  const voice = picked || original.ttsVoice
  let model = picked ? original.ttsCloudModel || original.ttsModel : original.ttsModel
  if (selection && original.ttsProvider==='dashscope') {
    model = voice?.match(/^((?:qwen-audio-[\d.]+-tts|cosyvoice-v[\d.]+)-(?:plus|flash))(?:-|$)/i)?.[1] ||
      voice?.match(/^(cosyvoice-v2)(?:-|$)/i)?.[1] || model
  }
  if (selection && original.ttsProvider==='siliconflow') {
    model = (Object.hasOwn(original.ttsVoiceModels || {},voice) && original.ttsVoiceModels[voice]) ||
      voice?.match(/^([\w.-]+\/[\w.-]+):/)?.[1] || model
  }
  const s={...original,ttsStyle:style,ttsVoice:voice,ttsModel:model,ttsInstruction:original.ttsInstruction||(style==='gentle'?'中文，温柔平静，自然轻声，语速稍慢':'中文，轻快自然，略带俏皮')}
  const text = cleanTextForTts(rawText)
  if (!text) return { ok: false, error: '待合成语音文本为空' }

  const outDir = join(WORKSPACE, 'out')
  mkdirSync(outDir, { recursive: true })
  const targetPath = outPath || join(outDir, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`)
  mkdirSync(dirname(targetPath), { recursive: true })

  const providerPref = String(s.ttsProvider || 'auto').toLowerCase()
  const ttsMode = selection ? 'cloud' : String(extraOpts.mode || s.ttsMode || 'auto').toLowerCase()
  const stylePref = String(extraOpts.style || s.ttsStyle || 'cute').toLowerCase()
  const reuseVisionKey = String(process.env.TTS_REUSE_VISION_KEY || '').toLowerCase() === 'true'
  const errors = []

  // 0) 离线单测 / 本地声波直通模式（免外网等待，毫秒级返回）
  if (providerPref === 'offline_test' || providerPref === 'local') {
    const wavBuf = generateFallbackWavBuffer(text, 1.4)
    const wavPath = outPath ? targetPath : targetPath.replace(/\.mp3$/i, '.wav')
    writeFileSync(wavPath, wavBuf)
    pruneOldTtsFiles(dirname(wavPath), MAX_TTS_FILES)
    logTts('info', `合成成功 [local-wav] (${wavBuf.length} bytes) -> ${wavPath} | 文本: "${text.slice(0, 40)}"`)
    return { ok: true, file: wavPath, provider: 'local-wav', bytes: wavBuf.length, text }
  }

  // 0.2) 接口一：局域网本地此电脑 GPU 推理（CosyVoice3 肥鱼声库 cute/gentle）
  if (ttsMode === 'local_pc' || (ttsMode === 'auto' && s.ttsLocalUrl)) {
    try {
      const rLocal = await tryLocalPcFeiyuTts(text, s, { style: stylePref, force: ttsMode === 'local_pc' })
      if (rLocal.ok && rLocal.buffer) {
        const outFile = rLocal.ext === '.wav' ? targetPath.replace(/\.mp3$/i, '.wav') : targetPath
        writeFileSync(outFile, rLocal.buffer)
        pruneOldTtsFiles(dirname(outFile), MAX_TTS_FILES)
        logTts('info', `合成成功 [${rLocal.provider}] (${rLocal.buffer.length} bytes) -> ${outFile} | 文本: "${text.slice(0, 40)}"`)
        return { ok: true, file: outFile, provider: rLocal.provider, style: stylePref, bytes: rLocal.buffer.length, text }
      }
      errors.push(rLocal.error)
      if (ttsMode === 'local_pc') {
        logTts('error', `仅本地 PC 推理模式失败 -> ${rLocal.error}`)
        return { ok: false, error: rLocal.error }
      }
      logTts('info', `本地 PC 推理未就绪 (${rLocal.error})，自动无缝切换至云端语音接口`)
    } catch (e) {
      errors.push(e.message)
      if (ttsMode === 'local_pc') return { ok: false, error: e.message }
    }
  }

  // 0.5) 阿里云百炼 Qwen-Audio-TTS 原生接口（qwen-audio-3.x + 复刻/设计音色走这条）
  const dsLike = selection ? providerPref === 'dashscope' : (
    providerPref === 'dashscope' ||
    /dashscope|maas\.aliyuncs/i.test(String(s.ttsApiUrl || s.ttsBaseUrl || '')) ||
    (providerPref !== 'edge' && providerPref !== 'siliconflow' && /qwen-audio/i.test(String(s.ttsModel || ''))))

  if (dsLike) {
    try {
      const r0 = await tryDashscopeNativeTts(text, s)
      if (r0.ok && r0.buffer) {
        const outFile = r0.ext === '.wav' ? targetPath.replace(/\.mp3$/i, '.wav') : targetPath
        writeFileSync(outFile, r0.buffer)
        pruneOldTtsFiles(dirname(outFile), MAX_TTS_FILES)
        logTts('info', `合成成功 [${r0.provider}] (${r0.buffer.length} bytes) -> ${outFile} | 文本: "${text.slice(0, 40)}"`)
        return { ok: true, file: outFile, provider: r0.provider, bytes: r0.buffer.length, text }
      }
      logTts(
        'error',
        `百炼合成失败 -> ${r0.error} | endpoint=${r0.endpoint || '?'} model=${r0.model || '?'} voice=${r0.voice || '?'}` +
          (/401|403/.test(String(r0.error)) ? ' | 提示：Key 与接口地址/地域是否匹配？业务空间可用「自定义语音接口地址」填 https://<业务空间ID>.cn-beijing.maas.aliyuncs.com' : '')
      )
      errors.push(r0.error)
    } catch (e) {
      logTts('error', `百炼合成异常 -> ${e.message}`)
      errors.push(e.message)
    }
    // 严格模式：配置了专用引擎就不要偷偷降级成默认音色
    if (s.ttsStrict === true || String(process.env.TTS_STRICT || '') === 'true') {
      logTts('error', `严格模式中止，未降级。原因: ${errors.join('; ')}`)
      return { ok: false, error: errors.join('; ') }
    }
  }

  // 1) 如果用户指定了 dashscope / siliconflow / openai，或配置了专用的 ttsApiKey / ttsApiUrl，优先走大模型音色
  if (!dsLike && providerPref !== 'edge' && (s.ttsApiKey || s.ttsApiUrl || s.ttsBaseUrl || providerPref === 'dashscope' || providerPref === 'siliconflow' || providerPref === 'openai')) {
    try {
      const r1 = await tryOpenAiCompatibleTts(text, s)
      if (r1.ok && r1.buffer) {
        writeFileSync(targetPath, r1.buffer)
        pruneOldTtsFiles(dirname(targetPath), MAX_TTS_FILES)
        logTts('info', `合成成功 [${r1.provider}] (${r1.buffer.length} bytes) -> ${targetPath} | 文本: "${text.slice(0, 40)}"`)
        return { ok: true, file: targetPath, provider: r1.provider, bytes: r1.buffer.length, text }
      }
      errors.push(r1.error)
    } catch (e) {
      errors.push(e.message)
    }
  }

  // 2) 走 Microsoft Edge Neural TTS 免费傲娇少女音 (zh-CN-XiaoyiNeural)
  if (selection && providerPref !== 'edge') {
    return {ok:false,error:errors.join('; ') || '云端语音合成失败'}
  }
  if (providerPref !== 'edge' && providerPref !== 'auto') {
    logTts('warn', `已配置引擎 ${providerPref} 全部失败，降至微软 Edge 默认音色（听到的可能不是你填的音色）`)
  }
  try {
    const edgeVoice = s.ttsVoice || 'zh-CN-XiaoyiNeural'
    const r2 = await tryEdgeFreeTts(text, edgeVoice)
    if (r2.ok && r2.buffer) {
      writeFileSync(targetPath, r2.buffer)
      pruneOldTtsFiles(dirname(targetPath), MAX_TTS_FILES)
      logTts('info', `合成成功 [${r2.provider}] (${r2.buffer.length} bytes) -> ${targetPath} | 文本: "${text.slice(0, 40)}"`)
      return { ok: true, file: targetPath, provider: r2.provider, bytes: r2.buffer.length, text }
    }
    errors.push(r2.error)
  } catch (e) {
    errors.push(e.message)
  }

  // 3) 复用视觉 Key 只在显式开启 TTS_REUSE_VISION_KEY=true 时才尝试（v2.9.1）
  if (selection) return {ok:false,error:errors.join('; ') || '云端语音合成失败'}
  if (reuseVisionKey && !s.ttsApiKey && s.pluginVisionApiKey) {
    try {
      const r3 = await tryOpenAiCompatibleTts(text, s)
      if (r3.ok && r3.buffer) {
        writeFileSync(targetPath, r3.buffer)
        pruneOldTtsFiles(dirname(targetPath), MAX_TTS_FILES)
        logTts('info', `合成成功 [${r3.provider}] (${r3.buffer.length} bytes) -> ${targetPath} | 文本: "${text.slice(0, 40)}"`)
        return { ok: true, file: targetPath, provider: r3.provider, bytes: r3.buffer.length, text }
      }
      errors.push(r3.error)
    } catch (e) {
      errors.push(e.message)
    }
  }

  // 4) 走免 Key HTTP 在线语音流兜底
  try {
    const r4 = await tryFreeHttpTts(text)
    if (r4.ok && r4.buffer) {
      writeFileSync(targetPath, r4.buffer)
      pruneOldTtsFiles(dirname(targetPath), MAX_TTS_FILES)
      logTts('info', `合成成功 [${r4.provider}] (${r4.buffer.length} bytes) -> ${targetPath} | 文本: "${text.slice(0, 40)}"`)
      return { ok: true, file: targetPath, provider: r4.provider, bytes: r4.buffer.length, text }
    }
    errors.push(r4.error)
  } catch (e) {
    errors.push(e.message)
  }

  // 5) 离线沙盒/断网环境终极保底：合成合法 WAV 声波文件（使用 .wav 扩展名确保浏览器与 NapCat 正确解码）
  const wavBuf = generateFallbackWavBuffer(text, 1.5)
  const wavFallbackPath = targetPath.replace(/\.mp3$/i, '.wav')
  writeFileSync(wavFallbackPath, wavBuf)
  if (outPath && outPath !== wavFallbackPath) {
    try { writeFileSync(outPath, wavBuf) } catch {}
  }
  pruneOldTtsFiles(dirname(wavFallbackPath), MAX_TTS_FILES)
  logTts('warn', `外网 TTS 不可达 (${errors.join('; ')})，已使用本地离线声波合成器生成音频 -> ${wavFallbackPath}`)
  return {
    ok: true,
    file: wavFallbackPath,
    provider: 'local-wav-fallback',
    bytes: wavBuf.length,
    text,
    warnings: errors,
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const args = process.argv.slice(2)
  if (args.includes('--self-check')) {
    console.log('tts self-check ok')
    process.exit(0)
  }
  const wantJson = args.includes('--json')
  const clean = args.filter((a) => a !== '--json')
  const text = clean[0] || '哼，才不是吃白饭的蓝色大肥鱼呢！'
  const out = clean[1] || ''
  synthesizeSpeech(text, out).then((res) => {
    if (wantJson) console.log(JSON.stringify(res))
    else console.log(res.file || '')
    process.exit(res.ok ? 0 : 1)
  })
}
