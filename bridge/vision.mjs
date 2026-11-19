import {imageBufferForVision} from './image-input.mjs'
// 外部多模态视觉识图插件（bridge/vision.mjs）
//
// v2.4 增强（P1-E 成本与安全护栏）：
// 1. 按文件 SHA1 持久化缓存（/workspace/vision-cache.json，30 天内同一张图直接命中缓存，零重复 HTTP 请求，超 500 条按时间淘汰）
// 2. 体积上限 MAX_BYTES = 2MB（超过 2MB 直接跳过并记 warn，避免 base64 膨胀触发 413）
// 3. 并发锁 MAX_CONCURRENT = 2（最多同时 2 个在飞请求，超出排队等待）
// 4. OCR 结果防注入清洗：命中指令式文本（如“忽略以上指令”、“system prompt”等）时自动剥离该行

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, basename, join } from 'node:path'
import { current as settings } from './settings.mjs'
import { log } from './logbus.mjs'

const WORKSPACE = process.env.WORKDIR || '/workspace'
const CACHE_FILE = process.env.VISION_CACHE_FILE || join(WORKSPACE, 'vision-cache.json')
const MAX_BYTES = 2 * 1024 * 1024
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000
const MAX_CACHE_ITEMS = 500
const MAX_CONCURRENT = 2
const INJECTION_RE = /(忽略(以上|之前|所有).{0,6}(指令|要求|规则|设定)|system\s*prompt|你现在是|请扮演|\[\[(?:send|remind|phone|adb|file|image|emoji):)/i

const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

let memCache = null

function loadCache() {
  if (memCache) return memCache
  try {
    if (existsSync(CACHE_FILE)) {
      memCache = JSON.parse(readFileSync(CACHE_FILE, 'utf8') || '{}')
      return memCache
    }
  } catch {}
  memCache = {}
  return memCache
}

export function cacheGet(key) {
  if (!key) return null
  const store = loadCache()
  const entry = store[key]
  if (!entry || !entry.text) return null
  if (Date.now() - Number(entry.at || 0) > CACHE_TTL_MS) {
    delete store[key]
    return null
  }
  return entry
}

export function cacheSet(key, text) {
  if (!key || !text) return
  const store = loadCache()
  store[key] = { text, at: Date.now() }
  const keys = Object.keys(store)
  if (keys.length > MAX_CACHE_ITEMS) {
    keys.sort((a, b) => (store[a]?.at || 0) - (store[b]?.at || 0))
    for (const oldKey of keys.slice(0, keys.length - MAX_CACHE_ITEMS)) {
      delete store[oldKey]
    }
  }
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(store, null, 2), 'utf8')
  } catch {}
}

let inflight = 0
const waitQueue = []

export function getInflightCount() {
  return inflight
}

async function withConcurrencyLimit(fn) {
  if (inflight >= MAX_CONCURRENT) {
    await new Promise((resolve) => waitQueue.push(resolve))
  }
  inflight += 1
  try {
    return await fn()
  } finally {
    inflight -= 1
    const next = waitQueue.shift()
    if (next) next()
  }
}

export function sanitizeOcrText(rawText) {
  const lines = String(rawText || '').split('\n')
  const kept = lines.filter((line) => !INJECTION_RE.test(line))
  return kept.join(' ').replace(/\s+/g, ' ').trim()
}

export function isVisionPluginActive(customSettings = null) {
  const s = customSettings || settings()
  return Boolean(
    s.pluginVisionEnabled &&
    String(s.pluginVisionBaseUrl || '').trim() &&
    String(s.pluginVisionApiKey || '').trim() &&
    String(s.pluginVisionModel || '').trim()
  )
}

export function readImageWithHash(filePath, maxBytes = MAX_BYTES) {
  if (!filePath || !existsSync(filePath)) return null
  let buf
  try { buf = readFileSync(filePath) } catch { return null }
  if (!buf.length) return null
  if (buf.length > maxBytes) {
    log('warn', `[视觉插件] 图片超过 2MB 上限 (${(buf.length / 1048576).toFixed(2)}MB)，跳过识图：${basename(filePath)}`)
    return null
  }
  const sha1 = createHash('sha1').update(buf).digest('hex')
  const ext = (extname(filePath) || '.jpg').toLowerCase()
  const mime = MIME_MAP[ext] || 'image/jpeg'
  return {
    sha1,
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
  }
}

