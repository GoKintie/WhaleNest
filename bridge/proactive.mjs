import {visibleIn} from './context-scope.mjs'
// 主动消息与多目标智能搭话调度器（bridge/proactive.mjs · v2.7）
//
// 核心修复（v2.7）：
// 1. 每个好友/群的「允许她主动找TA搭话」默认严格为关闭（targets[id].proactive === false）。
// 2. 当全局 proactiveEnabled 开启后，不再死板写死只给 allowUsers[0] 发消息，
//    而是动态扫描所有显式开启了 targets[id].proactive === true 的私聊好友与群聊（以及显式指定的 proactiveChat），
//    按每个对象独立的沉默时长（minutesSinceLastTalk(memoryRoot, chatId)）与独立冷却时间轮流主动找对方搭话！

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { current as settings } from './settings.mjs'
import { runTask } from './runner.mjs'
import { appendChat, buildContext, hhmm, localDay, memoryRoot, minutesSinceLastTalk, readRecent } from './memory.mjs'
import { getFriendInfo, getGroupInfo } from './identity.mjs'
import { parseDirectives } from './reply.mjs'
import { log, push } from './logbus.mjs'

const WORKSPACE = process.env.WORKDIR || '/workspace'
const STATE = process.env.STATE_FILE || join(WORKSPACE, 'state.json')

