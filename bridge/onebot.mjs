import {migrateLegacySessions} from './session-migration.mjs'
import {canSendResource} from './resource-policy.mjs'
import {activeWebToken,signedMediaQuery} from './web-auth.mjs'
import {conversationKey,visibleIn} from './context-scope.mjs'
import {scheduleGroupLearning} from './group-learning.mjs'
import {participantKey,sameParticipant,createFollowUpState,matchFollowUp,isPendingContinuation as pendingContinuation,debounceDelay} from './conversation-flow.mjs'
import {authorizeAction,DIRECTIVE_TOOL} from './action-policy.mjs'
import {resolveAuthorizedPath} from './permissions.mjs'
import {drainTasks,schedulerState} from './task-scheduler.mjs'
// dsh-onebot 主入口（bridge/onebot.mjs · v3.0）
//
// QQ( NapCat / OneBot v11 WS ) → 准入 → 智能防抖合流 → 按会话并发调度 → 统一 Agent 引擎（双渠道 + 工具）
//   → 去 AI 味整形 → 回到 QQ。
//
// 与 v2 的三处根本区别：
// 1. 调度：v2 是全局单 `busy` 锁 + 单队列，一个人刷 B 站能把所有群卡死；
//    v3 按会话分道（每道自己排队、同会话内串行合并，不同会话并发，全局最多 3 条并行）。
// 2. 能力：v2 靠一大坨正则在外面预取再塞 prompt，模型根本不知道系统会什么；
//    v3 把能力交给 tools.mjs 的注册表，模型自己调工具、拿真实结果再回答。
// 3. 上下文：v2 用 dsh sessionId 续跑；v3 由 runner 把会话历史按 chatId 持久化，换渠道/重启都不丢。

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { runTask, resetAgentSession, setModelFailureNotifier } from './runner.mjs'
import { flushAll, readJson, writeJsonSoon } from './store.mjs'
import {
  analyzeChatAtmosphere, analyzeCompleteness, buildTask, decide, dedupeActionsWithToolLog,
  estimateTypingDelay, evaluateGroupChimeIn, flattenForwardMessages, formatQuotedContext,
  formatSenderLabel, humanizeReply, isCompactCommand, looksLikeTask, mergeParsedBatch,
  parseEvent, splitReply,
} from './onebot-lib.mjs'
import {
  appendChat, appendDiary, appendHumanWorld, buildContext, buildTurnAnchor,
  ensureLayout, findConversationMeme, flushStyleStores, learnFromMessage, memoryRoot, readGroupImpression, readPersonImpression,
  readRecent, recordUsedExpressions, saveHandover,
} from './memory.mjs'
import { parseDirectives, toSegment } from './reply.mjs'
import { baseNameOf, fetchMedia } from './media.mjs'
import { current as settings, save as saveSettings, publicSettings } from './settings.mjs'
import { log, push } from './logbus.mjs'
import { invalidateContactsCache, startWeb } from './webui.mjs'
import { inQuietHours, noteInbound, proactiveState, startProactive } from './proactive.mjs'
import { startOrganizer } from './organize.mjs'
import { startDiary, writeImpressions } from './diary.mjs'
import {
  getFriendInfo, getGroupInfo, getSelf, groupAvatar, qlogo, setFriendInfo, setGroupInfo, setSelf,
  syncContactsDirectory,
} from './identity.mjs'
import {
  executeCrossWindowAction, executeMultimodalPlugin, initPlugins, maybeAttachSticker,
  noteStickerSent, pluginRegistryStatus, stealStickerIfEligible,
} from './plugins.mjs'
import { describeImagesForChat } from './vision.mjs'
import {renderAbilityCatalog,executeTool} from './tools.mjs'
import { bootstrapTreeFromHistory,treeStats,prepareTreeQuery } from './memory-tree.mjs'

const WS_URL = process.env.ONEBOT_WS || 'ws://127.0.0.1:3001'
const TOKEN = process.env.ONEBOT_TOKEN || ''
const ALLOW_ANYONE = process.env.ALLOW_ANYONE === 'true'
const WORKSPACE = process.env.WORKDIR || '/workspace'
const SESSIONS_FILE = process.env.SESSIONS_FILE || join(WORKSPACE, 'sessions.json')
const WEB_TOKEN=activeWebToken
const PUBLIC_BASE = process.env.PUBLIC_BASE || 'http://dsh-onebot:3081'
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_TASKS || 3))
const MAX_LANE_QUEUE = Math.max(1, Number(process.env.MAX_LANE_QUEUE || 4))

/**
 * NapCat 在另一个容器里，看不到 /workspace —— 本地上传会报 ENOENT。
 * 统一走 http://dsh-onebot:3081/api/raw 让 NapCat 自己来取（同 docker 网络）。
 */
function publicUrl(absPath) {
  const rel = String(absPath || '').replace(/^\/workspace\/?/, '')
  const q='/api/raw?'+signedMediaQuery(rel)
  return PUBLIC_BASE + q
}

let wsConnected = false
let nextSendSlot = 0
// 群聊活跃接茬窗口（gid -> until）
const activeGroupConvoUntil = new Map() // Display only; never grants admission.
const followUpStates=new Map()
const sentBotMessages=new Map()
let stopping=false

// ---------- 会话元数据（轮次/字符量，用于静默归档判定）----------
// v3.0.1：统一走 store.mjs（指纹缓存 + 原子写 + 延迟合并落盘），不再每次同步整文件读写
function loadSessions() {
  return readJson(SESSIONS_FILE, {}) || {}
}
function saveSessions(map) {
  writeJsonSoon(SESSIONS_FILE, map, 500)
}
migrateLegacySessions(WORKSPACE)
let sessions = loadSessions()

function sessionRecordFor(chatId) {
  const s = settings()
  if (!s.resumeSession) return null
  const rec = sessions[String(chatId)]
  if (!rec || !rec.id) return null
  if (rec.model && rec.model !== s.model) {
    log('info', `模型变了（${rec.model} → ${s.model}），沿用历史但换渠道继续`)
  }
  return rec
}

function rememberSession(chatId, stats = {}) {
  const key = String(chatId)
  const prev = sessions[key] || {}
  const usage = stats.usage || {}
  const tokens = Number(usage.total_tokens || usage.prompt_tokens || 0)
  const addedChars = Number(stats.promptChars || 0) + Number(stats.replyChars || 0)
  const rec = {
    id: key,
    model: settings().model,
    provider: stats.provider || prev.provider || '',
    createdAt: prev.createdAt || Date.now(),
    ts: Date.now(),
    turns: (prev.turns || 0) + 1,
    approxChars: (prev.approxChars || 0) + addedChars,
    lastTokens: tokens > 0 ? tokens : (prev.lastTokens || 0),
  }
  sessions[key] = rec
  saveSessions(sessions)
  return rec
}

function evaluateSessionHealth(rec) {
  if (!rec) return { ratio: 0, shouldCompact: false }
  const s = settings()
  const maxTurns = Math.max(4, Number(s.sessionMaxTurns || 12))
  const maxTokens = Math.max(8000, Number(s.sessionMaxTokens || 48000))
  const maxChars = Math.max(12000, Math.round(Number(s.contextChars || 36000) * 1.15))
  const ratio = Math.max(
    (rec.turns || 0) / maxTurns,
    rec.lastTokens ? rec.lastTokens / maxTokens : 0,
    (rec.approxChars || 0) / maxChars
  )
  return { ratio: Number(ratio.toFixed(2)), turns: rec.turns || 0, maxTurns, shouldCompact: ratio >= 1.0 }
}

const compacting = new Set()

