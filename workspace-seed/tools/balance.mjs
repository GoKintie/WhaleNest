#!/usr/bin/env node
// 查 DeepSeek 账户余额：node /workspace/tools/balance.mjs [--json]
// 数据源：GET https://api.deepseek.com/user/balance（需要 DEEPSEEK_API_KEY）

const asJson = process.argv.includes('--json')
const key = String(process.env.DEEPSEEK_API_KEY || '').trim()

if (!key) {
  console.log('没有 DEEPSEEK_API_KEY，查不了')
  process.exit(1)
}

try {
  const r = await fetch('https://api.deepseek.com/user/balance', {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    console.log(asJson ? JSON.stringify({ ok: false, error: `HTTP ${r.status}` }) : `查询失败：HTTP ${r.status}`)
    process.exit(1)
  }
  const i = (j.balance_infos || [])[0] || {}
  const total = Number(i.total_balance || 0)
  const granted = Number(i.granted_balance || 0)
  const topped = Number(i.topped_up_balance || 0)
  if (asJson) {
    console.log(JSON.stringify({ ok: true, available: !!j.is_available, currency: i.currency || 'CNY', total, granted, toppedUp: topped }))
  } else {
    const sym = i.currency === 'CNY' ? '¥' : ''
    console.log(`余额 ${sym}${total.toFixed(2)}（赠送 ${sym}${granted.toFixed(2)} / 充值 ${sym}${topped.toFixed(2)}）${j.is_available ? '' : ' · 账户不可用'}`)
  }
} catch (e) {
  console.log(asJson ? JSON.stringify({ ok: false, error: e.message }) : `查询失败：${e.message}`)
  process.exit(1)
}
