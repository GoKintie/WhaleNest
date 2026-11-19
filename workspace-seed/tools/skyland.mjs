#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve as _resolvePath } from 'node:path'
// 森空岛（明日方舟 & 终末地）自动签到与角色状态脚本（/workspace/tools/skyland.mjs）
// 作为独立附带脚本运行，不耦合主程序，支持命令行直接调用或由肥鱼在对话中自动触发回答。
//
// 用法：
//   node /workspace/tools/skyland.mjs status              # 查看今日签到状态与历史记录
//   node /workspace/tools/skyland.mjs sign                # 立即执行森空岛每日签到
//   node /workspace/tools/skyland.mjs set-token <TOKEN>   # 保存鹰角通行证 OAuth Token (24位字符串) 或 Cred
//   node /workspace/tools/skyland.mjs --json sign         # 输出 JSON 结构供程序解析

import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readSettings, readToolCredentials, writeToolCredentials } from './settings-reader.mjs'

const WORKSPACE = process.env.WORKDIR || '/workspace'
const CONFIG_FILE = process.env.SKYLAND_CONFIG || join(WORKSPACE, 'memory', 'skyland_config.json')
const LOG_FILE = process.env.SKYLAND_LOG || join(WORKSPACE, 'memory', 'skyland_log.json')

const APP_CODE = '4ca99fa6b56cc2ba'
const USER_AGENT = 'Skland/1.21.0 (com.hypergryph.skland; build:102100065; Android 33; ) OkHttp/4.11.0'

function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function loadSkylandConfig() {
  if (existsSync(CONFIG_FILE)) return readToolCredentials(CONFIG_FILE)
  return {
    token: process.env.SKYLAND_TOKEN || '',
    cred: process.env.SKYLAND_CRED || '',
    signToken: process.env.SKYLAND_SIGN_TOKEN || '',
    autoSignDaily: true,
    updatedAt: null,
  }
}

export function saveSkylandConfig(patch = {}) {
  const cur = loadSkylandConfig()
  const next = { ...cur, ...patch, updatedAt: Date.now() }
  writeToolCredentials(CONFIG_FILE,next)
  return next
}

export function loadSkylandLog() {
  try {
    if (existsSync(LOG_FILE)) {
      return JSON.parse(readFileSync(LOG_FILE, 'utf8') || '{"history":[]}')
    }
  } catch {}
  return { lastSignDay: '', lastResult: null, history: [] }
}

function saveSkylandLog(entry) {
  const log = loadSkylandLog()
  log.lastSignDay = entry.day || localDay()
  log.lastResult = entry
  log.history = [entry, ...(Array.isArray(log.history) ? log.history : [])].slice(0, 30)
  mkdirSync(dirname(LOG_FILE), { recursive: true })
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2), 'utf8')
  return log
}

/**
 * 森空岛 Zonai 接口签名算法：
 * sign = MD5( HMAC_SHA256( path + query_or_body + timestamp + header_json, signToken ).toHex() )
 */
export function computeZonaiSign(path, queryOrBody, timestamp, signToken, platform = '1', vName = '1.21.0', dId = 'dsh-feiyu-aid') {
  const headerObj = {
    platform,
    timestamp: String(timestamp),
    dId,
    vName,
  }
  const headerStr = JSON.stringify(headerObj)
  const raw = `${path}${queryOrBody || ''}${timestamp}${headerStr}`
  const hmacHex = createHmac('sha256', String(signToken || '')).update(raw, 'utf8').digest('hex')
  const sign = createHash('md5').update(hmacHex, 'utf8').digest('hex')
  return { sign, headerObj }
}

async function exchangeTokenForCred(oauthToken, fetchFn = globalThis.fetch) {
  // 1. OAuth token -> grant code
  const r1 = await fetchFn('https://as.hypergryph.com/user/oauth2/v2/grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ appCode: APP_CODE, token: oauthToken, type: 0 }),
  })
  const d1 = await r1.json().catch(() => ({}))
  if (d1.status !== 0 || !d1.data?.code) {
    throw new Error(`鹰角通行证授权失败：${d1.msg || d1.message || JSON.stringify(d1)}`)
  }

  // 2. grant code -> cred + token
  const r2 = await fetchFn('https://zonai.skland.com/api/v1/user/auth/generate_cred_by_code', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ code: d1.data.code, kind: 1 }),
  })
  const d2 = await r2.json().catch(() => ({}))
  if (d2.code !== 0 || !d2.data?.cred) {
    throw new Error(`森空岛凭证换取失败：${d2.message || JSON.stringify(d2)}`)
  }
  return {
    cred: d2.data.cred,
    signToken: d2.data.token || '',
    userId: d2.data.userId || '',
  }
}