async function compactAndHandoverSession(parsed, rec) {
  const lockKey=conversationKey(parsed)
  if (compacting.has(lockKey)) return { ok: false, skipped: 'compacting' }
  compacting.add(lockKey)
  try {
    const chatId = conversationKey(parsed)
    const recent = readRecent(120).filter(m=>m.scope===chatId).slice(-24)
    const recentLines = recent.map((m) => {
      const who = m.role === 'assistant' ? '【你刚才回】' : `【对方·${m.name || '好友'}(QQ:${m.id || ''})说】`
      return `- ${who}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 180)}`
    }).join('\n')

    const compactPrompt = [
      '# 后台静默记忆归档',
      '这段会话要轮转到下一段了。把值得记住的东西压成 200~400 字的接力包，只写结论，不要寒暄：',
      '1. 【关于他的重要记忆与约定】：个人近况、喜好、托付你的事、你们的承诺（看清 QQ 号和名字，绝不张冠李戴）。',
      '2. 【正在办的事与产物路径】：干了什么活、动过哪些 /workspace/... 下的文件、替谁传过话/设过提醒。',
      '3. 【已经聊透可以翻篇的旧话题】：提醒下一轮的自己别再翻炒。',
      '',
      recentLines ? `## 本段对话\n${recentLines}` : '',
    ].filter(Boolean).join('\n')

    log('info', `[静默归档] 后台总结会话 ${chatId}…`)
    push('status', { phase: 'compacting', chat: chatId })

    delete sessions[chatId]
    saveSessions(sessions)
    resetAgentSession(chatId)

    const r = await runTask(compactPrompt, { tag: `compact:${chatId}`, disableTools: true, ephemeral: true })
    if (!r.ok || !r.text) {
      const fallback = recentLines ? `【近期对话自动归档】\n${recentLines}` : '（上一段会话已自动归档）'
      saveHandover(chatId, fallback)
      log('warn', `[静默归档] 模型总结失败，已用近期流水建档兜底`)
      return { ok: true, fallback: true, summary: fallback }
    }
    const parsedDir = parseDirectives(r.text)
    for (const a of parsedDir.actions) if (a.type === 'diary') appendDiary(a.value)
    const summary = parsedDir.text.trim()
    saveHandover(chatId, summary)
    log('info', `[静默归档] 会话 ${chatId} 已建档（${summary.length} 字）`)
    if (parsed.userId) void writeImpressions({ userId: parsed.userId, name: parsed.name }).catch(() => {})
    return { ok: true, summary }
  } finally {
    compacting.delete(lockKey)
  }
}

// ---------- OneBot 连接 ----------
const chatAction = (p) => (p.kind === 'group' ? 'send_group_msg' : 'send_private_msg')
const chatParams = (p, message) => (p.kind === 'group'
  ? { group_id: Number(p.chatId), message }
  : { user_id: Number(p.chatId), message })

class OneBot {
  constructor(url, token, platform='qq') {
    this.platform=platform
    this.connected=false
    this.capabilities={text:true,image:platform==='qq',emoji:platform==='qq',record:platform==='qq'}
    this.url = url
    this.token = token
    this.ws = null
    this.seq = 0
    this.backoff = 2000
    this.pending = new Map()
  }

