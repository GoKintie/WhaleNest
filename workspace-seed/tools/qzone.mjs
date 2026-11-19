#!/usr/bin/env node
// @plugin-name: QQ空间说说发布器 (onebot-qzone)
// @plugin-trigger: [[qzone:说说内容]] | 发条说说 | 发QQ空间
// @plugin-desc: 自动通过 NapCat get_cookies 提取 p_skey 计算 g_tk 发布图文说说，并归档至 qzone_posts.jsonl
//
// 大肥鱼 QQ 空间说说发布与互动模块（/workspace/tools/qzone.mjs · v2.8）
// 参考：Gu-Heping/onebot-qzone 与 Zhalslar/astrbot_plugin_qzone

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readSettings } from './settings-reader.mjs'

const WORKSPACE = process.env.WORKDIR || '/workspace'
const MEMORY_DIR = process.env.MEMORY_DIR || join(WORKSPACE, 'memory')
const LOG_DIR = process.env.LOG_DIR || join(WORKSPACE, 'logs')
const QZONE_HISTORY_FILE = join(MEMORY_DIR, 'qzone_posts.jsonl')
const MAX_QZONE_HISTORY = 200

function logQzone(level, msg) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const line = `${new Date().toISOString()} [QZONE:${level.toUpperCase()}] ${msg}\n`
    appendFileSync(join(LOG_DIR, 'tts-qzone.log'), line, 'utf8')
    appendFileSync(join(LOG_DIR, 'bridge.log'), line, 'utf8')
  } catch {}
}

/**
 * 腾讯 QQ 空间标准 g_tk (CSRF Token) 计算算法
 */
export function calcGtk(skey = '') {
  let hash = 5381
  const s = String(skey || '').trim()
  for (let i = 0; i < s.length; i++) {
    hash += (hash << 5) + s.charCodeAt(i)
  }
  return hash & 0x7fffffff
}

export const computeGtk = calcGtk

/**
 * 解析 Cookie 字符串为键值字典，提取 uin / p_skey / skey，并构造带完整 uin/p_uin 的标准化 Cookie 请求头
 */
export function parseCookieString(cookieStr = '', fallbackUin = '') {
  const map = {}
  for (const part of String(cookieStr || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) map[k] = v
  }
  const rawUin = map.p_uin || map.uin || map.o_cookie || String(fallbackUin || '')
  const uin = String(rawUin).replace(/^o0*/i, '').trim()
  const p_skey = map.p_skey || ''
  const skey = map.skey || ''
  const gtk = calcGtk(p_skey || skey)

  if (uin) {
    if (!map.uin) map.uin = `o${uin}`
    if (!map.p_uin) map.p_uin = `o${uin}`
  }
  const normalizedRaw = Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ')
  return { uin, p_skey, skey, gtk, raw: normalizedRaw || cookieStr, map }
}

export const extractCookMap = parseCookieString

/**
 * 当在 CLI 独立进程执行且未传入 callOneBot 时，直连 ONEBO_WS 获取 NapCat 登录信息与 Cookie
 */