async function callZonaiApi(method, path, { query = '', body = null, cred, signToken, fetchFn = globalThis.fetch }) {
  const ts = Math.floor(Date.now() / 1000)
  const bodyStr = body ? JSON.stringify(body) : ''
  const payloadForSign = method === 'GET' ? query : bodyStr
  const { sign, headerObj } = computeZonaiSign(path, payloadForSign, ts, signToken)

  const url = `https://zonai.skland.com${path}${query ? `?${query}` : ''}`
  const headers = {
    'user-agent': USER_AGENT,
    'accept-encoding': 'gzip',
    'content-type': 'application/json',
    cred,
    ...headerObj,
  }
  if (signToken) headers.sign = sign

  const res = await fetchFn(url, {
    method,
    headers,
    body: method === 'POST' ? bodyStr : undefined,
  })
  return res.json().catch(() => ({}))
}

export async function runSkylandAttendance(opts = {}) {
  const cfg = loadSkylandConfig()
  const rawToken = String(opts.token ?? cfg.token ?? '').trim()
  let cred = String(opts.cred ?? cfg.cred ?? '').trim()
  let signToken = String(opts.signToken ?? cfg.signToken ?? '').trim()
  const fetchFn = opts.fetchFn || globalThis.fetch
  const today = localDay()

  if (!rawToken && !cred) {
    return {
      ok: false,
      needConfig: true,
      day: today,
      summary: '还没有配置森空岛 Token。可以在 WebUI「设置与插件 → 放权与扩展」里填入鹰角通行证 Token，或者直接对我说：设置森空岛token 你的24位Token',
    }
  }

  try {
    // 若用户把 32 位 cred 直接填进了 token 字段，自动识别
    if (rawToken && !cred && rawToken.length >= 28 && !rawToken.includes(' ')) {
      if (rawToken.length === 24) {
        const ex = await exchangeTokenForCred(rawToken, fetchFn)
        cred = ex.cred
        signToken = ex.signToken
        saveSkylandConfig({ cred, signToken })
      } else {
        cred = rawToken
      }
    } else if (rawToken && (!cred || !signToken)) {
      const ex = await exchangeTokenForCred(rawToken, fetchFn)
      cred = ex.cred
      signToken = ex.signToken
      saveSkylandConfig({ cred, signToken })
    }

    // 获取绑定角色列表
    let bindingRes = await callZonaiApi('GET', '/api/v1/game/player/binding', { cred, signToken, fetchFn })
    if (bindingRes.code === 10001 && rawToken) {
      // cred 过期，使用 oauthToken 重新刷新
      const ex = await exchangeTokenForCred(rawToken, fetchFn)
      cred = ex.cred
      signToken = ex.signToken
      saveSkylandConfig({ cred, signToken })
      bindingRes = await callZonaiApi('GET', '/api/v1/game/player/binding', { cred, signToken, fetchFn })
    }

    if (bindingRes.code !== 0) {
      return {
        ok: false,
        day: today,
        error: bindingRes.message || `获取森空岛绑定角色失败 (code=${bindingRes.code})`,
        summary: `森空岛接口返回错误：${bindingRes.message || '凭证失效，请更新 Token'}`,
      }
    }

    const appList = bindingRes.data?.list || []
    const characters = []
    for (const app of appList) {
      if (app.appCode === 'arknights' || app.appCode === 'endfield') {
        for (const b of (app.bindingList || [])) {
          characters.push({
            appCode: app.appCode,
            appName: app.appName || (app.appCode === 'arknights' ? '明日方舟' : '终末地'),
            uid: b.uid,
            nickName: b.nickName || b.uid,
            channelName: b.channelName || '官服',
            gameId: b.gameId || (app.appCode === 'arknights' ? 1 : 3),
          })
        }
      }
    }

    if (!characters.length) {
      return {
        ok: false,
        day: today,
        error: '账号下未找到绑定的明日方舟或终末地角色',
        summary: '你的森空岛账号下没查到绑定的方舟角色，去森空岛 App 绑定一下角色再试',
      }
    }

    const results = []
    for (const ch of characters) {
      const attPath = ch.appCode === 'endfield' ? '/api/v1/game/endfield/attendance' : '/api/v1/game/attendance'
      const attRes = await callZonaiApi('POST', attPath, {
        body: { uid: String(ch.uid), gameId: Number(ch.gameId || 1) },
        cred,
        signToken,
        fetchFn,
      })
      if (attRes.code === 0) {
        const awards = (attRes.data?.awards || []).map((a) => `${a.resource?.name || '奖励'}×${a.count || 1}`).join('、') || '签到奖励已入账'
        results.push({
          ...ch,
          status: 'signed',
          awards,
          line: `【${ch.appName}】${ch.nickName}(${ch.channelName})：签到成功，拿到 ${awards}`,
        })
      } else if (attRes.code === 10001 || /已签到|请勿重复|already/i.test(attRes.message || '')) {
        results.push({
          ...ch,
          status: 'already_signed',
          awards: '',
          line: `【${ch.appName}】${ch.nickName}(${ch.channelName})：今天已经签过到了`,
        })
      } else {
        results.push({
          ...ch,
          status: 'error',
          error: attRes.message || `code ${attRes.code}`,
          line: `【${ch.appName}】${ch.nickName}(${ch.channelName})：${attRes.message || `签到异常(${attRes.code})`}`,
        })
      }
    }

    const record = {
      ok: true,
      day: today,
      ts: Date.now(),
      results,
      summary: results.map((r) => r.line).join('\n'),
    }
    saveSkylandLog(record)
    return record
  } catch (e) {
    return {
      ok: false,
      day: today,
      error: e.message || String(e),
      summary: `森空岛签到失败：${e.message || e}`,
    }
  }
}