  connect() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.ws && this.ws.readyState === 1) return
    if (this.ws && this.ws.readyState === 0) {
      if (Date.now() - (this.wsBorn || 0) < 15000) return
      log('warn', '上一个连接卡在握手超过 15s，掐掉重来')
      try { this.ws.terminate?.() } catch {}
      try { this.ws.close?.() } catch {}
      this.ws = null
    }
    this.wsBorn = Date.now()

    const headers = this.token ? { authorization: `Bearer ${this.token}` } : undefined
    let ws
    try {
      ws = new WebSocket(this.url, { headers })
    } catch (e) {
      log('warn', `建连接失败：${e.message}`)
      return this.scheduleReconnect()
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      if(this.ws!==ws || this.stopped){ws.close();return}
      this.connected=true
      if(this.platform==='qq')wsConnected=true
      this.backoff = 2000
      this.attempt = 0
      log('info', `已连上 NapCat：${this.url}`)
      if(this.platform==='qq')push('conn',{connected:true})
      void (async () => {
        if(this.platform==='wechat'){
          const [img,voice,cap]=await Promise.all([this.callWithResult('can_send_image'),this.callWithResult('can_send_record'),this.callWithResult('get_capabilities')])
          this.capabilities={text:true,image:img?.data?.yes===true,emoji:cap?.data?.emoji===true,record:voice?.data?.yes===true,...(cap?.data||{})}
          push('wechat',{connected:true,capabilities:this.capabilities})
          return
        }
        const r = await this.callWithResult('get_login_info')
        const d = r?.data
        if (d?.user_id) {
          const override = String(settings().botName || '').trim()
          setSelf({ id: String(d.user_id), name: override || d.nickname || `QQ${d.user_id}` })
          log('info', `我的身份：${getSelf().name}（${getSelf().id}）`)
          push('self', { ...getSelf(), avatar: qlogo(getSelf().id) })
        }
        await refreshContactsFromOneBot('ws_open')
        for (const gid of settings().allowGroups) void ensureGroupInfo(gid)
      })()
    })
    ws.addEventListener('close', (e) => {
      if(this.ws!==ws)return
      this.connected=false
      if(this.platform==='qq')wsConnected=false
      if(this.platform==='qq')push('conn',{connected:false});else push('wechat',{connected:false})
      log('warn', `连接断开（${e?.code ?? '?'}）`)
      for(const done of this.pending.values())done(null)
      this.pending.clear()
      this.scheduleReconnect()
    })
    ws.addEventListener('error', (e) => {
      if(this.ws!==ws)return
      this.connected=false
      if(this.platform==='qq')wsConnected=false
      log('warn', `WS 异常：${e?.message || 'unknown'}`)
      this.scheduleReconnect()
    })
    ws.addEventListener('message',e=>{if(this.ws===ws)this.onData(e.data)})
  }

  scheduleReconnect() {
    if (this.timer || this.stopped) return
    this.attempt = (this.attempt || 0) + 1
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 30000)
    this.timer = setTimeout(() => { this.timer = null; this.connect() }, delay)
    log('warn', `${Math.round(delay / 1000)}s 后重连（第 ${this.attempt} 次）`)
    push(this.platform==='qq'?'conn':'wechat',{connected:false,retryIn:delay,attempt:this.attempt})
  }

  startWatchdog() {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      if (!this.connected && !this.timer && !this.stopped) {
        log('warn', '看门狗发现没连上，重试')
        this.backoff = 2000
        this.scheduleReconnect()
      }
    }, 30000)
  }

  startHeartbeat() {
    if (this.hb) return
    const every = Math.max(5000, Number(process.env.HEARTBEAT_MS || 25000))
    this.hb = setInterval(async () => {
      if (!this.connected || this.hbBusy) return
      this.hbBusy = true
      const r = await this.callWithResult('get_status', {}, 8000).catch(() => null)
      if (!r) {
        this.hbBusy = false
        this.hbFail = (this.hbFail || 0) + 1
        log('warn', `心跳没回（${this.hbFail}/2）`)
        if (this.hbFail >= 2) {
          this.hbFail = 0
          log('warn', 'NapCat 连续两次没响应，强制重连')
          this.forceReconnect()
        }
        return
      }
      this.hbFail = 0
      if(this.platform==='qq')await refreshContactsFromOneBot('heartbeat_poll').catch(() => {})
      this.hbBusy = false
    }, every)
  }

  forceReconnect() {
    log('info', '手动重连')
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.backoff = 1500
    try { this.ws?.close() } catch {}
    this.ws = null
    this.connected=false
    if(this.platform==='qq')wsConnected=false
    setTimeout(() => this.connect(), 300)
    return true
  }

  onData(raw) {
    let ev
    try { ev = JSON.parse(String(raw)) } catch { return }
    if (ev.echo && this.pending.has(ev.echo)) {
      const done = this.pending.get(ev.echo)
      this.pending.delete(ev.echo)
      done(ev)
      return
    }
    if (ev.post_type === 'meta_event') return

    if (this.platform==='qq' && ev.post_type==='notice') {
      if (ev.notice_type === 'friend_add' || ev.sub_type === 'friend_add' || ev.notice_type === 'friend_increase') {
        const uid = String(ev.user_id || '').trim()
        if (uid) void onNewFriendAdded(uid, ev.nickname || '', 'friend_add').catch(() => {})
        return
      }
      if (ev.notice_type === 'group_increase' && String(ev.user_id || '') === String(ev.self_id || getSelf().id || '')) {
        const gid = String(ev.group_id || '').trim()
        if (gid) void ensureGroupInfo(gid).then(() => refreshContactsFromOneBot('group_increase')).catch(() => {})
        return
      }
    }
    if (this.platform==='qq' && ev.post_type==='request' && ev.request_type==='friend') {
      const uid = String(ev.user_id || '').trim()
      log('info', `[好友申请] ${uid}（验证消息：${ev.comment || '无'}）`)
      setTimeout(() => { void refreshContactsFromOneBot('friend_request').catch(() => {}) }, 1800)
      return
    }

    const parsed=parseEvent({...ev,platform:this.platform})
    if (!parsed) return // notices and unsupported events are not chat messages
    const s = settings()
    if (s.paused || stopping) {
      if (parsed) log('debug', `总开关已暂停，忽略 ${parsed.chatId}：${String(parsed.text).slice(0, 30)}`)
      return
    }
    // Receiving a message never grants permissions or creates a trusted friend.
    if(parsed?.kind==='private' && this.platform==='qq' && s.allowUsers.includes(parsed.userId))setFriendInfo(parsed.userId,{name:parsed.name||parsed.userId})
    const curSettings = settings()
    const target = curSettings.targets?.[conversationKey(parsed)] || (this.platform==='qq'?curSettings.targets?.[String(parsed?.chatId)]:null) || {}
    const atOnly = target.atOnly === undefined ? curSettings.atOnly : !!target.atOnly
    const selfName = String(curSettings.botName || '').trim() || getSelf().name || '肥鱼'
    const verdict = decide(parsed, {
      allowUsers: this.platform==='wechat'?curSettings.allowWechatUsers:curSettings.allowUsers,
      allowGroups: this.platform==='wechat'?curSettings.allowWechatGroups:curSettings.allowGroups,
      allowAnyone:curSettings.allowAnyone,
      learnGroups: curSettings.learnGroups,
      learnAllGroups: curSettings.learnAllGroups,
      targets: curSettings.targets,
      atOnly,
      botName: selfName,
    })

    if (!verdict.reply && parsed && verdict.learnOnly) {
      void acceptLearnOnly(parsed).catch((e) => log('warn', `观察学习失败：${e?.message || e}`))
      return
    }

    let isPendingContinuation = false
    if (!verdict.reply && parsed && verdict.reason === 'no-at' && parsed.kind === 'group') {
      const buf=pending.get(participantKey(parsed))
      const state=followUpStates.get(participantKey(parsed))
      const quotedBot=parsed.replyToMsgId && sentBotMessages.get(conversationKey(parsed))?.has(String(parsed.replyToMsgId)) && !parsed.atOthers
      if ((buf && pendingContinuation(parsed,buf.items)) || (curSettings.groupFollowUpEnabled!==false && (quotedBot || matchFollowUp(parsed,state,Date.now())))) {
        isPendingContinuation = true
        log('info', `群 ${parsed.chatId} ${parsed.name} 防抖连打追述（免@）`)
      }
    }

    if(!verdict.reply && !isPendingContinuation && parsed?.kind==='group' && verdict.reason==='no-at' && !parsed.atOthers && !parsed.replyToMsgId && curSettings.groupFollowUpEnabled!==false){
      const state=followUpStates.get(participantKey(parsed))
      if(state && state.expiresAt>Date.now() && !/^(?:哈哈+|嗯+|好的?|收到|谢谢|晚安)[。！!~～\s]*$/.test(parsed.text)){
        void classifyContinuation(parsed,state).then(yes=>{
          if(yes){noteInbound(parsed.chatId);return accept(parsed)}
          return settings().recordSilent!==false?acceptSilent(parsed):undefined
        }).catch(e=>log('warn','续聊受话对象判断失败：'+e.message))
        return
      }
    }
    if (!verdict.reply && !isPendingContinuation) {
      if (parsed && verdict.reason === 'no-at' && settings().recordSilent !== false) {
        void acceptSilent(parsed).catch((e) => log('warn', `静默记录失败：${e?.message || e}`))
      }
      return
    }

    noteInbound(parsed?.chatId)
    if (this.platform==='qq' && parsed.kind === 'group' && !getGroupInfo(parsed.chatId)?.name) void ensureGroupInfo(parsed.chatId)
    void accept(parsed).catch((e) => log('warn', `消息接收异常：${e?.message || e}`))
  }

  call(action, params) {
    const payload = { action, params, echo: `s${++this.seq}` }
    try { this.ws?.send(JSON.stringify(payload)) } catch (e) { log('error', `发送动作失败：${e.message}`) }
  }

  callWithResult(action, params = {}, timeoutMs = 8000) {
    if(!this.connected || this.ws?.readyState!==1)return Promise.resolve(null)
    const echo = `r${++this.seq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(echo); resolve(null) }, timeoutMs)
      this.pending.set(echo, (data) => { clearTimeout(timer); resolve(data) })
      try {
        this.ws?.send(JSON.stringify({ action, params, echo }))
      } catch {
        clearTimeout(timer)
        this.pending.delete(echo)
        resolve(null)
      }
    })
  }

  async send(parsed,message) {
    const segments=Array.isArray(message)?message:[{type:'text',data:{text:String(message)}}]
    for(const seg of segments){
      const type=seg.type==='mface'?'emoji':seg.type
      if(this.platform==='wechat' && this.capabilities[type]!==true)throw new Error(`微信渠道暂不支持 ${type}，已阻止伪发送`)
    }
    const params=this.platform==='wechat'?(parsed.kind==='group'?{group_id:String(parsed.chatId),message:segments}:{user_id:String(parsed.chatId),message:segments}):chatParams(parsed,message)
    if(!this.connected || this.ws?.readyState!==1)throw new Error('发送通道未连接')
    // WeChat records in real time, then waits for the server message ID.
    const timeout=this.platform==='wechat' && segments.some(seg=>seg.type==='record')?105000:30000
    const result=await this.callWithResult(chatAction(parsed),params,timeout)
    if(!result)throw Object.assign(new Error('发送后未得到平台回执，结果不明'),{unknown:true})
    if(result.status!=='ok'||Number(result.retcode)!==0)throw Object.assign(new Error(result.message||result.wording||`平台发送失败 ${result.retcode}`),{unknown:Number(result.retcode)===1201})
    return {ok:true,messageId:result.data?.message_id,platform:this.platform}
  }
}

async function ensureGroupInfo(gid) {
  if (!gid || getGroupInfo(gid)?.name) return getGroupInfo(gid)
  const r = await bot.callWithResult('get_group_info', { group_id: Number(gid), no_cache: false })
  const d = r?.data
  if (d && (d.group_id || d.group_name)) {
    const info = setGroupInfo(gid, {
      name: d.group_name || `群 ${gid}`,
      avatar: groupAvatar(gid),
      memberCount: d.member_count,
    })
    log('info', `群信息：${info.name}（${gid}）`)
    push('group', info)
    return info
  }
  setGroupInfo(gid, { name: `群 ${gid}`, avatar: groupAvatar(gid) })
  return getGroupInfo(gid)
}

async function refreshContactsFromOneBot(reason = 'manual') {
  const [fr, gr] = await Promise.all([
    bot.callWithResult('get_friend_list', { no_cache: true }, 8000).catch(() => null),
    bot.callWithResult('get_group_list', { no_cache: true }, 8000).catch(() => null),
  ])
  const res = syncContactsDirectory({ friendList: fr?.data || [], groupList: gr?.data || [] })
  invalidateContactsCache()
  if (res.newFriends?.length) {
    for (const nf of res.newFriends) await onNewFriendAdded(nf.id, nf.name, reason, { skipListFetch: true })
  } else if (res.newGroups?.length || reason === 'group_increase') {
    push('contacts', { reason, ts: Date.now() })
  }
  return res
}

async function onNewFriendAdded(userId, hintName = '', reason = 'friend_add', opts = {}) {
  const uid = String(userId || '').trim()
  if (!uid || uid === String(getSelf().id || '')) return

  let resolvedName = String(hintName || '').trim()
  if (!opts.skipListFetch) {
    const [fr, sr] = await Promise.all([
      bot.callWithResult('get_friend_list', { no_cache: true }, 6000).catch(() => null),
      (!resolvedName || resolvedName === uid)
        ? bot.callWithResult('get_stranger_info', { user_id: Number(uid), no_cache: true }, 5000).catch(() => null)
        : Promise.resolve(null),
    ])
    if (fr?.data?.length) syncContactsDirectory({ friendList: fr.data })
    const hit = (fr?.data || []).find((f) => String(f.user_id) === uid)
    if (hit) resolvedName = hit.remark || hit.nickname || resolvedName || uid
    else if (sr?.data?.nickname) resolvedName = sr.data.remark || sr.data.nickname || resolvedName || uid
  }

  const friend = setFriendInfo(uid, { name: resolvedName || getFriendInfo(uid)?.name || uid, addedAt: Date.now() })
  invalidateContactsCache()

  const s = settings()
  const nextTargets = { ...(s.targets || {}) }
  if (!nextTargets[uid]) nextTargets[uid] = { note: friend.name || '', proactive: false }
  if (s.autoAllowNewFriends === true && ['friend_add','ws_open','heartbeat_poll','friend_request'].includes(reason) && Array.isArray(s.allowUsers) && !s.allowUsers.includes(uid)) {
    saveSettings({ allowUsers: [...new Set([...s.allowUsers, uid])], targets: nextTargets })
    log('info', `新好友 ${friend.name} (${uid}) 已加入白名单（主动搭话默认关）`)
    push('settings', { settings: publicSettings() })
  } else {
    saveSettings({ targets: nextTargets })
  }

  if (!readRecent(200).some((m) => String(m.chat || '') === uid)) {
    appendChat({ role: 'user', kind: 'private', chat: uid, id: uid, name: friend.name || uid, text: '已添加好友，随时开聊', silent: true })
  }
  push('contacts', { reason, userId: uid, name: friend.name || uid, ts: Date.now() })
  push('msg', { role: 'user', kind: 'private', chat: uid, id: uid, name: friend.name || uid, text: '已添加好友，随时开聊', ts: Date.now() })
}

const bot = new OneBot(WS_URL,TOKEN)
const modelAlertCooldown = new Map()
setModelFailureNotifier(async result => {
  const s = settings()
  const recipient = String(s.modelFailureNotifyQQ || '').trim()
  if (!/^\d{5,12}$/.test(recipient) || !s.ownerUsers.map(String).includes(recipient) || !bot.connected) return
  const key = `${recipient}:${result.provider}:${result.model}`
  const now = Date.now()
  for (const [id, expires] of modelAlertCooldown) if (expires <= now) modelAlertCooldown.delete(id)
  if (modelAlertCooldown.has(key)) return
  modelAlertCooldown.set(key, now + 10 * 60 * 1000)
  try {
    const label = String(result.model || '当前模型').replace(/[^a-zA-Z0-9._:/-]/g, '').slice(0, 100) || '当前模型'
    await bot.send({kind:'private',chatId:recipient}, `小鲸鱼的主模型 ${label}${result.modelFailure === 'timeout' ? '请求超时' : '调用失败'}。请到鲸鱼窝「设置 → 模型与服务」手动切换。`)
  } catch (e) {
    modelAlertCooldown.set(key, now + 60 * 1000)
    throw e
  }
})
let wxBot=null
function clientFor(p){
  if(p?.platform==='wechat'){if(!wxBot)throw new Error('微信渠道未连接');return wxBot}
  return bot
}
function ensureWechat(){
  const s=settings()
  if(!s.wechatEnabled){if(wxBot){wxBot.stopped=true;clearInterval(wxBot.hb);clearInterval(wxBot.watchdog);clearTimeout(wxBot.timer);wxBot.ws?.close();wxBot=null}return}
  if(wxBot && wxBot.url===s.wechatWsUrl && wxBot.token===s.wechatToken)return
  if(wxBot){wxBot.stopped=true;clearInterval(wxBot.hb);clearInterval(wxBot.watchdog);clearTimeout(wxBot.timer);wxBot.ws?.close()}
  wxBot=new OneBot(s.wechatWsUrl,s.wechatToken,'wechat');wxBot.startWatchdog();wxBot.startHeartbeat();wxBot.connect()
}
function hasGroupPending(parsed){return [...pending.values()].some(buf=>buf.items.some(it=>conversationKey(it.parsed)===conversationKey(parsed)))}


async function resolveFileUrl(parsed, item) {
  const action = parsed.kind === 'group' ? 'get_group_file_url' : 'get_private_file_url'
  const params = parsed.kind === 'group'
    ? { group_id: Number(parsed.chatId), file_id: item.fileId }
    : { user_id: Number(parsed.chatId), file_id: item.fileId }
  const r = await clientFor(parsed).callWithResult(action, params, 12000)
  return r?.data?.url || ''
}

async function classifyContinuation(parsed,state){
  const prompt=`判断群里同一位发言者的新消息是否在延续与机器人的对话。仅给JSON，不生成回复。明显换话题、面向其他群友、泛泛闲聊判false。\n原问题：${state.topic}\n机器人刚回：${state.replyText}\n发言者新说：${parsed.text}\n格式：{"addressedToBot":true,"confidence":0.9}`
  const result=await runTask(prompt,{disableTools:true,ephemeral:true,maxSteps:1,tag:'follow-up-classifier',customSettings:{...settings(),maxReplyTokens:120,timeoutMs:20000}})
  if(!result.ok)return false
  try{const m=JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g,''));return m.addressedToBot===true && Number(m.confidence)>=0.8}catch{return false}
}
// ---------- 出站：整形 + 分段打字 ----------
async function say(parsed, text, opts = {}) {
  const s = settings()
  const cleaned = opts.raw ? text : humanizeReply(text, { isTask: opts.isTask, casualMaxChars: s.casualMaxChars })
  const chunks = splitReply(cleaned, s.replyChunk)
  if (parsed?.kind === 'group' && parsed?.chatId && chunks.length) {
    activeGroupConvoUntil.set(String(parsed.chatId), Date.now() + 90_000)
  }
  const receipts=[]
  const usedExprs = recordUsedExpressions(cleaned)
  if (usedExprs.length) log('info', `[表达命中] ${usedExprs.map((x) => `「${x}」`).join(' ')}`)
  for (let i = 0; i < chunks.length; i++) {
    const now = Date.now()
    const slot = Math.max(now, nextSendSlot)
    nextSendSlot = slot + 900
    const wait = slot - now
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    receipts.push(await clientFor(parsed).send(parsed,chunks[i]))
    if (i < chunks.length - 1) {
      const gap = estimateTypingDelay(chunks[i + 1], s.chunkGapMs)
      nextSendSlot = Math.max(nextSendSlot, Date.now() + gap)
      await new Promise((r) => setTimeout(r, gap))
    }
  }
  if(parsed.kind==='group' && receipts.length){
    const ids=receipts.map(x=>x.messageId).filter(x=>x!=null).map(String)
    const key=conversationKey(parsed),old=sentBotMessages.get(key)||new Set()
    for(const id of ids)old.add(id)
    while(old.size>100)old.delete(old.values().next().value)
    sentBotMessages.set(key,old)
    const previous=parsed.atMe || parsed.nameCalled ? null : followUpStates.get(participantKey(parsed))
    const state=createFollowUpState(parsed,cleaned,ids,Date.now(),previous,s)
    for(const [id,x] of followUpStates)if(x.expiresAt<Date.now())followUpStates.delete(id)
    if(state)followUpStates.set(participantKey(parsed),state)
    else followUpStates.delete(participantKey(parsed))
  }
  return {ok:true,receipts,messageId:receipts.at(-1)?.messageId}
}

const MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i
const FILE_EXT = /\.(mp4|pdf|pptx?|docx?|xlsx?|txt|zip|md|csv|json|log|mp3|wav)$/i

function autodetectPaths(text) {
  const found = []
  const cleaned = String(text || '').replace(/\/workspace\/[^\s，。；、)）"'`]+\.[a-z0-9]{2,5}/gi, (m) => {
    const p = m.replace(/[.,;:]+$/, '')
    if (!existsSync(p)) return m
    if (MEDIA_EXT.test(p)) found.push({ type: 'image', value: p })
    else if (FILE_EXT.test(p)) found.push({ type: 'file', value: p })
    else return m
    return ''
  })
  return { text: cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), actions: found }
}