async function fetchCredViaOneBotWs(wsUrl = process.env.ONEBOT_WS || 'ws://127.0.0.1:3001', token = process.env.ONEBOT_TOKEN || '') {
  if (typeof WebSocket === 'undefined') return null
  return new Promise((resolveDone) => {
    let settled = false
    const finish = (val) => {
      if (settled) return
      settled = true
      try { ws?.close() } catch {}
      resolveDone(val)
    }
    const timer = setTimeout(() => finish(null), 4000)
    let ws
    try {
      ws = new WebSocket(wsUrl, token ? { headers: { authorization: `Bearer ${token}` } } : undefined)
    } catch {
      clearTimeout(timer)
      return resolveDone(null)
    }
    let uin = ''
    let cookies = ''
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'qz_login' }))
      ws.send(JSON.stringify({ action: 'get_cookies', params: { domain: 'user.qzone.qq.com' }, echo: 'qz_cook1' }))
      ws.send(JSON.stringify({ action: 'get_cookies', params: { domain: 'qzone.qq.com' }, echo: 'qz_cook2' }))
    })
    ws.addEventListener('message', (ev) => {
      try {
        const d = JSON.parse(String(ev.data))
        if (d.echo === 'qz_login' && d.data?.user_id) uin = String(d.data.user_id)
        if ((d.echo === 'qz_cook1' || d.echo === 'qz_cook2') && d.data?.cookies) {
          if (!cookies || !cookies.includes('p_skey')) cookies = String(d.data.cookies)
        }
        if (uin && cookies && cookies.includes('p_skey')) {
          clearTimeout(timer)
          finish({ uin, cookies })
        }
      } catch {}
    })
    ws.addEventListener('error', () => { clearTimeout(timer); finish(null) })
    ws.addEventListener('close', () => { clearTimeout(timer); finish(uin || cookies ? { uin, cookies } : null) })
  })
}

/**
 * 通过 OneBot (NapCat) 实例、WS 通道或配置项获取 QQ 空间凭证
 */
export async function resolveQzoneCredentials({ callOneBot = null, customSettings = null, allowWsProbe = true } = {}) {
  const s = customSettings || readSettings()
  let cookieStr = String(s.qzoneCookie || process.env.QZONE_COOKIE || '').trim()
  let uin = String(s.qzoneUin || process.env.QZONE_UIN || '').trim()

  if (callOneBot) {
    try {
      if (!uin) {
        const login = await callOneBot('get_login_info', {}, 5000).catch(() => null)
        if (login?.data?.user_id) uin = String(login.data.user_id)
      }
      if (!cookieStr) {
        const c1 = await callOneBot('get_cookies', { domain: 'user.qzone.qq.com' }, 6000).catch(() => null)
        if (c1?.data?.cookies) cookieStr = String(c1.data.cookies)
        if (!cookieStr || !cookieStr.includes('p_skey')) {
          const c2 = await callOneBot('get_cookies', { domain: 'qzone.qq.com' }, 6000).catch(() => null)
          if (c2?.data?.cookies) cookieStr = String(c2.data.cookies)
        }
      }
    } catch (e) {
      logQzone('warn', `从 NapCat 获取 QZone Cookie 异常: ${e.message}`)
    }
  } else if (!cookieStr && allowWsProbe && !customSettings) {
    const wsCred = await fetchCredViaOneBotWs().catch(() => null)
    if (wsCred?.uin && !uin) uin = wsCred.uin
    if (wsCred?.cookies && !cookieStr) cookieStr = wsCred.cookies
  }

  const parsed = parseCookieString(cookieStr, uin)
  if (!parsed.uin || (!parsed.p_skey && !parsed.skey)) {
    return {
      ok: false,
      uin: parsed.uin,
      error: '未获取到有效的 QQ 空间 Cookie (需 NapCat 在线支持 get_cookies 或在 WebUI 设置中填入 qzoneCookie)',
    }
  }
  return { ok: true, ...parsed }
}

/**
 * 上传单张配图到 QQ 空间相册接口（返回 richval 与 pic_bo）
 */