export function imageToDataUrl(filePath, maxBytes = MAX_BYTES) {
  const r = readImageWithHash(filePath, maxBytes)
  return r ? r.dataUrl : null
}

async function callOpenAIVision({ baseUrl, apiKey, model, prompt, dataUrls = [], timeoutMs = 25000, maxTokens = 450, customFetch = null }) {
  return withConcurrencyLimit(async () => {
    const cleanBase = String(baseUrl || 'https://api.siliconflow.cn/v1').trim().replace(/\/+$/, '')
    const endpoint = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`

    const content = [{ type: 'text', text: prompt }]
    for (const url of dataUrls) {
      content.push({
        type: 'image_url',
        image_url: { url },
      })
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const fetchFn = customFetch || globalThis.fetch
    try {
      const res = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${String(apiKey || '').trim()}`,
        },
        body: JSON.stringify({
          model: String(model || 'Qwen/Qwen2.5-VL-72B-Instruct').trim(),
          messages: [{ role: 'user', content }],
          max_tokens: maxTokens,
          temperature: 0.2,
        }),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const errMsg = data?.error?.message || data?.message || `HTTP ${res.status}`
        return { ok: false, error: errMsg }
      }
      const text = String(data?.choices?.[0]?.message?.content || '').trim()
      return { ok: Boolean(text), text, usage: data?.usage }
    } catch (e) {
      return { ok: false, error: e?.name === 'AbortError' ? '视觉 API 请求超时' : (e?.message || String(e)) }
    } finally {
      clearTimeout(timer)
    }
  })
}

/**
 * 为单张聊天图片生成高密度视觉描述与 OCR 文字（带 30 天 SHA1 缓存、2MB 拦截与防注入清洗）
 */
export async function describeImageWithVision(filePath, customSettings = null, opts = {}) {
  const s = customSettings || settings()
  if (!isVisionPluginActive(s)) return null
  const prepared=await imageBufferForVision(filePath,{maxBytes:MAX_BYTES})
  const img=prepared?{sha1:prepared.sha1,dataUrl:`data:${prepared.mime};base64,${prepared.buffer.toString('base64')}`}:null
  if (!img) return null

  const cacheKey = `desc:${img.sha1}`
  const hit = cacheGet(cacheKey)
  if (hit) {
    log('debug', `[视觉插件] 命中缓存 (${basename(filePath)} sha1=${img.sha1.slice(0, 8)})`)
    return hit.text
  }

  const prompt = [
    '请用简练精准的中文描述这张图片（不超过 90 字），直接输出以下三点（同行紧凑输出）：',
    '1. 画面主体与动作神态；',
    '2. 图中所有可见文字（OCR 原文照录，无文字写“无文字”）；',
    '3. 若是表情包/梗图或截图，点明它表达的情绪、槽点或核心信息。',
  ].join('\n')

  const r = await callOpenAIVision({
    baseUrl: s.pluginVisionBaseUrl,
    apiKey: s.pluginVisionApiKey,
    model: s.pluginVisionModel,
    prompt,
    dataUrls: [img.dataUrl],
    timeoutMs: 20000,
    maxTokens: 240,
    customFetch: opts.customFetch,
  })
  if (!r.ok) {
    log('warn', `[视觉插件] 识图失败 (${basename(filePath)})：${r.error}`)
    return null
  }
  const cleaned = sanitizeOcrText(r.text)
  if (!cleaned) return null
  cacheSet(cacheKey, cleaned)
  return cleaned
}

/**
 * 批量识别刚收到的 QQ 聊天图片，拼出 # 视觉插件识图结果 块
 */
export async function describeImagesForChat(paths = [], customSettings = null, opts = {}) {
  const s = customSettings || settings()
  if (!isVisionPluginActive(s) || !Array.isArray(paths) || !paths.length) return ''
  const targetPaths = paths.slice(0, 3)
  const results = await Promise.all(
    targetPaths.map(async (p, idx) => {
      const desc = await describeImageWithVision(p, s, opts)
      return desc ? `- [图${idx + 1} ${basename(p)}]：${desc}` : null
    })
  )
  const valid = results.filter(Boolean)
  if (!valid.length) return '\n# 图片识别未完成\n这批图片未能得到可靠视觉结果。不要编造画面或文字，可以说明识图失败并请对方补充。'
  log('info', `[视觉插件] 已完成 ${valid.length} 张聊天图片的 OCR 与情绪解析`)
  return `\n\n# 视觉插件识图结果（已为你看清对方刚发的图片与图中文字，请直接结合画面内容自然回应）\n${valid.join('\n')}`
}