async function act(parsed, actions, opts={}) {
  for (const action of actions) {
    const native=DIRECTIVE_TOOL[action.type]
    const nativeArgs=action.type==='send'?{target:action.target,text:action.message}:action.type==='remind'?{target:action.target,minutes:action.minutes,message:action.message}:['tts','voice'].includes(action.type)?{text:action.value,style:action.style,target:action.target}:['image','emoji'].includes(action.type)?{path:action.value,target:action.target}:['phone','adb'].includes(action.type)?{action:action.value}:action.type==='qzone'?{text:action.content||action.value,image_path:action.images?.[0]}:action.type==='search'?{query:action.value}:{text:action.value}
    if(native && !['send_file','draw_image','send_like'].includes(native)){
      const result=await executeTool(native,nativeArgs,{parsed,memoryRoot:process.env.MEMORY_DIR||join(WORKSPACE,'memory'),galleryRoot:process.env.GALLERY_DIR||join(WORKSPACE,'gallery'),manual:opts.manual,disabled:opts.disabled,runId:`legacy:${conversationKey(parsed)}:${parsed.messageId||Date.now()}`})
      if(!result.ok){log('warn',`兼容动作 ${action.type} 失败：${result.error}`);if(action.type!=='emoji')await say(parsed,`这步没完成：${result.error}`,{raw:true})}
      continue
    }
    const permit=authorizeAction(DIRECTIVE_TOOL[action.type]||action.type,action,parsed,settings(),{disabled:opts.disabled,manual:opts.manual})
    if(!permit.ok){log('warn',`动作 ${action.type} 已拦截：${permit.error}`);continue}
    if(['image','emoji','file'].includes(action.type) && !canSendResource(action.value,parsed)){log('warn','媒体路径越权');continue}
    if (action.type === 'diary') { if (appendDiary(action.value)) push('diary', { text: action.value }); continue }
    if (action.type === 'world' || action.type === 'humanworld') { appendHumanWorld(action.value); continue }
    if (action.type === 'send' || action.type === 'remind') { await executeCrossWindowAction(parsed, action); continue }
    if (['tts', 'voice', 'qzone', 'draw', 'phone', 'adb', 'search'].includes(action.type)) {
      const res = await executeMultimodalPlugin(parsed, action)
      if (action.type === 'qzone' && !res?.ok && !res?.reserved && parsed?.chatId) {
        await say(parsed, `（说说没发出去：${res?.error || '检查 NapCat Cookie 或空间设置'}）`, { raw: true })
      }
      if (action.type === 'search' && res?.ok && res.summary && parsed?.chatId) {
        await say(parsed, res.summary, { raw: true })
      }
      continue
    }
    if(action.type==='like'){const r=await clientFor(parsed).callWithResult('send_like',{user_id:Number(action.value),times:1});if(Number(r?.retcode)!==0)throw new Error('点赞失败');continue}
    if (action.type === 'file') {
      const name = baseNameOf(action.value)
      const url = publicUrl(action.value)
      const receipt=await clientFor(parsed).callWithResult(parsed.kind==='group'?'upload_group_file':'upload_private_file',parsed.kind==='group'?{group_id:Number(parsed.chatId),file:url,name}:{user_id:Number(parsed.chatId),file:url,name},30000)
      if(Number(receipt?.retcode)!==0)throw new Error('文件发送失败或未获回执')
      continue
    }
    if (action.type === 'image' || action.type === 'emoji') {
      await clientFor(parsed).send(parsed,[{type:'image',data:{file:publicUrl(action.value)}}])
      if (action.type === 'emoji' && parsed?.chatId) noteStickerSent(parsed.chatId)
      continue
    }
    const segment = toSegment(action)
    if(segment)await clientFor(parsed).send(parsed,[segment])
  }
}