export function getSkylandStatus() {
  const cfg = loadSkylandConfig()
  const log = loadSkylandLog()
  const today = localDay()
  const hasToken = Boolean(cfg.token || cfg.cred)
  const signedToday = log.lastSignDay === today && log.lastResult?.ok
  return {
    ok: true,
    hasToken,
    today,
    signedToday,
    lastSignDay: log.lastSignDay || '从未签到',
    lastResult: log.lastResult || null,
    historyCount: (log.history || []).length,
    summary: !hasToken
      ? '尚未配置森空岛 Token（可在 WebUI「设置与插件 → 放权与扩展」中填入，或发“设置森空岛token 你的token”）'
      : signedToday
        ? `今天（${today}）已经签过到啦：\n${log.lastResult?.summary || ''}`
        : `今天（${today}）还没签到（上次签到：${log.lastSignDay || '无'}）`,
  }
}

// CLI 入口
if (process.argv[1] && import.meta.url === pathToFileURL(_resolvePath(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const wantJson = args.includes('--json')
  const cleanArgs = args.filter((a) => a !== '--json')
  const cmd = cleanArgs[0] || 'status'

  ;(async () => {
    if ((cmd === 'set-token' && cleanArgs[1]) || cmd === 'set-from-settings') {
      const val = String(cmd === 'set-from-settings' ? readSettings().skylandToken || '' : cleanArgs[1]).trim()
      if (!val) {
        saveSkylandConfig({token:'',cred:'',signToken:''})
        console.log(wantJson ? JSON.stringify({ok:true}) : '森空岛凭证已清除')
        return
      }
      if (val.length === 24) saveSkylandConfig({ token: val, cred: '', signToken: '' })
      else saveSkylandConfig({ cred: val })
      const out = { ok: true, message: '森空岛凭证已保存，立即尝试首次签到…' }
      const signRes = await runSkylandAttendance()
      if (wantJson) console.log(JSON.stringify({ ...out, signRes }))
      else console.log(`${out.message}\n${signRes.summary}`)
      return
    }
    if (cmd === 'sign') {
      const res = await runSkylandAttendance()
      if (wantJson) console.log(JSON.stringify(res))
      else console.log(res.summary)
      return
    }
    const st = getSkylandStatus()
    if (wantJson) console.log(JSON.stringify(st))
    else console.log(st.summary)
  })()
}
