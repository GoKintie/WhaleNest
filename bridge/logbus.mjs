// 统一日志总线：控制台 + 内存环形缓冲 + SSE 订阅 + 持久化落盘与一键导出下载（bridge/logbus.mjs · v2.8）
// WebUI 的"日志/思考"面板、玩手机(ADB)诊断、一键下载日志均由本模块驱动

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX = 3000
const buf = []
const subs = new Set()
let seq = 0

export const logDir = process.env.LOG_DIR || join(process.env.WORKDIR || '/workspace', 'logs')
export const bridgeLogFile = join(logDir, 'bridge.log')
export const phoneLogFile = join(logDir, 'phone-adb.log')
export const ttsQzoneLogFile = join(logDir, 'tts-qzone.log')

function ensureLogDir() {
  try { mkdirSync(logDir, { recursive: true }) } catch {}
}

function appendRotated(filePath, line, maxBytes = 4 * 1024 * 1024) {
  try {
    ensureLogDir()
    if (existsSync(filePath)) {
      const st = statSync(filePath)
      if (st.size > maxBytes) {
        try { renameSync(filePath, `${filePath}.1`) } catch {}
      }
    }
    appendFileSync(filePath, line, 'utf8')
  } catch {}
}

export function push(kind, payload = {}) {
  const { kind: chatKind, ...fields } = payload
  const ev = { seq: ++seq, t: Date.now(), kind, ...fields }
  if (kind === 'msg' && chatKind) ev.chatKind = chatKind
  buf.push(ev)
  if (buf.length > MAX) buf.shift()
  for (const fn of subs) {
    try { fn(ev) } catch {}
  }
  return ev
}

export const log = (level, ...args) => {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const isPhone = /\[(?:手机|玩手机|phone|adb)/i.test(msg)
  push('log', { level, msg, category: isPhone ? 'phone' : 'general' })
  const tag = level === 'error' ? 'ERR ' : level === 'warn' ? 'WARN' : 'INFO'
  const iso = new Date().toISOString()
  console.log(iso, tag === 'INFO' ? '' : tag, msg)
  const diskLine = `${iso} [${tag}] ${msg}\n`
  appendRotated(bridgeLogFile, diskLine)
  if (isPhone) {
    appendRotated(phoneLogFile, diskLine, 2 * 1024 * 1024)
  }
}

export const logPhone = (level, ...args) => {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const prefixed = msg.startsWith('[玩手机') || msg.startsWith('[手机') ? msg : `[玩手机/ADB] ${msg}`
  log(level, prefixed)
}

export const logError = (...a) => log('error', ...a)
export const logWarn = (...a) => log('warn', ...a)
export const logInfo = (...a) => log('info', ...a)

export function subscribe(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function since(afterSeq = 0) {
  return buf.filter((e) => e.seq > afterSeq)
}

export function recent(n = 300) {
  return buf.slice(-n)
}

export function stats() {
  return { seq, count: buf.length, subscribers: subs.size, logDir }
}

/**
 * 读取玩手机 (phone-adb.log) 持久化日志（若磁盘尚无文件则从内存环形缓冲提取手机相关日志）
 */
export function readPhoneLogs(maxLines = 250) {
  ensureLogDir()
  const lines = []
  if (existsSync(phoneLogFile)) {
    try {
      const raw = readFileSync(phoneLogFile, 'utf8').split('\n').filter(Boolean)
      lines.push(...raw.slice(-maxLines))
    } catch {}
  }
  if (!lines.length) {
    for (const ev of buf) {
      if (ev.kind === 'log' && (ev.category === 'phone' || /手机|phone|adb|模拟器/i.test(ev.msg || ''))) {
        lines.push(`${new Date(ev.t).toISOString()} [${(ev.level || 'info').toUpperCase()}] ${ev.msg}`)
      }
    }
  }
  return lines.slice(-maxLines)
}

export function clearPhoneLogs() {
  try {
    ensureLogDir()
    writeFileSync(phoneLogFile, '', 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 组装供 WebUI 一键点击下载的完整诊断日志文件文本
 * @param {object} opts - { type: 'all' | 'phone' | 'bridge' | 'error' | 'tts_qzone', meta: {} }
 */
export function exportLogBundle(opts = {}) {
  const type = String(opts.type || 'all').toLowerCase()
  const nowIso = new Date().toISOString()
  const sections = [
    '================================================================================',
    `  肥鱼 (dsh-qq-agent v2.8) 运行与诊断日志导出包`,
    `  导出时间: ${nowIso} | 导出类型: ${type}`,
    opts.meta ? `  运行状态摘要: ${JSON.stringify(opts.meta)}` : '',
    '================================================================================',
    '',
  ].filter(Boolean)

  if (type === 'phone' || type === 'all') {
    const pLines = readPhoneLogs(500)
    sections.push('--- [1] 玩手机 / MuMu 安卓模拟器 (ADB) 专项日志 (/workspace/logs/phone-adb.log) ---')
    sections.push(pLines.length ? pLines.join('\n') : '（暂无玩手机/ADB 执行记录；请在 WebUI 点击「测试连接并截屏」或在 QQ 对肥鱼说「连上模拟器玩会儿手机」触发）')
    sections.push('')
  }

  if (type === 'tts_qzone' || type === 'all') {
    sections.push('--- [2] 语音合成 (TTS) 与 QQ空间 (QZone) 专项日志 (/workspace/logs/tts-qzone.log) ---')
    if (existsSync(ttsQzoneLogFile)) {
      try {
        const tLines = readFileSync(ttsQzoneLogFile, 'utf8').split('\n').filter(Boolean).slice(-300)
        sections.push(tLines.length ? tLines.join('\n') : '（暂无语音/QQ空间日志）')
      } catch {
        sections.push('（读取 tts-qzone.log 失败）')
      }
    } else {
      sections.push('（暂无语音/QQ空间日志）')
    }
    sections.push('')
  }

  if (type === 'error') {
    const errEvents = buf.filter((e) => e.kind === 'log' && (e.level === 'error' || e.level === 'warn'))
    sections.push('--- [告警与错误日志汇总 (WARN / ERROR)] ---')
    sections.push(
      errEvents.length
        ? errEvents.map((e) => `${new Date(e.t).toISOString()} [${String(e.level).toUpperCase()}] ${e.msg}`).join('\n')
        : '（当前无 WARN/ERROR 报错记录）'
    )
    sections.push('')
  }

  if (type === 'bridge' || type === 'all') {
    sections.push('--- [3] 主程序 Bridge 实时运行日志 (/workspace/logs/bridge.log 最近 600 行) ---')
    if (existsSync(bridgeLogFile)) {
      try {
        const bLines = readFileSync(bridgeLogFile, 'utf8').split('\n').filter(Boolean).slice(-600)
        sections.push(bLines.join('\n'))
      } catch {}
    } else {
      const memLines = buf
        .filter((e) => e.kind === 'log')
        .slice(-500)
        .map((e) => `${new Date(e.t).toISOString()} [${String(e.level || 'info').toUpperCase()}] ${e.msg}`)
      sections.push(memLines.join('\n') || '（暂无日志）')
    }
    sections.push('')
  }

  return sections.join('\n')
}