// ---------- v3：把「引用的是哪条」「合并转发里说了什么」真正读出来 ----------
async function buildRichContextBlock(parsed) {
  const blocks = []
  if (parsed?.replyToMsgId) {
    const r = await clientFor(parsed).callWithResult('get_msg', { message_id: parsed.replyToMsgId }, 8000).catch(() => null)
    const block = r?.data ? formatQuotedContext({ ...r.data, self_id: parsed.self }, parsed.name) : ''
    if (block) {
      blocks.push(block)
      parsed.quotedText = block.replace(/\s+/g, ' ').slice(0, 200)
    } else {
      const local = readRecent(200).find((m) => visibleIn(m,parsed) && String(m.messageId || '') === String(parsed.replyToMsgId))
      if (local) blocks.push(`## 对方在引用\n> ${String(local.text || '').slice(0, 200)}`)
    }
  }
  for (const m of parsed?.media || []) {
    if (m.type !== 'forward' || !m.id) continue
    const r = await clientFor(parsed).callWithResult('get_forward_msg', { id: m.id }, 12000).catch(() => null)
    const lines = flattenForwardMessages(r?.data)
    if (lines.length) {
      blocks.push([
        '## 对方发来一段合并转发的聊天记录（已展开，可以当事实看）',
        ...lines.slice(0, 40).map((l) => `  ${l}`),
      ].join('\n'))
      log('info', `[合并转发] 展开 ${lines.length} 条`)
    } else {
      blocks.push('## 对方发来一段合并转发，但拉取失败（可以让对方截图或直接说重点）')
      log('warn', `[合并转发] get_forward_msg 失败 id=${m.id}`)
    }
  }
  return blocks.join('\n\n')
}

// ---------- 准入后的处理 ----------
async function acceptLearnOnly(parsed) {
  const s = settings()
  appendChat({role:'user',name:parsed.name,id:parsed.userId,kind:parsed.kind,platform:parsed.platform,
    chat:parsed.chatId,text:parsed.text,messageId:parsed.messageId,silent:true,learningOnly:true})
  learnFromMessage(parsed,memoryRoot,{statsOnly:true})
  scheduleGroupLearning(parsed,memoryRoot,settings,runTask)
  if ((parsed.media || []).some((m) => m.type === 'emoji') && s.stickerAutoSteal !== false) {
    try {
      const media = await fetchMedia(parsed, { resolve: (it) => resolveFileUrl(parsed, it) })
      stealStickerIfEligible(media.paths, parsed)
    } catch (e) { log('warn', `观察学习群素材下载失败：${e?.message || e}`) }
  }
}

function senderTag(parsed) {
  if (!parsed) return '[未知来源]'
  const gName = parsed.kind === 'group' ? (getGroupInfo(parsed.chatId)?.name || `群${parsed.chatId}`) : ''
  const uName = parsed.name || getFriendInfo(parsed.userId)?.name || parsed.userId || ''
  return formatSenderLabel(parsed, { groupName: gName, userName: uName })
}

async function acceptSilent(parsed) {
  clearTimeout(chimeTimers.get(conversationKey(parsed)))
  chimeTimers.delete(conversationKey(parsed))
  let media = { paths: [], failed: [] }
  if (parsed.media?.length) {
    media = await fetchMedia(parsed, { resolve: (it) => resolveFileUrl(parsed, it) })
    if (settings().stickerAutoSteal !== false && (parsed.media || []).some((m) => m.type === 'emoji')) {
      try { stealStickerIfEligible(media.paths, parsed) } catch {}
    }
  }
  if (settings().styleLearnEnabled !== false) learnFromMessage(parsed,memoryRoot,{statsOnly:true})
  appendChat({
    role: 'user', name: parsed.name, id: parsed.userId, kind:parsed.kind, platform:parsed.platform,
    text: parsed.text, chat: parsed.chatId, messageId: parsed.messageId, silent: true,
  })
  scheduleGroupLearning(parsed,memoryRoot,settings,runTask)
  log('info', `[群聊旁听] ${senderTag(parsed)}：${String(parsed.text || '').slice(0, 100)}`)
  push('msg', {
    role: 'user', name: parsed.name, id: parsed.userId, kind:parsed.kind, platform:parsed.platform,
    chatName: parsed.kind === 'group' ? (getGroupInfo(parsed.chatId)?.name || `群${parsed.chatId}`) : '',
    text: parsed.text, chat: parsed.chatId, silent: true, ts: Date.now(),
  })
  if (parsed.kind === 'group') scheduleChimeIn(parsed)
}

const pending = new Map()

async function accept(parsed) {
  const key = participantKey(parsed)
  const scope = conversationKey(parsed)
  if (parsed.kind === 'group' && chimeTimers.has(scope)) {
    clearTimeout(chimeTimers.get(scope))
    chimeTimers.delete(scope)
  }
  log('info', `[收到消息] ${senderTag(parsed)}：${String(parsed.text || '').slice(0, 120)}`)

  // 先把消息占位放入防抖池，消除 fetchMedia 下载图片期间的追述盲区
  const media = { paths: [], failed: [] }
  const entry = { parsed, media }
  const buf = pending.get(key) || { items: [], first: Date.now(), lastAdded: Date.now(), timer: null }
  buf.items.push(entry)
  buf.lastAdded = Date.now()
  pending.set(key, buf)
  scheduleFlush(key, buf)

  if (parsed.media?.length) {
    entry.mediaPromise = (async () => {
      const fetched = await fetchMedia(parsed, { resolve: (it) => resolveFileUrl(parsed, it) })
      media.paths.push(...(fetched.paths || []))
      media.failed.push(...(fetched.failed || []))
      if (settings().stickerAutoSteal !== false && (parsed.media || []).some((m) => m.type === 'emoji')) {
        try { stealStickerIfEligible(media.paths, parsed) } catch {}
      }
      if (pending.get(key) === buf) scheduleFlush(key, buf)
    })()
    await entry.mediaPromise
  }
  if (/qfile\.qq\.com\/q\//i.test(parsed.text || '')) {
    media.failed.push('QQ闪传链接服务端打不开，需要对方直接发文件')
  }
}

async function waitMediaReady(items = [], maxWaitMs = 5000) {
  const pendingPromises = items.map((it) => it?.mediaPromise).filter(Boolean)
  if (!pendingPromises.length) return
  await Promise.race([
    Promise.allSettled(pendingPromises),
    new Promise((r) => setTimeout(r, maxWaitMs)),
  ])
}

