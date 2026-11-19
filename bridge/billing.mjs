// DeepSeek 账户余额查询（60 秒缓存，避免每次开设置页都打接口）
// 接口：GET https://api.deepseek.com/user/balance
//   { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }

import { current as settings } from './settings.mjs'

const API = 'https://api.deepseek.com/user/balance'

let cache = { at: 0, data: null }

export async function getBalance(force = false) {
  if (!force && cache.data && Date.now() - cache.at < 60_000) return cache.data

  const s = settings()
  const key = String(s?.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '').trim()
  if (!key) return { ok: false, error: '未配置 DEEPSEEK_API_KEY' }

  try {
    const r = await fetch(API, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      return { ok: false, error: `HTTP ${r.status}${j?.error?.message ? ' ' + j.error.message : ''}` }
    }
    const info = (Array.isArray(j.balance_infos) ? j.balance_infos[0] : null) || {}
    const data = {
      ok: true,
      available: !!j.is_available,
      currency: String(info.currency || 'CNY'),
      total: Number(info.total_balance || 0),
      granted: Number(info.granted_balance || 0),
      toppedUp: Number(info.topped_up_balance || 0),
      at: Date.now(),
    }
    cache = { at: Date.now(), data }
    return data
  } catch (e) {
    const msg = e?.name === 'TimeoutError' ? '请求超时（10s）' : (e?.message || String(e))
    return { ok: false, error: msg }
  }
}
