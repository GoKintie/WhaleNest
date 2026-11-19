// 素材落地：把 QQ 里发来的图片/文件存进 workspace/inbox/<日期>/
// dsh 只认本地路径，所以"下载"这一步必须在这里做。

import { mkdirSync, createWriteStream } from 'node:fs'
import { statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { localDay } from './memory.mjs'

const INBOX = process.env.INBOX_DIR || join(process.env.WORKDIR || '/workspace', 'inbox')
const MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES || 20 * 1024 * 1024)
const TIMEOUT_MS = Number(process.env.MEDIA_TIMEOUT_MS || 30000)

export function inboxDir(day = localDay()) {
  const dir = join(INBOX, day)
  mkdirSync(dir, { recursive: true })
  return dir
}

const EXT_OK = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.mp4', '.mp3', '.amr', '.silk',
  '.pdf', '.zip', '.rar', '.7z', '.pptx', '.ppt', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt', '.md',
  '.json', '.tsv', '.xml', '.html', '.py', '.js', '.ts', '.log', '.apk', '.epub'])

/** 文件名优先看 hint（QQ 给的原始文件名），再看 URL，最后按 content-type 兜底 */
export function extFrom(url = '', hint = '') {
  for (const raw of [hint, url]) {
    if (!raw) continue
    const clean = String(raw).split('?')[0].split('#')[0]
    const m = clean.match(/\.([A-Za-z0-9]{1,6})$/)
    if (!m) continue
    const ext = `.${m[1].toLowerCase()}`
    if (EXT_OK.has(ext)) return ext
  }
  return '.jpg'
}

/** 只允许 http/https，其它一律不下载 */
export function safeUrl(url) {
  try {
    const u = new URL(String(url))
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : ''
  } catch {
    return ''
  }
}

/** 优先 url；有些实现把链接塞在 file 字段里，兜底用 hint */
export function pickUrl(item) {
  return safeUrl(item?.url) || safeUrl(item?.hint) || ''
}

export function nameFor(chatId, index, url, hint) {
  const stamp = Date.now()
  return `${chatId}-${stamp}-${index}${extFrom(url, hint)}`
}

async function download(url, dest) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const len = Number(res.headers.get('content-length') || 0)
    if (len && len > MAX_BYTES) throw new Error(`文件太大（${Math.round(len / 1024 / 1024)}MB）`)

    let written = 0
    const out = createWriteStream(dest)
    for await (const chunk of res.body) {
      written += chunk.length
      if (written > MAX_BYTES) {
        out.destroy()
        throw new Error('超过大小上限')
      }
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
    }
    await new Promise((r) => out.end(r))
    return { path: dest, bytes: statSync(dest).size }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把一条消息里的图片/文件下载到 inbox。
 * @param {{media:Array<{type:string,url:string,hint?:string}>, chatId:string}} parsed
 * @returns {Promise<{paths:string[], failed:string[]}>}
 */
export async function fetchMedia(parsed, opts = {}) {
  const items = Array.isArray(parsed?.media) ? parsed.media.slice(0, 9) : []
  if (!items.length) return { paths: [], failed: [] }

  const dir = inboxDir()
  const paths = []
  const failed = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    // 合并转发由 get_forward_msg 展开，不属于文件/图片下载项
    if (item?.type === 'forward') continue
    let url = pickUrl(item)
    if (!url && item.fileId && typeof opts.resolve === 'function') {
      try { url = safeUrl(await opts.resolve(item)) || '' } catch { url = '' }
    }
    if (!url) {
      failed.push(`${item.type}#${i + 1}：没有可下载的地址`)
      continue
    }
    const dest = join(dir, nameFor(parsed.chatId, i + 1, url, item.hint))
    try {
      const got = await download(url, dest)
      item._localPath = got.path
      paths.push(got.path)
    } catch (e) {
      failed.push(`${item.type}#${i + 1}：${e.message}`)
    }
  }
  return { paths, failed }
}

export function baseNameOf(p) {
  return basename(String(p || ''))
}