function parsedWait(buf,s){return buf.items.some(it=>(it.parsed.media||[]).length)?Number(s.debounceMediaMs)||7000:buf.items[0]?.parsed.kind==='group'?Number(s.debounceGroupMs)||6500:0}
function scheduleFlush(key, buf) {
  const s = settings()
  if (buf.timer) clearTimeout(buf.timer)

  const rawTexts = buf.items.map((i) => i.parsed.text)
  const base = Math.max(600, Number(s.debounceMs || 4500))
  const comp = s.debounceSmart !== false
    ? analyzeCompleteness(rawTexts, base)
    : { stage: 'fixed', waitMs: base }

  let wait=Math.max(comp.waitMs,Number(s.debounceTypingGapMs)||4500,parsedWait(buf,s))
  // v3.0.1：用分道状态判断「本会话是否正在跑」，不再依赖全局 currentTask
  //（它在多会话并发时会被别的会话覆盖，且从来没有被置回 null）
  const isBusyThis=Boolean(lanes.get(conversationKey(buf.items[0]?.parsed))?.running)
  if (isBusyThis) wait = Math.max(wait, 2200)

  const elapsed = Date.now() - buf.first
  const cap=Math.max(5000,Number(s.debounceMaxWaitMs)||15000)
  wait=debounceDelay({waitMs:wait,first:buf.first,lastAdded:buf.lastAdded,nowMs:Date.now(),maxWaitMs:cap})

  log('debug', `防抖 ${key}：${buf.items.length} 条 [${comp.stage}]，等 ${Math.round(wait)}ms`)
  buf.timer = setTimeout(() => {
    pending.delete(key)
    void flush(key,buf).catch(e=>log('error','消息合流失败：'+e.message))
  }, wait)
}

async function flush(key, buf) {
  const items = buf.items
  await waitMediaReady(items, 5000)
  // v3.0.1：合并逻辑抽到 onebot-lib.mergeParsedBatch（可单测），
  // 它会保留首条的 replyToMsgId 与 parsed.media（引用 / 合并转发都挂在这上面）。
  const merged = mergeParsedBatch(items)
  if (!merged) return

  for (const it of items) {
    if (settings().styleLearnEnabled !== false) learnFromMessage(it.parsed,memoryRoot,{statsOnly:true})
    appendChat({
      role: 'user', name: it.parsed.name, id: it.parsed.userId, kind:it.parsed.kind, platform:it.parsed.platform,
      text: it.parsed.text, chat: it.parsed.chatId, images: it.media?.paths || [],
      messageId: it.parsed.messageId, quoted: it.parsed.quotedText || '',
    })
    scheduleGroupLearning(it.parsed,memoryRoot,settings,runTask)
    push('msg', { role: 'user', name: it.parsed.name, id: it.parsed.userId, text:it.parsed.text,chat:it.parsed.chatId,scope:conversationKey(it.parsed),ts:Date.now() })
  }
  if (items.length > 1) log('info', `合并 ${items.length} 条消息 → 一次思考`)
  enqueue(merged.parsed, merged.media, { skipAppend: true })
}

// ---------- 按会话分道调度（v3）----------
const lanes = new Map() // key -> { queue: [], running: false }
let liveJobs = 0

function laneOf(key) {
  if (!lanes.has(key)) lanes.set(key, { queue: [], running: false })
  return lanes.get(key)
}

function queuedTotal() {
  let n = 0
  for (const l of lanes.values()) n += l.queue.length
  return n
}

function enqueue(parsed, media = { paths: [], failed: [] }, opts = {}) {
  const key = conversationKey(parsed)
  const lane = laneOf(key)

  const existing = lane.queue.findIndex((item) => sameParticipant(item.parsed,parsed))
  if (existing >= 0) {
    const item = lane.queue[existing]
    const prevRaw = item.parsed.rawItems || [item.parsed.text]
    const newRaw = parsed.rawItems || [parsed.text]
    item.parsed.rawItems = [...prevRaw, ...newRaw]
    item.parsed.text = item.parsed.rawItems.join('\n')
    item.media.paths.push(...(media.paths || []))
    item.media.failed.push(...(media.failed || []))
    // 合并消息段（引用 / 合并转发都在 parsed.media 里），保留首个非空的引用目标
    item.parsed.media = [...(item.parsed.media || []), ...(parsed.media || [])]
    if (!item.parsed.replyToMsgId && parsed.replyToMsgId) item.parsed.replyToMsgId = parsed.replyToMsgId
    if (!item.parsed.quotedText && parsed.quotedText) item.parsed.quotedText = parsed.quotedText
    item.parsed.messageId = parsed.messageId
    item.parsed.sourceItems=[...(item.parsed.sourceItems||[]),...(parsed.sourceItems||[])]
    // The lane merges only one actual participant.
    log('info', `同会话排队任务合并（${key}）`)
    return
  }

  if (lane.queue.length >= MAX_LANE_QUEUE) {
    log('warn', `会话 ${key} 排队超过 ${MAX_LANE_QUEUE}，丢弃`)
    void clientFor(parsed).send(parsed,'手上活有点多，说慢点').catch(e=>log('warn',e.message))
    return
  }

  lane.queue.push({parsed,media,skipAppend:!!opts.skipAppend,passive:!!opts.passive})
  push('queue', { size: queuedTotal() })
  log('info', `入队 ${senderTag(parsed)}：${String(parsed.text).slice(0, 80)}`)
  void runLane(key)
}

async function runLane(key) {
  const lane = laneOf(key)
  if (lane.running) return
  lane.running = true
  try {
    while (lane.queue.length) {
      if (liveJobs >= MAX_CONCURRENT) {
        await new Promise((r) => setTimeout(r, 150))
        continue
      }
      const head=lane.queue[0]
      if(head && pending.has(participantKey(head.parsed))){await new Promise(r=>setTimeout(r,150));continue}
      const job = lane.queue.shift()
      push('queue', { size: queuedTotal() })
      liveJobs += 1
      try {
        await handleJob(job)
      } catch (e) {
        log('error', `任务异常 ${key}：${e?.stack || e?.message || e}`)
      } finally {
        liveJobs -= 1
      }
    }
  } finally {
    lane.running = false
    if (!lane.queue.length && lanes.get(key) === lane) lanes.delete(key)
  }
}