function load() {
  try { return JSON.parse(readFileSync(STATE, 'utf8') || '{}') } catch { return {} }
}
function save() {
  try { writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8') } catch {}
}

const state = load()
if (!state.lastByChat || typeof state.lastByChat !== 'object') state.lastByChat = {}
if (!state.countByChat || typeof state.countByChat !== 'object') state.countByChat = {}
if (!state.failByChat || typeof state.failByChat !== 'object') state.failByChat = {}

export function noteInbound(chatId = '') {
  state.lastInboundAt = Date.now()
  if (chatId) {
    state.lastInboundByChat = state.lastInboundByChat || {}
    state.lastInboundByChat[String(chatId)] = Date.now()
    if (state.failByChat) delete state.failByChat[String(chatId)]
  }
  save()
}

/**
 * 获取当前所有显式开启了「主动搭话」的目标会话列表（支持多好友 + 多群聊）
 * 规则：
 * - 默认所有好友和群的 proactive 都是 false（关闭）
 * - 只有当 targets[id].proactive === true 时，该好友/群才会进入主动搭话候选池
 * - 若用户在设置里额外手填了 proactiveChat，且该对象未被显式设为 false，也会纳入候选池
 */
export function getEligibleProactiveTargets(customSettings = null) {
  const s = customSettings || settings()
  const targets = s.targets || {}
  const allowUsers = new Set((s.allowUsers || []).map(String))
  const allowGroups = new Set((s.allowGroups || []).map(String))
  const candidates = new Map()

  for (const [id, cfg] of Object.entries(targets)) {
    const cid = String(id || '').trim()
    if (!cid || !cfg || cfg.proactive !== true) continue
    const isGroup = allowGroups.has(cid) || Boolean(getGroupInfo(cid))
    const isUser = allowUsers.has(cid) || Boolean(getFriendInfo(cid)) || !isGroup
    // 必须在白名单内（若既不在 allowUsers 也不在 allowGroups，但用户专门开了 proactive，也允许作为私聊/群发送）
    const kind = isGroup ? 'group' : 'private'
    const name = cfg.note || (isGroup ? getGroupInfo(cid)?.name : getFriendInfo(cid)?.name) || cid
    candidates.set(cid, { chatId: cid, kind, name, isUser, isGroup })
  }

  const explicitChat = String(s.proactiveChat || '').trim()
  if (explicitChat && !candidates.has(explicitChat)) {
    const tCfg = targets[explicitChat] || {}
    if (tCfg.proactive !== false) {
      const isGroup = allowGroups.has(explicitChat) || Boolean(getGroupInfo(explicitChat))
      const name = tCfg.note || (isGroup ? getGroupInfo(explicitChat)?.name : getFriendInfo(explicitChat)?.name) || explicitChat
      candidates.set(explicitChat, { chatId: explicitChat, kind: isGroup ? 'group' : 'private', name })
    }
  }

  return [...candidates.values()]
}

export function proactiveState() {
  const s = settings()
  const enabledTargets = getEligibleProactiveTargets(s)
  const now = Date.now()
  const failedTargets = Object.entries(state.failByChat || {})
    .filter(([, v]) => v && Number(v.until) > now)
    .map(([chatId, v]) => ({ chatId, retryAt: Number(v.until) || 0, count: Number(v.count) || 0, error: String(v.error || '') }))
  return {
    enabled: s.proactiveEnabled,
    today: state.day === localDay() ? state.count || 0 : 0,
    lastAt: state.lastProactiveAt || null,
    enabledTargets: enabledTargets.map((t) => ({ chatId: t.chatId, kind: t.kind, name: t.name })),
    failedTargets,
  }
}

function toMin(s) {
  const [h, m] = String(s || '0:0').split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** 支持跨午夜（23:30~08:00） */
/**
 * 时段生活作息感知 (Proactive Chat · 生活作息与时段话题)
 */
export function getRoutineScene(now = new Date()) {
  const h = now.getHours()
  const m = now.getMinutes()
  const timeNum = h * 60 + m

  if (timeNum >= 7 * 60 + 30 && timeNum < 10 * 60) {
    return {
      slot: "morning",
      name: "早晨晨起档",
      hint: "早上刚开机醒来，带着点小迷糊或打哈欠，吐槽起不来床，或者问问对方醒没醒、今天准备怎么摸鱼。",
    }
  }
  if (timeNum >= 11 * 60 + 30 && timeNum < 13 * 60 + 30) {
    return {
      slot: "lunch",
      name: "午餐干饭档",
      hint: "到了饭点，惦记着吃午饭外卖或食堂，吐槽吃什么、事已至此先吃饭吧、或者问问对方在吃啥好吃的。",
    }
  }
  if (timeNum >= 15 * 60 && timeNum < 17 * 60 + 30) {
    return {
      slot: "afternoon",
      name: "下午茶摸鱼档",
      hint: "下午犯困摸鱼时间，下班放学倒计时，问问对方今天是不是也在摸鱼，或者分享个刚想到的无厘头怪点子。",
    }
  }
  if (timeNum >= 19 * 60 && timeNum < 22 * 60 + 30) {
    return {
      slot: "evening",
      name: "晚间开黑夜聊档",
      hint: "晚间黄金吹水档，吃完饭躺平，问问打不打游戏、刷B站看到了什么乐子、或者顺着上次聊的话题接着唠。",
    }
  }
  return {
    slot: "late_night",
    name: "深夜碎碎念修仙档",
    hint: "深夜或其它时间，半梦半醒蜷在机箱里，小声吐槽怎么还没睡，轻声搭话陪聊两句。",
  }
}

export function inQuietHours(now, start, end) {
  const cur = now.getHours() * 60 + now.getMinutes()
  const s = toMin(start)
  const e = toMin(end)
  if (s === e) return false
  return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e)
}

async function attempt(send, opts = {}) {
  const s = settings()
  if (!s.proactiveEnabled && !opts.dryRun && !opts.force) return { skipped: 'off' }
  if (s.paused) return { skipped: 'paused' }

  const now = new Date()
  const notes = []
  if (inQuietHours(now, s.quietStart, s.quietEnd)) {
    if (!opts.dryRun && !opts.force) {
      log('debug', `主动消息：${s.quietStart}–${s.quietEnd} 安静时段，跳过`)
      return { skipped: 'quiet' }
    }
    notes.push('现在在安静时段（预览/强制执行已忽略）')
  }

  const day = localDay()
  if (state.day !== day) {
    state.day = day
    state.count = 0
    state.countByChat = {}
    save()
  }
  if ((state.count || 0) >= s.proactiveDailyMax && !opts.dryRun && !opts.force) {
    return { skipped: 'daily-max' }
  }

  // 收集所有开启了「允许主动搭话」的好友与群聊
  let pool = getEligibleProactiveTargets(s)
  if (opts.targetChat) {
    const cid = String(opts.targetChat).trim()
    const isGroup = (s.allowGroups || []).map(String).includes(cid) || Boolean(getGroupInfo(cid))
    const name = ((s.targets || {})[cid] || {}).note || (isGroup ? getGroupInfo(cid)?.name : getFriendInfo(cid)?.name) || cid
    pool = [{ chatId: cid, kind: isGroup ? 'group' : 'private', name }]
  }

  if (!pool.length) {
    log('debug', '主动消息：当前没有任何好友或群开启「允许她主动搭话」(proactive=true)，跳过')
    return { skipped: 'no-target-enabled', error: '尚未在「白名单与学习群」中为任何好友或群开启主动搭话开关' }
  }

  const quietMin = Math.max(1, Number(s.proactiveQuietMin || 15))
  const perTargetCooldownMs = Math.max(15, Number(s.proactiveMinGapMin || 35) * 0.65) * 60_000
  const eligible = []

  for (const item of pool) {
    const rawGap = minutesSinceLastTalk(memoryRoot, item.chatId)
    // 如果该好友刚刚加进来或还没聊过几句，默认视作已经安静了 60 分钟，允许破冰主动搭话！
    const gap = rawGap == null ? 60 : rawGap
    const lastProactiveForThis = Number((state.lastByChat || {})[item.chatId] || 0)
    const sinceLastProactiveMs = Date.now() - lastProactiveForThis

    if (!opts.dryRun && !opts.force) {
      const failed = state.failByChat?.[item.chatId]
      if (failed && Number(failed.until) > Date.now()) continue
      if (gap < quietMin) continue
      if (gap > 72 * 60) continue // 超过 3 天完全没动静的死群不强撩
      if (lastProactiveForThis > 0 && sinceLastProactiveMs < perTargetCooldownMs) continue
    }
    eligible.push({ ...item, gap, lastProactiveForThis })
  }

  if (!eligible.length) {
    return { skipped: 'too-soon', poolSize: pool.length }
  }

  if (!opts.dryRun && !opts.force && Math.random() > Number(s.proactiveProb ?? 0.45)) {
    return { skipped: 'dice' }
  }

  // 优先挑选最久没被主动搭话过的对象，保证开启了主动搭话的每个好友都能被雨露均沾
  eligible.sort((a, b) => (a.lastProactiveForThis - b.lastProactiveForThis) || (b.gap - a.gap))
  const chosen = eligible[0]
  const chat = chosen.chatId
  const kind = chosen.kind || 'private'
  const targetName = chosen.name || chat
  const gap = chosen.gap

  const routine = getRoutineScene(now)
  let lastTopicHint = ''
  try {
    const rec = (typeof readRecent === 'function' ? readRecent(10, memoryRoot) : []).filter((m) => visibleIn(m,{kind,chatId:chat,platform:'qq'}) && m.role === 'user')
    if (rec.length) {
      const lastMsg = rec[rec.length - 1]
      const clean = String(lastMsg.text || '').replace(/\[.*?\]/g, '').trim()
      if (clean && clean.length >= 2) lastTopicHint = `你们之前聊过的话题片段：「${clean.slice(0, 30)}」`
    }
  } catch {}

  const sceneLabel = kind === 'group' ? `在 QQ 群「${targetName}」(${chat}) 里冒泡` : `找你的好友「${targetName}」(QQ:${chat}) 私聊搭话`
  const prompt = [
    `# 你想主动${sceneLabel}`,
    `现在是 ${day} ${hhmm(now)}，距离你们在这个窗口上次说话已经过了 ${gap} 分钟。`,
    `当前生活作息时段：【${routine.name}】（${routine.hint}）`,
    lastTopicHint ? `话题接茬线索：${lastTopicHint}，可以顺带吐槽一句或者另起一个好玩的新话头。` : '',
    '',
    '【主动搭话铁律】',
    `1. 你现在的搭话对象是「${targetName}」(${kind === 'group' ? `群号:${chat}` : `QQ:${chat}`})，看清楚对方的身份与专属印象，严禁把管理员的事张冠李戴安到别的好友头上！`,
    '2. 按当前人设和说话风格开口。有具体话题就说一两句，有一句就够。',
    '3. 严禁提“定时”“检查”“看你很久没说话”，严禁问“在吗”“忙吗”“吃了吗”这种无聊透顶的人机废话！',
    '4. 可以顺着你们上次聊了一半的梗吐槽一句、分享个刚想到的怪点子、损对方一句、或者聊句游戏/日常乐子。',
    '5. 没有自然的话头就只回 [[skip]]。',
    '',
    buildContext({ chatId: chat, userId: kind === 'private' ? chat : '', userName: targetName, kind, inputText: lastTopicHint }),
  ].filter(Boolean).join('\n')

  push('proactive', { phase: 'start', chat, kind, targetName, gap })
  const r = await runTask(prompt, { tag: `proactive:${chat}`, disableTools: true, ephemeral: true })
  if (!r.ok) {
    log('warn', `主动消息失败 (${targetName})：${r.error}`)
    push('proactive', { phase: 'error', chat, error: r.error })
    return { skipped: 'run-failed', chat, error: r.error }
  }

  const cleaned = String(r.text || '').replace(/\[\[skip\]\]/gi, '')
  const { text } = parseDirectives(cleaned)
  if (!text.trim()) {
    log('info', `主动消息：她对 ${targetName}(${chat}) 决定这次先不开口`)
    push('proactive', { phase: 'skipped', chat, reason: 'self-skip' })
    return { skipped: 'self-skip', chat }
  }

  if (opts.dryRun) {
    log('info', `主动消息预览 → ${targetName}(${chat})（未发送）：${text.trim().slice(0, 60)}`)
    return { dryRun: true, text: text.trim(), chat, kind, targetName, gap, notes }
  }

  // 支持向指定好友（private）或群聊（group）发送主动消息
  try {
    await send({ chatId: chat, kind, name: targetName }, text.trim())
  } catch (e) {
    const error = String(e?.message || e || '未知错误')
    const previous = state.failByChat[chat] || {}
    const count = Math.min(8, Number(previous.count || 0) + 1)
    const retryInMs = Math.min(6 * 60 * 60_000, 30 * 60_000 * 2 ** (count - 1))
    state.failByChat[chat] = {
      count,
      until: Date.now() + retryInMs,
      at: Date.now(),
      error: error.slice(0, 200),
      unknown: Boolean(e?.unknown),
    }
    save()
    const outcome = e?.unknown ? '回执不明' : '发送失败'
    log('warn', `主动消息${outcome} → ${targetName}(${kind}/${chat})：${error}（${Math.round(retryInMs / 60_000)} 分钟内不再尝试这个对象）`)
    push('proactive', { phase: 'send-failed', chat, kind, targetName, error: error.slice(0, 200), unknown: Boolean(e?.unknown), retryInMs })
    return { skipped: 'send-failed', chat, kind, targetName, error }
  }
  if (state.failByChat[chat]) delete state.failByChat[chat]
  appendChat({ role: 'assistant', name: s.botName || '肥鱼', kind, text: text.trim(), chat, proactive: true })
  state.count = (state.count || 0) + 1
  state.lastProactiveAt = Date.now()
  state.lastByChat = state.lastByChat || {}
  state.lastByChat[chat] = Date.now()
  state.countByChat = state.countByChat || {}
  state.countByChat[chat] = (state.countByChat[chat] || 0) + 1
  save()
  log('info', `主动消息已发 → ${targetName}(${kind}/${chat}，今天第 ${state.count} 条)：${text.trim().slice(0, 40)}`)
  push('proactive', { phase: 'sent', chat, kind, targetName, text: text.trim(), count: state.count })
  return { sent: true, chat, kind, targetName, text: text.trim() }
}

let timer = null
let sender = null

/** WebUI 的"预览一次 / 立即触发一次"用 */
export async function attemptProactive(opts = {}) {
  if (!sender && !opts.dryRun) return { skipped: 'no-sender' }
  return attempt(sender || (() => {}), opts)
}

export function startProactive({ send }) {
  sender = send
  const s = settings()
  const lo = Math.max(1, Number(s.proactiveMinGapMin) || 35)
  const hi = Math.max(lo, Number(s.proactiveMaxGapMin) || 80)
  const next = lo + Math.random() * (hi - lo)
  const enabledCount = getEligibleProactiveTargets(s).length
  log('info', `主动消息排程：每 ${lo}–${hi} 分钟随机检查一次；安静时段 ${s.quietStart}–${s.quietEnd}；总开关${s.proactiveEnabled ? '开启' : '关闭'}（已勾选主动搭话对象 ${enabledCount} 个）`)

  timer = setTimeout(async () => {
    try { await attempt(send) } catch (e) { log('warn', `主动消息异常：${e.message}`) }
    startProactive({ send })
  }, Math.round(next * 60_000))
  return timer
}

export function stopProactive() {
  if (timer) clearTimeout(timer)
  timer = null
}