/**
 * 使用外部视觉模型对单张图库素材做高速分类与情绪打标（带 SHA1 缓存）
 */
export async function classifyImageWithVision(filePath, index = 1, customSettings = null, opts = {}) {
  const s = customSettings || settings()
  if (!isVisionPluginActive(s)) return null
  const prepared=await imageBufferForVision(filePath,{maxBytes:MAX_BYTES})
  const img=prepared?{sha1:prepared.sha1,dataUrl:`data:${prepared.mime};base64,${prepared.buffer.toString('base64')}`}:null
  if (!img) return null

  const cacheKey = `cls:${img.sha1}`
  const hit = cacheGet(cacheKey)
  if (hit) {
    try {
      const parsed = JSON.parse(hit.text)
      log('debug', `[视觉插件] 分类命中缓存 (${basename(filePath)})`)
      return { ...parsed, i: index }
    } catch {}
  }

  const prompt = [
    '请看这张图并输出严格的单行 JSON 对象（不要 markdown 代码块，不要任何多余解释）：',
    `{"i":${index},"category":"sticker|screenshot|photo|document|misc","name":"不超过8个字的具体画面或梗图名","tags":["情绪词","主体词"],"reason":"一句话简述"}`,
    '分类标准：',
    '- sticker：表情包、梗图、二次元表情、带字搞笑图（tags 必填 1~3 个情绪或主体词，如 搞笑/无语/嘲讽/委屈/吃惊/摆烂/开心/猫/狗/动漫）',
    '- screenshot：手机或电脑界面截图、聊天记录、报错日志、网页或游戏截图',
    '- photo：真实人物、宠物、风景或物品实拍照片',
    '- document：文档、表格、票据、书页扫描',
    '- misc：其他杂图',
  ].join('\n')

  const r = await callOpenAIVision({
    baseUrl: s.pluginVisionBaseUrl,
    apiKey: s.pluginVisionApiKey,
    model: s.pluginVisionModel,
    prompt,
    dataUrls: [img.dataUrl],
    timeoutMs: 22000,
    maxTokens: 200,
    customFetch: opts.customFetch,
  })
  if (!r.ok) return null
  const raw = sanitizeOcrText(r.text)
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const obj = JSON.parse(raw.slice(a, b + 1))
    cacheSet(cacheKey, JSON.stringify(obj))
    return { ...obj, i: index }
  } catch {
    return null
  }
}

/**
 * 测试外部多模态视觉 API 连通性（供 WebUI 设置页一键测试）
 */
export async function testVisionPlugin(customSettings = null) {
  const s = customSettings || settings()
  const baseUrl = String(s.pluginVisionBaseUrl || '').trim()
  const apiKey = String(s.pluginVisionApiKey || '').trim()
  const model = String(s.pluginVisionModel || '').trim()
  if (!baseUrl || !apiKey || !model) {
    return { ok: false, error: '请先填写视觉 API 地址、API Key 和模型名称' }
  }
  // A generated blue square meets vision APIs' minimum image dimensions.
  const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAApklEQVR4nO3QQQ0AIBDAMMygDMXnCAd82aPJBCxd+4were8H8QABAgQIUDhAgAABAhQOECBAgACFAwQIECBA4QABAgQIUDhAgAABAhQOECBAgACFAwQIECBA4QABAgQIUDhAgAABAhQOECBAgACFAwQIECBA4QABAgQIUDhAgAABAhQOECBAgACFAwQIECBA4QABAgQIUDhAgAABAhQOECBAgOYj0AUOHYbRy19hGQAAAABJRU5ErkJggg=='
  const r = await callOpenAIVision({
    baseUrl,
    apiKey,
    model,
    prompt: '这是一次多模态连通性测试，请简短回复“视觉插件连接正常”六个字。',
    dataUrls: [testImage],
    timeoutMs: 15000,
    maxTokens: 50,
  })
  return r
}