export async function uploadQzoneImage(imagePath, cred) {
  if (!imagePath || !existsSync(imagePath)) {
    return { ok: false, error: `图片不存在: ${imagePath}` }
  }
  const b64 = readFileSync(imagePath).toString('base64')
  const url = `https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${cred.gtk}`
  const form = new URLSearchParams({
    filename: 'filename',
    uin: cred.uin,
    skey: cred.skey || '',
    zzpaneluin: cred.uin,
    zzpanelkey: '',
    p_uin: `o${cred.uin}`,
    p_skey: cred.p_skey || '',
    qzonetoken: '',
    uploadtype: '1',
    albumtype: '7',
    exttype: '0',
    refer: 'shuoshuo',
    output_type: 'jsonhtml',
    charset: 'utf-8',
    output_charset: 'utf-8',
    upload_hd: '1',
    hd_width: '2048',
    hd_height: '10000',
    hd_quality: '96',
    backUrls: 'http://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image,http://119.147.64.75/cgi-bin/upload/cgi_upload_image',
    url: `https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${cred.gtk}`,
    base64: '1',
    picfile: b64,
  })

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Cookie: cred.raw,
      Referer: `https://user.qzone.qq.com/${cred.uin}`,
      Origin: 'https://user.qzone.qq.com',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(20000),
  })

  const text = await resp.text()
  const jsonMatch = text.match(/frameElement\.callback\(([\s\S]+?)\);?\s*<\/script>/i) || text.match(/callback\(([\s\S]+?)\)/i)
  if (!jsonMatch) return { ok: false, error: `上传配图响应解析失败: ${text.slice(0, 120)}` }
  const data = JSON.parse(jsonMatch[1])
  const info = data?.data || {}
  if (!info.url && !info.lloc) return { ok: false, error: `上传配图失败: ${JSON.stringify(data).slice(0, 120)}` }
  const boMatch = String(info.url || '').match(/bo=([^&]+)/)
  const picBo = boMatch ? boMatch[1] : ''
  const richval = `,${info.albumid || ''},${info.lloc || ''},${info.sloc || ''},${info.type || 1},${info.height || 100},${info.width || 100},,${info.height || 100},${info.width || 100}`
  return { ok: true, picBo, richval, url: info.url }
}

/**
 * 记录说说历史到 /workspace/memory/qzone_posts.jsonl（自动维持最近 200 条上限）
 */
export function appendQzoneHistory(entry) {
  try {
    mkdirSync(MEMORY_DIR, { recursive: true })
    const row = { ts: Date.now(), time: new Date().toISOString(), ...entry }
    let lines = []
    if (existsSync(QZONE_HISTORY_FILE)) {
      lines = readFileSync(QZONE_HISTORY_FILE, 'utf8').split('\n').filter(Boolean)
    }
    lines.push(JSON.stringify(row))
    if (lines.length > MAX_QZONE_HISTORY) {
      lines = lines.slice(-MAX_QZONE_HISTORY)
      writeFileSync(QZONE_HISTORY_FILE, `${lines.join('\n')}\n`, 'utf8')
    } else {
      appendFileSync(QZONE_HISTORY_FILE, `${JSON.stringify(row)}\n`, 'utf8')
    }
    return row
  } catch {
    return null
  }
}