async function handleJob(msg) {
  const key=participantKey(msg.parsed)

  // Buffers finish their own quiet window; never steal a message while its author is typing.
  const s = settings()
  if (!msg.skipAppend) {
    appendChat({
      role: 'user', name: msg.parsed.name, id: msg.parsed.userId, kind:msg.parsed.kind, platform:msg.parsed.platform,
      text: msg.parsed.text, chat: msg.parsed.chatId, images: msg.media?.paths || [],
    })
    push('msg', { role: 'user', name: msg.parsed.name, id: msg.parsed.userId, text:msg.parsed.text,chat:msg.parsed.chatId,scope:conversationKey(msg.parsed),ts:Date.now() })
  }

  if (isCompactCommand(msg.parsed.text)) {
    const prevRec = sessionRecordFor(conversationKey(msg.parsed))
    const res = await compactAndHandoverSession(msg.parsed, prevRec)
    const brief = res.summary ? res.summary.split('\n').slice(0, 3).join('\n') : '已归档'
    await say(msg.parsed, `记忆已归档，新对话随时开聊：\n${brief}`, { isTask: true })
    return
  }

  const isTask = looksLikeTask(msg.parsed.text)
  const atmo = analyzeChatAtmosphere([], msg.parsed, { now: new Date() })

  // 上下文（人设 + 记忆 + 表达语料 + 全局意识流 + 联想记忆树）作为 system prompt 一次性给出
  const memoryRoot = process.env.MEMORY_DIR || join(WORKSPACE, 'memory')
  const galleryRoot = process.env.GALLERY_DIR || join(WORKSPACE, 'gallery')
  await prepareTreeQuery(msg.parsed.text,memoryRoot,msg.parsed).catch(e=>log('warn','远端语义召回回落本地：'+e.message))
  const systemPrompt = buildContext({
    chatId: msg.parsed.chatId,
    userId: msg.parsed.userId,
    userName: msg.parsed.name,
    kind:msg.parsed.kind, platform:msg.parsed.platform,
    chars: s.contextChars,
    recent: s.contextMessages,
    inputText: msg.parsed.text,
  })

  let task = buildTask(msg.parsed, s.promptTemplate || undefined, {
    atmosphereGuidance: s.atmospherePerception !== false ? atmo.promptGuidance : '',
  })

  const [richBlock, visionBlock] = await Promise.all([
    buildRichContextBlock(msg.parsed).catch(() => ''),
    msg.media?.paths?.length ? describeImagesForChat(msg.media.paths, s).catch(() => '') : Promise.resolve(''),
  ])

  const materials = [
    richBlock,
    visionBlock,
    msg.media?.paths?.length ? `\n## 他刚发来的素材（已落地，可直接读）\n${msg.media.paths.map((p) => `- ${p}`).join('\n')}` : '',
    msg.media?.failed?.length ? `\n## 素材下载失败（可以让对方重发）\n${msg.media.failed.map((f) => `- ${f}`).join('\n')}` : '',
  ].filter(Boolean).join('\n')

  const prevRec = sessionRecordFor(conversationKey(msg.parsed))
  const known = prevRec?.id

  // v3.0.1：本轮已把完整 buildContext 作为 systemPrompt 传下去，
  // 续跑锚点只补「期间别的窗口/群里发生了什么」，用 lightweight 避免同内容在 system 与 user 里各来一遍。
  const turnAnchor = known
    ? `\n\n${buildTurnAnchor({
      chatId: msg.parsed.chatId,
      userId: msg.parsed.userId, kind:msg.parsed.kind, platform:msg.parsed.platform,
      userName: msg.parsed.name,
      sinceTs: prevRec?.ts,
      inputText: msg.parsed.text,
      lightweight: true,
    })}`
    : ''

  const prompt = [
    task,
    msg.passive?'这是旁听群聊后的可选接话。就算认出了梗，也要看它是否是当前话题、对方是否在认真求助、有没有合适的新回应。有自然切入点就简短接一句，否则只输出 [[skip]]。不调用任何动作。':'',
    materials,
    turnAnchor,
  ].filter(Boolean).join('\n')

  log('info', `${known ? `续跑会话 ${known}（第 ${(prevRec?.turns || 0) + 1} 轮）` : '新会话'} · ${msg.parsed.kind}/${msg.parsed.chatId}`)

  const ackWanted = s.ackDelayMs > 0 && (!s.ackOnlyTask || isTask)
  const ackTimer = ackWanted ? setTimeout(() => { void say(msg.parsed, s.ackText, { raw: true }).catch((e) => log('warn', `发送处理中提示失败：${e?.message || e}`)) }, s.ackDelayMs) : null

  const t0 = Date.now()
  const activeSessionId=s.resumeSession===false?'':conversationKey(msg.parsed)
  let result
  try {
    result = await runTask(prompt, {
      sessionId: activeSessionId,
      notifyModelFailure: !msg.passive,
      disableTools: s.agentTools===false || Boolean(msg.passive),
      tag:conversationKey(msg.parsed),
      systemPrompt,
      ctx:{parsed:msg.parsed,memoryRoot,galleryRoot,requestId:`${conversationKey(msg.parsed)}:${msg.parsed.messageId || Date.now()}`},
    })
  } finally {
    if (ackTimer) clearTimeout(ackTimer)
  }

  log(result.ok ? 'info' : 'error', `耗时 ${Date.now() - t0}ms${result.ok ? '' : '：' + result.error}${result.toolLog?.length ? ` · 工具 ${result.toolLog.length} 次` : ''}`)

  if (!result.ok) {
    const done=(result.toolLog||[]).filter(x=>x.ok).map(x=>x.name)
    await say(msg.parsed,done.length?`前面的操作已完成（${done.join('、')}），后续回答中断了，先别重复执行`:'这次没完成，稍后可以再试',{raw:true})
    return
  }

  const completedTools=[...(result.toolLog||[])]
  const completedArtifacts=[...(result.artifacts||[])]
  for(let revision=0;revision<2;revision++){
    const deadline=Date.now()+Math.max(5000,Number(s.debounceMaxWaitMs)||15000)
    while(pending.has(participantKey(msg.parsed)) && Date.now()<deadline)await new Promise(r=>setTimeout(r,150))
    const lane=lanes.get(conversationKey(msg.parsed))
    const extra=lane?.queue.filter(job=>sameParticipant(job.parsed,msg.parsed))||[]
    if(!extra.length)break
    lane.queue=lane.queue.filter(job=>!extra.includes(job))
    const supplement=extra.map(job=>job.parsed.text).join('\n')
    msg.parsed.text+='\n'+supplement
    for(const job of extra)msg.media.paths.push(...(job.media?.paths||[]))
    result=await runTask(`你上一条回答尚未发给对方。对方在你处理期间补充了以下内容，请结合原问题修正最终答复；已完成工具动作不要重做：\n${supplement}`,{sessionId:activeSessionId,systemPrompt:buildContext({...msg.parsed,inputText:msg.parsed.text}),disableTools:s.agentTools===false||Boolean(msg.passive),notifyModelFailure:!msg.passive,ctx:{parsed:msg.parsed,memoryRoot,galleryRoot,requestId:`${activeSessionId}:supplement:${extra.map(x=>x.parsed.messageId).join(',')}`}})
    if(!result.ok){await say(msg.parsed,'补充已经收到了，后续处理暂时中断，已完成的操作无需重做',{raw:true});return}
    completedTools.push(...(result.toolLog||[]));completedArtifacts.push(...(result.artifacts||[]))
  }
  result.toolLog=completedTools;result.artifacts=completedArtifacts
  const updatedRec = rememberSession(conversationKey(msg.parsed), {
    usage: result.usage,
    promptChars: prompt.length,
    replyChars: (result.text || '').length,
    provider: result.provider,
  })

  const parsedReply = parseDirectives(result.text)
  let { text } = parsedReply
  text=text.replace(/\[\[skip\]\]/gi,'').trim()
  if(msg.passive && !text && !parsedReply.actions.length)return
  const rawActions = parsedReply.actions.slice()
  const auto = autodetectPaths(text)
  if (auto.actions.length) {
    text = auto.text
    for (const a of auto.actions) if (!rawActions.some((x) => x.value === a.value)) rawActions.push(a)
  }
  const actions = dedupeActionsWithToolLog(rawActions, result.toolLog)

  // 若本轮模型实际调用了工具（如联网搜索、刷B站、查记忆等），不应再按 55 字纯闲聊把结果腰斩
  const effectiveIsTask = isTask || Boolean(result.toolLog?.length)
  const effectiveMaxChars = /(b站|bilibili|塔罗|森空岛|求签|运势)/i.test(msg.parsed.text)
    ? Math.max(150, Number(s.casualMaxChars || 55))
    : s.casualMaxChars
  const finalText = humanizeReply(text, { isTask: effectiveIsTask, casualMaxChars: effectiveMaxChars })

  const autoSticker = maybeAttachSticker({ parsed: msg.parsed, replyText: finalText, existingActions: actions, isTask: effectiveIsTask })
  if (autoSticker) actions.push(autoSticker)

  if (finalText) {
    log('info', `[发出回复] → ${senderTag(msg.parsed)}：${finalText.slice(0, 100)}`)
    await say(msg.parsed, finalText, { isTask: effectiveIsTask, raw: true })
  }
  await act(msg.parsed,actions,{disabled:s.agentTools===false || msg.passive})

  const selfName = String(settings().botName || '').trim() || getSelf().name || '肥鱼'
  appendChat({
    role: 'assistant', id: getSelf().id, name: selfName, kind:msg.parsed.kind, platform:msg.parsed.platform,
    text: finalText || `（执行了 ${actions.length || result.toolLog?.length || 0} 个动作）`, chat: msg.parsed.chatId,
  })
  push('msg', { role: 'assistant', id: getSelf().id, name: selfName, text:finalText||'（发了图/执行了动作）',chat:msg.parsed.chatId,scope:conversationKey(msg.parsed),ts:Date.now() })

  if (updatedRec && s.sessionAutoCompact !== false) {
    const health = evaluateSessionHealth(updatedRec)
    if (health.shouldCompact) {
      log('info', `[静默归档] 会话 ${msg.parsed.chatId} 达到轮转阈值（${health.turns}/${health.maxTurns}）`)
      await compactAndHandoverSession(msg.parsed, updatedRec).catch((e) => log('warn', `静默归档异常：${e.message}`))
    }
  }
}

// ---------- 群聊插话 ----------
const lastGroupChimeIn = new Map()
const chimeTimers = new Map()

function scheduleChimeIn(parsed) {
  const s = settings()
  if (!s.groupChimeInEnabled) return
  if (!(Number(s.groupChimeInProb) > 0)) return // v3：概率 0 = 明确不插话，连评估都不做
  if (s.paused) return
  if (inQuietHours(new Date(), s.quietStart || '23:30', s.quietEnd || '08:00')) return

  const gid = conversationKey(parsed)
  if (hasGroupPending(parsed)) return
  const memeMatch = findConversationMeme(parsed.text,gid,memoryRoot,true)
  if (parsed.platform === 'wechat' && !memeMatch) return

  const recentGroup = readRecent(60).filter(m=>visibleIn(m,parsed)).slice(-24)
  const selfName = String(s.botName || '').trim() || getSelf().name || '肥鱼'
  const inActiveConvo=false

  const evalRes = evaluateGroupChimeIn(parsed, recentGroup, {
    baseProb: Number(s.groupChimeInProb),
    botName: selfName,
    hasUserImpression: !!readPersonImpression(parsed.userId,memoryRoot,700,gid),
    inActiveConvo,
    memeMatch:!!memeMatch,
  })

  if (!evalRes.shouldCheck) {
    log('debug', `群 ${gid} 潜水（${evalRes.reason}, score=${evalRes.score}, prob=${evalRes.prob}）`)
    return
  }

  const isDirectToBot = evalRes.reason.includes('soft-mention') || evalRes.reason.includes('reply-to-bot')
  const lastAt = lastGroupChimeIn.get(gid) || 0
  const cdMs = isDirectToBot
    ? 6_000
    : evalRes.inActiveConvo
      ? 12_000
      : Math.max(0.5, Number(s.groupChimeInCooldownMin ?? 6)) * 60_000
  if (Date.now() - lastAt < cdMs) return

  if (chimeTimers.has(gid)) clearTimeout(chimeTimers.get(gid))
  const timer = setTimeout(() => {
    chimeTimers.delete(gid)
    void executeChimeIn(parsed, evalRes).catch((e) => log('warn', `群插话异常：${e?.message || e}`))
  }, evalRes.observeDelayMs)
  chimeTimers.set(gid, timer)
}

async function executeChimeIn(parsed,evalRes){
  const s=settings(),gid=conversationKey(parsed)
  if(s.paused || !s.groupChimeInEnabled || !(Number(s.groupChimeInProb)>0) || hasGroupPending(parsed))return
  const allowed = parsed.platform === 'wechat' ? s.allowWechatGroups : s.allowGroups
  if (!allowed.map(String).includes(String(parsed.chatId)) || inQuietHours(new Date(),s.quietStart,s.quietEnd) || lanes.get(gid)?.running) return
  lastGroupChimeIn.set(gid,Date.now())
  enqueue({...parsed,passiveContext:true},{paths:(parsed.media||[]).map(m=>m._localPath).filter(Boolean),failed:[]},{skipAppend:true,passive:true})
}

// ---------- 启动 ----------
if (typeof WebSocket === 'undefined') {
  log('error', `需要 Node 22+（内置 WebSocket），当前 ${process.version}`)
  process.exit(1)
}

process.on('unhandledRejection', (e) => log('error', `未处理的 Promise 拒绝：${e?.stack || e}`))
process.on('uncaughtException', (e) => log('error', `未捕获异常：${e?.stack || e}`))
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{
  if(stopping)return;stopping=true
  bot.stopped=true;if(wxBot)wxBot.stopped=true
  await Promise.allSettled([...pending.entries()].map(([key,buf])=>{clearTimeout(buf.timer);pending.delete(key);return flush(key,buf)}))
  const stopAt=Date.now()+12000
  while((liveJobs>0||queuedTotal()>0)&&Date.now()<stopAt)await new Promise(r=>setTimeout(r,100))
  await drainTasks(Math.max(1,stopAt-Date.now()))
  try{flushAll();flushStyleStores()}catch(e){log('error','退出持久化失败：'+e.message);process.exitCode=1}
  process.exit(process.exitCode||0)
})

ensureLayout()
const s0 = settings()
const initMemDir = process.env.MEMORY_DIR || join(WORKSPACE, 'memory')
if (treeStats(initMemDir).nodes === 0) {
  try {
    const bootRes = bootstrapTreeFromHistory(initMemDir)
    if (bootRes.addedChats || bootRes.addedFacts) {
      log('info', `[记忆树初始化] 已从历史记忆自动构建节点：对话 ${bootRes.addedChats} 条 / 印象与观察 ${bootRes.addedFacts} 条`)
    }
  } catch {}
}
log('info', `启动 v3：ws=${WS_URL} users=[${s0.allowUsers}] groups=[${s0.allowGroups}] atOnly=${s0.atOnly} model=${s0.model} provider=${s0.llmProvider} chimeProb=${s0.groupChimeInProb} tree=${JSON.stringify(treeStats(initMemDir))}`)

if (!s0.allowUsers.length && !s0.allowGroups.length && !s0.wechatEnabled && !s0.allowAnyone) {
  log('error', '拒绝启动：没有配置任何白名单。去 WebUI 的「设置」里填你的 QQ，或设 ALLOW_ANYONE=true')
  log('warn','仅启动管理界面，设置白名单后才接收聊天')
}

initPlugins({
  sendToTarget: async (targetObj, text) => {
    return say({...targetObj,kind:targetObj.kind||'private',chatId:String(targetObj.chatId)},text,{raw:true})
  },
  sendRawSegment:(targetObj,segments)=>clientFor(targetObj).send(targetObj,segments),
  publicUrl,
  callOneBot: (action, params, timeout) => bot.callWithResult(action, params, timeout),
  callWechat: (action,params,timeout) => {if(!wxBot?.connected)throw new Error("微信桥尚未连接");return wxBot.callWithResult(action,params,timeout)},
})

startWeb({
  callWechat:(action,params,timeout)=>{if(!wxBot?.connected)throw new Error('微信桥尚未连接');return wxBot.callWithResult(action,params,timeout)},
  callOneBot: (action, params, timeout) => bot.callWithResult(action, params, timeout),
  onReconnect: () => bot.forceReconnect(),
  onDeleteChat: (chatId) => {
    delete sessions[String(chatId)]
    saveSessions(sessions)
    resetAgentSession(chatId)
  },
  onSendChat:async({chatId,kind,text,platform='qq'})=>{
    const targetKind = kind === 'group' ? 'group' : 'private'
    const cid = String(chatId || '').trim()
    const cleanText = String(text || '').trim()
    if (!cid || !cleanText) throw new Error('目标或消息为空')
    const parsedDir = parseDirectives(cleanText)
    const msgText = parsedDir.text.trim()
    if (msgText) await say({kind:targetKind,chatId:cid,platform,adminSession:true},msgText, { raw: true })
    if (parsedDir.actions.length) await act({kind:targetKind,chatId:cid,platform,adminSession:true},parsedDir.actions,{manual:true})
    const selfName = String(settings().botName || '').trim() || getSelf().name || '肥鱼'
    const row = appendChat({
      role: 'assistant', id: getSelf().id || 'bot', name: selfName, kind:targetKind,platform,chat:cid,
      text: msgText || cleanText, manualFromWebui: true,
    })
    push('msg', { ...row, ts: row.ts })
    log('info', `[webui代发] Bot → ${targetKind}/${cid}：${(msgText || cleanText).slice(0, 80)}`)
    return { sent: true, chatId: cid, kind: targetKind }
  },
  getState: () => ({
    busy: liveJobs > 0,
    queued: queuedTotal(),
    running: liveJobs,
    lanes: [...lanes.entries()].map(([k, v]) => ({ lane: k, queued: v.queue.length, running: v.running })),
    wsConnected,
    scheduler:schedulerState(),
    wechat:{enabled:settings().wechatEnabled,connected:Boolean(wxBot?.connected),capabilities:wxBot?.capabilities||{}},
    wsAttempt: bot.attempt || 0,
    wsRetrying: !!bot.timer,
    wsUrl: WS_URL,
    sessions: Object.keys(sessions).length,
    sessionDetails: sessions,
    paused: settings().paused,
    proactive: proactiveState(),
    plugins: pluginRegistryStatus(),
    abilities: renderAbilityCatalog(),
    memoryTree: treeStats(process.env.MEMORY_DIR || join(WORKSPACE, 'memory')),
  }),
})

bot.startWatchdog()
bot.startHeartbeat()
bot.connect()
ensureWechat()
const wxConfigTimer=setInterval(ensureWechat,10000);wxConfigTimer.unref()

startOrganizer()
startDiary()

startProactive({
  send: async (target, text) => {
    const isObj = target && typeof target === 'object'
    const chatId = String(isObj ? target.chatId : target).trim()
    const isGroup = isObj
      ? target.kind === 'group'
      : ((settings().allowGroups || []).map(String).includes(chatId) || Boolean(getGroupInfo(chatId)))
    await say({ kind: isGroup ? 'group' : 'private', chatId }, text, { raw: true })
  },
})