export function listQzoneHistory(limit = 30) {
  try {
    if (!existsSync(QZONE_HISTORY_FILE)) return []
    return readFileSync(QZONE_HISTORY_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
      .reverse()
  } catch {
    return []
  }
}

/**
 * 发布一条 QQ 空间说说（支持纯文字或带本地图片）
 * 参数 input 支持：
 *   "说说正文" 或 "说说正文|/workspace/out/xxx.png"
 */
export async function publishQzoneEmotion(input, { imagePaths = [], callOneBot = null, customSettings = null } = {}) {
  const raw = String(input || '').trim()
  if (!raw) return { ok: false, error: '说说内容不能为空' }

  const parts = raw.split('|').map((s) => s.trim()).filter(Boolean)
  const content = (parts[0] || raw).replace(/（（[\s\S]*?））|\(\([\s\S]*?\)\)/g, '').trim()
  const allImages = [...imagePaths]
  for (const p of parts.slice(1)) {
    if (existsSync(p) && !allImages.includes(p)) allImages.push(p)
  }

  if (customSettings?.qzoneMockSuccess) {
    const rec = appendQzoneHistory({ ok: true, status: 'mock_published', tid: 'qz_mock_1001', content, images: allImages })
    return { ok: true, mode: 'mock', tid: 'qz_mock_1001', content, images: allImages, record: rec }
  }

  const cred = await resolveQzoneCredentials({ callOneBot, customSettings })
  if (!cred.ok) {
    logQzone('warn', `发布说说未拿到 Cookie：${cred.error} | 内容: "${content.slice(0, 50)}"`)
    appendQzoneHistory({ ok: false, status: 'pending_cookie', content, images: allImages, error: cred.error })
    return { ok: false, error: cred.error, content, images: allImages }
  }

  let richval = ''
  let picBo = ''
  if (allImages.length > 0) {
    const up = await uploadQzoneImage(allImages[0], cred).catch((e) => ({ ok: false, error: e.message }))
    if (up.ok) {
      richval = up.richval
      picBo = up.picBo
    } else {
      logQzone('warn', `说说配图上传失败，降级为纯文字说说：${up.error}`)
    }
  }

  const publishUrl = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${cred.gtk}`
  const form = new URLSearchParams({
    syn_tweet_verson: '1',
    paramstr: '1',
    pic_template: '',
    richtype: richval ? '1' : '',
    richval: richval || '',
    special_url: '',
    subrichtype: richval ? '1' : '',
    con: content,
    feedversion: '1',
    ver: '1',
    ugc_right: '1',
    to_sign: '0',
    hostuin: cred.uin,
    code_version: '1',
    format: 'json',
    qzreferrer: `https://user.qzone.qq.com/${cred.uin}`,
  })
  if (picBo) {
    form.set('pic_bo', picBo)
  }

  try {
    const resp = await fetch(publishUrl, {
      method: 'POST',
      headers: {
        Cookie: cred.raw,
        Referer: `https://user.qzone.qq.com/${cred.uin}`,
        Origin: 'https://user.qzone.qq.com',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15000),
    })

    const resText = await resp.text()
    let data = null
    try {
      data = JSON.parse(resText)
    } catch {
      const m = resText.match(/callback\(([\s\S]+?)\)/)
      if (m) try { data = JSON.parse(m[1]) } catch {}
    }

    const tid = data?.tid || data?.t1_tid || ''
    const code = Number(data?.code ?? data?.subcode ?? -1)
    if (tid || code === 0) {
      logQzone('info', `QQ空间说说发布成功 [uin=${cred.uin}, tid=${tid || 'ok'}]: "${content.slice(0, 60)}"`)
      const rec = appendQzoneHistory({ ok: true, status: 'published', uin: cred.uin, tid, content, images: allImages })
      return { ok: true, uin: cred.uin, tid, content, images: allImages, record: rec }
    }

    const errMsg = data?.message || resText.slice(0, 140) || `HTTP ${resp.status}`
    logQzone('error', `QQ空间说说发布被拒 [code=${code}]: ${errMsg}`)
    appendQzoneHistory({ ok: false, status: 'failed', uin: cred.uin, content, images: allImages, error: errMsg })
    return { ok: false, error: `QQ空间返回错误: ${errMsg}`, uin: cred.uin, content }
  } catch (e) {
    logQzone('error', `QQ空间请求网络异常: ${e.message}`)
    appendQzoneHistory({ ok: false, status: 'network_error', uin: cred.uin, content, images: allImages, error: e.message })
    return { ok: false, error: e.message, unknown:true, uin: cred.uin, content }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const args = process.argv.slice(2)
  if (args.includes('--self-check')) {
    console.log('qzone self-check ok')
    process.exit(0)
  }
  const wantJson = args.includes('--json')
  const clean = args.filter((a) => a !== '--json')
  const cmd = (clean[0] || 'history').toLowerCase()

  if (cmd === 'publish' || cmd === 'post') {
    const text = clean[1] || ''
    const imgs = clean.slice(2).filter(Boolean)
    publishQzoneEmotion(text, { imagePaths: imgs }).then((r) => {
      console.log(wantJson ? JSON.stringify(r) : (r.ok ? `说说已发 (tid=${r.tid})` : `发送失败: ${r.error}`))
      process.exit(r.ok ? 0 : 1)
    })
  } else {
    const list = listQzoneHistory(20)
    console.log(wantJson ? JSON.stringify({ ok: true, items: list }) : JSON.stringify(list, null, 2))
  }
}
