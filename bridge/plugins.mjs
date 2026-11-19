import {canSendResource} from './resource-policy.mjs'
// 插件化扩展底座与跨窗口/语音/QQ空间/玩手机动作执行中枢（bridge/plugins.mjs · v2.8）
//
// 统一承载：
// 1. cross_chat 插件：跨窗口主动传话 [[send:目标:内容]] 与持久化定时提醒 [[remind:目标:分钟数:内容]]
// 2. sticker_boost 插件：表情包降频冷却 + 物理尺寸校验 + 待审核队列入库
// 3. phone / adb 插件（局域网 MuMu 模拟器 / 安卓手机控制）：[[phone:action:params]] -> 对接 /workspace/tools/phone-agent.mjs 并全程写入 /workspace/logs/phone-adb.log
// 4. feiyu_voice 插件（多引擎 TTS 语音条）：[[tts:要说的话]] / [[voice:要说的话]] -> 对接 /workspace/tools/tts.mjs 发送真实 OneBot record 语音段
// 5. qzone 插件（QQ空间发说说）：[[qzone:说说正文]] / [[qzone:正文|图片路径]] -> 对接 /workspace/tools/qzone.mjs 自动提取 NapCat Cookie 发布说说

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { current as settings } from './settings.mjs'
import { listKnownContacts } from './identity.mjs'
import { resolveCrossTarget } from './cross-target.mjs'
import { appendChat, galleryRoot, getStickerStats, memoryRoot, pickStickerByMood, readRecent } from './memory.mjs'
import { isLikelyStickerBuffer } from './onebot-lib.mjs'
import { enqueuePendingSticker } from './organize.mjs'
import { isVisionPluginActive } from './vision.mjs'
import { log, logPhone, push } from './logbus.mjs'
import {authorizeAction,authorizedTarget,DIRECTIVE_TOOL} from './action-policy.mjs'
import {selectVoiceStyle} from './conversation-flow.mjs'
import {resolveAuthorizedPath} from './permissions.mjs'
import {conversationKey} from './context-scope.mjs'
import {writeJsonNow} from './store.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORKSPACE = process.env.WORKDIR || '/workspace'
const REMINDERS_FILE = process.env.REMINDERS_FILE || join(WORKSPACE, 'reminders.json')

function resolveToolPath(scriptName) {
  for (const cand of [
    join(WORKSPACE, 'tools', scriptName),
    // 生产容器固定挂载点：当 WORKDIR 被隔离（如自测指向 /tmp）时仍能找到真实工具
    join('/workspace', 'tools', scriptName),
    join(HERE, '..', 'workspace', 'tools', scriptName),
    join(HERE, '..', 'workspace-seed', 'tools', scriptName),
  ]) {
    if (existsSync(cand)) return cand
  }
  return join(WORKSPACE, 'tools', scriptName)
}

const sendLog = new Map()
const SEND_LIMIT_PER_HOUR = 8
const SEND_MIN_INTERVAL_MS = 10_000

const turnsSinceLastSticker = new Map()

export function resetStickerCooldown(chatId = '') {
  if (chatId) turnsSinceLastSticker.delete(String(chatId))
  else turnsSinceLastSticker.clear()
}

export function noteStickerSent(chatId) {
  if (chatId) turnsSinceLastSticker.set(String(chatId), 0)
}

let reminders = []
let reminderTimer = null
let activeContext = {
  sendToTarget: null,
  sendRawSegment: null,
  publicUrl: null,
  callOneBot: null,
  callWechat: null,
}

export function initPlugins(ctx = {}) {
  activeContext = {
    sendToTarget: ctx.sendToTarget ?? null,
    sendRawSegment: ctx.sendRawSegment ?? null,
    publicUrl: ctx.publicUrl ?? null,
    callOneBot: ctx.callOneBot ?? null,
    callWechat: ctx.callWechat ?? null,
  }
  loadReminders()
  startReminderLoop()
  return pluginRegistryStatus()
}

// ---------- 1. 跨窗口持久化定时提醒与传话 (cross_chat) ----------

function loadReminders() {
  try {
    if (!existsSync(REMINDERS_FILE)) { reminders = []; return }
    const raw = JSON.parse(readFileSync(REMINDERS_FILE, 'utf8') || '[]')
    reminders = Array.isArray(raw) ? raw.filter((r) => r && !r.done).map(r=>r.status==='sending'?{...r,status:'unknown',error:'上次在发送期间中断，请人工核对送达情况'}:r) : []
  } catch {
    reminders = []
  }
}

function saveReminders() {
  try {
    writeJsonNow(REMINDERS_FILE, reminders)
  } catch (e) { log('error', '提醒持久化失败：'+e.message); throw e }
}

export function removeRemindersForChat(chatId) {
  const cid = String(chatId || '').trim()
  if (!cid) return 0
  const before = reminders.length
  reminders=reminders.filter(r=>cid.includes(':')?conversationKey(r)!==cid:String(r.chatId)!==cid)
  if (reminders.length !== before) saveReminders()
  return before - reminders.length
}

export function scheduleReminder({ target, kind, platform='qq', chatId, targetName, fromName, fromChat, minutes, message, nowMs = Date.now() }) {
  const delayMs = Math.max(5000, Math.round(Number(minutes || 1) * 60_000))
  const item = {
    id: `rem_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: nowMs,
    dueAt: nowMs + delayMs,
    kind: kind || 'private', platform,
    chatId: String(chatId || target),
    targetName: targetName || String(chatId || target),
    fromName: fromName || '有人',
    fromChat: String(fromChat || ''),
    minutes: Number(minutes || 1),
    message: String(message || '').trim(),
    attempts: 0,
    done: false,
  }
  reminders.push(item)
  saveReminders()
  log('info', `已设跨窗/定时提醒 [${item.id}]：${item.minutes} 分钟后 → ${item.kind}/${item.chatId} (${item.message})`)
  return item
}

export function listReminders() {
  return reminders.filter((r) => !r.done)
}

let reminderTick = null
export function tickRemindersOnce(now=Date.now()) {
  if(reminderTick) return reminderTick
  reminderTick = processReminders(now).finally(()=>{reminderTick=null})
  return reminderTick
}
async function processReminders(now) {
  let changed = false
  for (const r of reminders) {
    if (r.done || ['unknown','failed'].includes(r.status) || now < r.dueAt) continue
    try {
      const text = r.fromChat && r.fromChat !== r.chatId
        ? `叮！${r.fromName}让我到点提醒你：${r.message}`
        : `到点提醒你啦：${r.message}`
      if (!activeContext.sendToTarget) throw new Error('发送通道未就绪')
      r.status='sending';saveReminders()
      const receipt=await activeContext.sendToTarget({ kind:r.kind, chatId:r.chatId, platform:r.platform||'qq', name:r.targetName }, text)
      if(!receipt?.ok) throw Object.assign(new Error(receipt?.error || '发送未得到平台确认'),{unknown:receipt?.unknown})
      r.done = true;r.status='delivered'
      changed = true
      appendChat({
        role: 'assistant',
        name: settings().botName || '肥鱼',
        kind: r.kind,platform:r.platform||'qq',
        chat: r.chatId,
        text,
        crossWindow: true,
      })
      push('msg', { role: 'assistant', name: settings().botName || '肥鱼', kind: r.kind, chat: r.chatId, text, ts: Date.now() })
      log('info', `定时提醒已触发送达 → ${r.kind}/${r.chatId}：${text}`)
    } catch (e) {
      r.attempts = (r.attempts || 0) + 1
      changed = true
      r.error=e?.message||String(e)
      if(e.unknown){r.status='unknown';log('warn',`提醒 ${r.id} 结果不明，已暂停重发，请核对平台消息`)}
      else if (r.attempts >= 3) {
        r.status='failed'
        log('warn', `提醒 ${r.id} 连续 3 次发送失败，放弃：${e?.message || e}`)
      } else {
        r.status='pending'
        r.dueAt = Date.now() + 60_000
        log('warn', `提醒 ${r.id} 第 ${r.attempts} 次发送失败，60 秒后重试：${e?.message || e}`)
      }
    }
  }
  if (changed) {
    reminders = reminders.filter((r) => !r.done)
    saveReminders()
  }
}

function startReminderLoop() {
  if (reminderTimer) return
  reminderTimer = setInterval(() => {
    void tickRemindersOnce(Date.now()).catch(e=>log('error','提醒调度失败：'+e.message))
  }, 5000)
  reminderTimer.unref?.()
}

let crossWechatCache={at:0,data:null}
async function resolveDestination(target,s){
 let wx=crossWechatCache.data
 if(activeContext.callWechat && (!wx || Date.now()-crossWechatCache.at>15000)){
  try{
   const [f,g]=await Promise.all([activeContext.callWechat('get_friend_list',{},5000),activeContext.callWechat('get_group_list',{},5000)])
   if(Number(f?.retcode)!==0||Number(g?.retcode)!==0)throw Error('微信联系人读取失败')
   wx={friends:f.data||[],groups:g.data||[]};crossWechatCache={at:Date.now(),data:wx}
  }catch{wx=crossWechatCache.data||{friends:[],groups:[]}}
 }
 return resolveCrossTarget(target,listKnownContacts(),wx||{friends:[],groups:[]},s)
}

export async function executeCrossWindowAction(sourceParsed, action, opts = {}) {
  const s = opts.settings || settings()
  const verdict=authorizeAction(action.type==='remind'?'set_reminder':'send_message',action,sourceParsed,s,{disabled:opts.disabled,manual:opts.manual})
  if(!verdict.ok) return verdict
  const recentChats = readRecent(100, opts.root || memoryRoot)

  const rawTarget = String(action.target || '').trim()
  let resolved = null
  if (!rawTarget || rawTarget===String(sourceParsed.chatId) || rawTarget===conversationKey(sourceParsed) || /^(self|me|here|当前|我|自己|本群)$/i.test(rawTarget)) {
    resolved = {platform:sourceParsed.platform||'qq', kind: sourceParsed.kind, chatId: String(sourceParsed.chatId), name: sourceParsed.name || String(sourceParsed.chatId) }
  } else {
    resolved = await resolveDestination(rawTarget,s)
  }

  if (!resolved || !resolved.chatId) {
    log('warn', `跨窗口目标解析失败：找不到「${rawTarget}」`)
    return { ok: false, error: `找不到唯一的联系人或群「${rawTarget}」，请提供渠道和完整名称或账号` }
  }

  if(!authorizedTarget(resolved,sourceParsed,s)) return {ok:false,error:'目标不在发送授权范围内'}
  if (action.type === 'send') {
    const outText = String(action.message || '').trim()
    if(sourceParsed.chatId==='webui' && /^(self|here|me)$/i.test(rawTarget||'self'))return {ok:true,reserved:true,message:outText,chatId:'webui',kind:'webui'}
    if (!outText) return { ok: false, error: '消息内容为空' }
    if(/\[\[(?:tts|voice|emoji|image|file|phone|send):|(?:^|\s)\/workspace\/|^data:[^;]+;base64,/i.test(outText)) return {ok:false,error:'检测到媒体路径或内部指令；请调用 send_voice/send_image/send_sticker 并传 target，不能作为普通文字转发'}
    if (!activeContext.sendToTarget) return { ok: false, error: '发送通道未就绪' }

    const key = `${resolved.platform||'qq'}:${resolved.kind}:${resolved.chatId}`
    const now = Date.now()
    const hist = (sendLog.get(key) || []).filter((t) => now - t < 3600_000)
    if (hist.length && now - hist[hist.length - 1] < SEND_MIN_INTERVAL_MS) {
      return { ok: false, error: '发送太频繁，稍后再试' }
    }
    if (hist.length >= SEND_LIMIT_PER_HOUR) {
      log('warn', `跨窗口发送超出限额：${key}`)
      return { ok: false, error: '这个目标一小时内发送次数已达上限' }
    }

    // Reserve the rate-limit slot before awaiting IO, including concurrent callers.
    hist.push(now);sendLog.set(key,hist)
    let receipt
    try {receipt=await activeContext.sendToTarget(resolved,outText)} catch(e) {return {ok:false,error:e.message,unknown:Boolean(e.unknown)}}
    if(!receipt?.ok) return {ok:false,error:receipt?.error||'发送未得到平台确认',unknown:receipt?.unknown}
    // The reserved slot already accounts for this attempt.

    appendChat({
      role: 'assistant',
      name: s.botName || '肥鱼',
      kind: resolved.kind,platform:resolved.platform||'qq',
      chat: resolved.chatId,
      text: outText,
      crossFrom: sourceParsed.chatId,
    }, opts.root || memoryRoot)
    push('msg', {
      role: 'assistant',
      name: s.botName || '肥鱼',
      kind: resolved.kind,platform:resolved.platform||'qq',
      chat: resolved.chatId,
      text: outText,
      ts: Date.now(),
    })
    log('info', `跨窗口消息已送达：${sourceParsed.chatId} → ${resolved.kind}/${resolved.chatId}(${resolved.name})：${outText}`)
    return { ok: true, kind: resolved.kind, chatId: resolved.chatId, targetName: resolved.name, message: outText }
  }

  if (action.type === 'remind') {
    const item = scheduleReminder({
      target: rawTarget,
      kind: resolved.kind, platform:resolved.platform||'qq',
      chatId: resolved.chatId,
      targetName: resolved.name,
      fromName: sourceParsed.name || sourceParsed.userId,
      fromChat: sourceParsed.chatId,
      minutes: action.minutes,
      message: action.message,
    })
    return { ok: true, reminder: item }
  }

  return { ok: false, error: 'unknown-cross-action' }
}

// ---------- 2. 表情包智能补发与频率冷却控制 ----------

export function maybeAttachSticker({ parsed, replyText, existingActions = [], isTask = false, root = memoryRoot, galleryDir, randomVal } = {}) {
  const s = settings()
  const cid = String(parsed?.chatId || '')
  if (isTask) return null

  const alreadyHasEmoji = existingActions.some((a) => a.type === 'emoji' || a.type === 'image' || a.type === 'file')
  if (alreadyHasEmoji) {
    if (cid) turnsSinceLastSticker.set(cid, 0)
    return null
  }

  const baseWeight = Number(s.stickerWeight ?? 0.18)
  if (baseWeight <= 0) return null

  const cooldownTurns = Math.max(0, Number(s.stickerCooldownTurns ?? 3))
  if (cid && turnsSinceLastSticker.has(cid)) {
    const turns = turnsSinceLastSticker.get(cid)
    if (turns < cooldownTurns) {
      turnsSinceLastSticker.set(cid, turns + 1)
      return null
    }
  }

  const st = getStickerStats({
    chatId: parsed?.chatId,
    userId: parsed?.userId,
    baseWeight,
    root,
  })

  const userSentSticker = (parsed?.media || []).some((m) => m.type === 'emoji') || /\[表情包\d*\]/.test(parsed?.text || '')
  const prob = userSentSticker ? Math.min(0.48, Math.max(st.effectiveProb, 0.35)) : st.effectiveProb

  const roll = typeof randomVal === 'number' ? randomVal : Math.random()
  if (roll > prob) {
    if (cid && turnsSinceLastSticker.has(cid)) {
      turnsSinceLastSticker.set(cid, turnsSinceLastSticker.get(cid) + 1)
    }
    return null
  }

  const picked = pickStickerByMood(`${parsed?.text || ''} ${replyText || ''}`, galleryDir)
  if (!picked || !picked.path) return null
  if (cid) turnsSinceLastSticker.set(cid, 0)
  return { type: 'emoji', value: picked.path, autoMatched: true, name: picked.name }
}

function collectExistingHashes(dir, set = new Set()) {
  if (!existsSync(dir)) return set
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) collectExistingHashes(full, set)
    else if (/\.(jpe?g|png|gif|webp|bmp)$/i.test(name)) {
      try {
        const b = readFileSync(full)
        if (b.length) set.add(createHash('sha1').update(b).digest('hex').slice(0, 16))
      } catch {}
    }
  }
  return set
}

export function stealStickerIfEligible(mediaPaths = [], parsed = {}, customGalleryRoot = galleryRoot, opts = {}) {
  const s = settings()
  if (s.stickerAutoSteal === false) return []
  const requireReview = opts.requireReview !== undefined ? !!opts.requireReview : (s.stickerRequireReview !== false)
  const stickerDir = join(customGalleryRoot, '表情包')
  const pendingDir = join(customGalleryRoot, '待审核')
  const indexFile = join(customGalleryRoot, 'index.jsonl')
  mkdirSync(stickerDir, { recursive: true })
  mkdirSync(pendingDir, { recursive: true })
  const existingHashes = collectExistingHashes(customGalleryRoot)
  const stolen = []

  const rawMetaList = Array.isArray(parsed?.media) ? parsed.media : []
  const mediaMetaList = rawMetaList.filter((m) => m && m.type !== 'forward')

  for (let i = 0; i < mediaPaths.length; i++) {
    const p = mediaPaths[i]
    if (!p || !existsSync(p)) continue
    const segMeta = mediaMetaList.find((m) => m._localPath === p) || mediaMetaList[i] || {}
    if (segMeta.type === 'image' && Number(segMeta.subType || 0) !== 1 && !/\.gif$/i.test(p)) {
      log('debug', `[表情包过滤] 跳过群友分享的普通图片 ${basename(p)} (type=image, subType=0)`)
      continue
    }

    let buf
    try { buf = readFileSync(p) } catch { continue }
    if (!buf.length) continue

    const check = isLikelyStickerBuffer(buf, {
      subType: segMeta.subType ?? 1,
      summary: segMeta.summary || '',
    })
    if (!check.ok) {
      log('info', `[表情包过滤] 拒收非表情包规格图片 ${basename(p)}：${check.reason}`)
      continue
    }

    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16)
    if (existingHashes.has(hash)) continue

    if (requireReview) {
      const pendingItem = enqueuePendingSticker({
        srcPath: p,
        sha1: hash,
        name: `群聊候选_${hash.slice(0, 6)}`,
        tags: ['群聊学习'],
        reason: `来自 ${parsed.name || parsed.userId || '群友'} (群 ${parsed.chatId || ''})，待手动审核入库`,
        source: 'steal',
        from: parsed.name || parsed.userId || '',
        chat: parsed.chatId || '',
        customGallery: customGalleryRoot,
      })
      if (pendingItem) {
        existingHashes.add(hash)
        stolen.push(pendingItem.localPath)
      }
      continue
    }

    const ext = (extname(p) || '.jpg').toLowerCase()
    const dest = join(stickerDir, `stolen-${hash}${ext}`)
    if (existsSync(dest)) continue

    try {
      copyFileSync(p, dest)
      existingHashes.add(hash)
      appendFileSync(indexFile, `${JSON.stringify({
        at: Date.now(),
        to: dest,
        sha1: hash,
        category: 'sticker',
        name: `群聊表情_${hash.slice(0, 6)}`,
        tags: ['群聊学习'],
        reason: '观察学习群自动收录',
        source: 'steal',
      })}\n`, 'utf8')
      stolen.push(dest)
    } catch (e) {
      log('warn', `表情包入库失败：${e?.message || e}`)
    }
  }

  if (stolen.length) {
    log('info', `从 ${parsed.kind || 'group'}/${parsed.chatId || ''} 捕获 ${stolen.length} 张候选表情包 → ${requireReview ? '待审核队列 (gallery/待审核)' : '正式图库'}`)
  }
  return stolen
}

// ---------- 3. 多模态与局域网 MuMu 模拟器 / TTS 语音 / QQ空间说说 执行器 ----------

function runExternalTool(cmd, args = [], timeoutMs = 45000, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, cwd: WORKSPACE, env: { ...process.env, ...extraEnv } }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: err.message, unknown:Boolean(err.killed||err.signal), stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() })
      resolve({ ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() })
    })
  })
}

/**
 * 执行多模态或手机/空间插件动作：[[tts:...]] / [[voice:...]] / [[qzone:...]] / [[phone:...]] / [[adb:...]] / [[draw:...]]
 */
export async function executeMultimodalPlugin(parsed, action, customSettings = null) {
  const s={...settings(),...(customSettings||{})}
  const type = action.type === 'voice' ? 'tts' : action.type
  const verdict=authorizeAction(DIRECTIVE_TOOL[type] || type,action,parsed,s,{disabled:action.disabled,manual:action.manual})
  if(!verdict.ok) return verdict
  let delivery=parsed
  if(action.target && action.target!==String(parsed.chatId) && action.target!==conversationKey(parsed) && !/^(?:self|here|me|当前|自己|本群)$/i.test(action.target)) {
    const dest=await resolveDestination(action.target,s)
    if(!dest || !authorizedTarget(dest,parsed,s)) return {ok:false,error:'媒体目标不存在或未授权'}
    delivery={...dest,userId:parsed.userId,name:dest.name,platform:dest.platform||'qq'}
  }
  if(['tts','image','emoji','draw'].includes(type) && delivery?.chatId!=='webui' && (!activeContext.sendRawSegment||!activeContext.publicUrl))return {ok:false,error:'媒体发送通道未就绪'}
  const sendSegment=async segments=>{
    if(delivery?.chatId==='webui'||delivery?.kind==='webui')return {ok:true,reserved:true}
    if(!activeContext.sendRawSegment)return {ok:false,error:'媒体发送通道未就绪'}
    const receipt=await activeContext.sendRawSegment(delivery,segments)
    if(!receipt?.ok)throw Object.assign(new Error(receipt?.error||'媒体发送未得到平台确认'),{unknown:receipt?.unknown})
    return receipt
  }

  // 1. 手机 / MuMu 安卓模拟器控制接口（全程落盘日志到 /workspace/logs/phone-adb.log）
  if (type === 'phone' || type === 'adb') {
    const hookScript = resolveToolPath('phone-agent.mjs')
    const shScript = join(WORKSPACE, 'tools', 'adb-hook.sh')
    const ep = String(s.pluginPhoneEndpoint || '').trim()
    // 若用户已经填了模拟器地址 ep，即使忘记勾 pluginPhoneEnabled 也允许触发（除非明确设了 false 且没填地址）
    if (!s.pluginPhoneEnabled) {
      logPhone('warn', `已拦截 [[${type}:${action.value}]]：手机控制开关未开且未填写模拟器 ADB 地址 (pluginPhoneEndpoint)`)
      return { ok: false, reserved: true, error: '未开启手机控制或未配置模拟器 ADB 地址（请在 WebUI 设置填写电脑 IP:16400）' }
    }
    if (!existsSync(hookScript) && !existsSync(shScript)) {
      logPhone('error', `未找到手机控制脚本 ${hookScript}`)
      return { ok: false, reserved: true, error: '未找到 phone-agent.mjs 脚本' }
    }
    logPhone('info', `开始执行 [[${type}:${action.value}]] | 目标=${ep || '未配置'} | 触发会话=${parsed?.chatId || 'webui'}`)
    if (existsSync(hookScript)) {
      const r = await runExternalTool('node', [hookScript, action.value], 60000, {
        PLUGIN_PHONE_ENDPOINT: ep,
      })
      const lines = String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
      const lastLine = lines[lines.length - 1] || ''
      const shotFile = lastLine && existsSync(lastLine) ? lastLine : null
      const infoText = (shotFile ? lines.slice(0, -1) : lines).join('\n')
      if (infoText) {
        logPhone('info', `模拟器回传画面信息: ${infoText.replace(/\s+/g, ' ').slice(0, 220)}`)
      }

      if (!r.ok) {
        const errDetail = r.stderr || r.error || '未知 ADB 错误'
        logPhone('error', `执行 [[${type}:${action.value}]] 失败：${errDetail}`)
        return { ...r, file: null, info: infoText, error: errDetail }
      }

      logPhone('info', `执行 [[${type}:${action.value}]] 成功 | 摘要: ${infoText.replace(/\s+/g, ' ').slice(0, 120)} | 截图: ${shotFile || '无'}`)
      if (shotFile && activeContext.sendRawSegment && activeContext.publicUrl && delivery?.chatId && delivery.chatId !== 'webui') {
        await sendSegment( [{ type: 'image', data: { file: activeContext.publicUrl(shotFile) } }])
        logPhone('info', `已将模拟器最新画面截图回传至会话 ${parsed.chatId}: ${basename(shotFile)}`)
      }
      return { ...r, file: shotFile, info: infoText }
    }
    if (existsSync(shScript)) {
      return await runExternalTool('sh', [shScript, action.value], 60000, {
        PLUGIN_PHONE_ENDPOINT: ep,
      })
    }
    return { ok: true, message: 'phone hook triggered' }
  }

  // 2. 肥鱼语音合成接口（TTS · feiyu_voice · 支持局域网本地 PC 推理与云端双接口 + cute/gentle 声线 + caption 补话）
  if (type === 'tts') {
    if (s.pluginTtsEnabled === false) {
      log('info', `[肥鱼语音] 语音开关已关闭，跳过 [[tts:${action.value}]]`)
      return { ok: false, reserved: true, error: '语音合成开关已关闭' }
    }
    const ttsModulePath = resolveToolPath('tts.mjs')
    const outFile = join(WORKSPACE, 'out', `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`)
    mkdirSync(join(WORKSPACE, 'out'), { recursive: true })

    // 支持 [[tts:gentle:台词|附言]] 或 action.style / action.caption
    let rawVal = String(action.value || '').trim()
    let style = selectVoiceStyle({explicitStyle:action.style || (s.ttsStyle!=='auto'?s.ttsStyle:''),text:rawVal,context:parsed?.text || '',fallback:'cute'})
    let caption = String(action.caption || '').trim()
    const styleMatch = rawVal.match(/^(cute|gentle)\s*[:：]\s*([\s\S]+)$/i)
    if (styleMatch) {
      style = styleMatch[1].toLowerCase()
      rawVal = styleMatch[2].trim()
    }
    if (!caption && rawVal.includes('|')) {
      const parts = rawVal.split('|')
      rawVal = parts[0].trim()
      caption = parts.slice(1).join('|').trim()
    }

    try {
      let synthRes = null
      if (existsSync(ttsModulePath)) {
        const mod = await import(pathToFileURL(ttsModulePath).href)
        synthRes = await mod.synthesizeSpeech(rawVal, outFile, s, { style, mode: action.mode || s.ttsMode })
      } else {
        const ttsScript = s.pluginTtsCommand || resolveToolPath('tts.sh')
        const r = await runExternalTool('sh', [ttsScript, rawVal, outFile], 30000)
        synthRes = { ok: r.ok && existsSync(outFile), file: outFile, provider: 'tts.sh', error: r.stderr || r.error }
      }

      if (synthRes?.ok && synthRes.file && existsSync(synthRes.file)) {
        if (activeContext.sendRawSegment && activeContext.publicUrl && delivery?.chatId && delivery.chatId !== 'webui') {
          await sendSegment( [{ type: 'record', data: { file: activeContext.publicUrl(synthRes.file) } }])
          if (caption && s.ttsCaptionEnable !== false) {
            setTimeout(async () => {
              try {
                await sendSegment( [{ type: 'text', data: { text: caption } }])
              } catch {}
            }, 400)
          }
        }
        log('info', `[肥鱼语音] ${delivery?.chatId==='webui'?'已生成语音试听':'已合成并发送语音条'} (${synthRes.provider || 'tts'} · style=${style})：${basename(synthRes.file)} | 台词：「${rawVal.slice(0, 40)}」${caption ? ` | 补话：「${caption}」` : ''}`)
        return { ok: true, file:synthRes.file, reserved:delivery?.chatId==='webui', provider:synthRes.provider, style, caption, text:synthRes.text||rawVal }
      }
      log('warn', `[肥鱼语音] 合成失败：${synthRes?.error || '未知原因'}`)
      return { ok: false, error: synthRes?.error || '语音合成失败' }
    } catch (e) {
      log('error', `[肥鱼语音] 执行异常：${e.message}`)
      return { ok: false, error: e.message, unknown:Boolean(e.unknown) }
    }
  }

  // 3. QQ 空间说说发布接口（QZone · onebot-qzone / astrbot_plugin_qzone）
  if (type === 'qzone') {
    if (s.pluginQzoneEnabled === false) {
      log('info', `[QQ空间] 空间插件已关闭，跳过 [[qzone:${action.value}]]`)
      return { ok: false, reserved: true, error: 'QQ空间插件已关闭' }
    }
    const qzoneModulePath = resolveToolPath('qzone.mjs')
    try {
      const mod = await import(pathToFileURL(qzoneModulePath).href)
      const res = await mod.publishQzoneEmotion(action.content || action.value, {
        imagePaths: Array.isArray(action.images) ? action.images : [],
        callOneBot: activeContext.callOneBot,
        customSettings: s,
      })
      if (res.ok) {
        log('info', `[QQ空间] 说说已成功发布 (tid=${res.tid || 'ok'})：「${String(res.content || action.value).slice(0, 50)}」`)
      } else {
        log('warn', `[QQ空间] 说说发布未成功：${res.error}`)
      }
      return res
    } catch (e) {
      log('error', `[QQ空间] 执行异常：${e.message}`)
      return { ok: false, error: e.message, unknown:Boolean(e.unknown) }
    }
  }

  // 5. 实时联网搜索接口 (Anysearch)
  if (type === 'search') {
    if (s.websearchEnabled === false) {
      log('info', `[联网搜索] 搜索插件已关闭，跳过 [[search:${action.value}]]`)
      return { ok: false, reserved: true, error: '实时联网搜索开关已关闭' }
    }
    const searchScript = resolveToolPath('websearch.mjs')
    if (!existsSync(searchScript)) {
      log('warn', `未找到搜索脚本 ${searchScript}`)
      return { ok: false, error: '未找到 websearch.mjs 脚本' }
    }
    const q = String(action.value || action.query || '').trim()
    log('info', `[联网搜索] 执行实时检索：「${q}」`)
    try {
      const mod = await import(pathToFileURL(searchScript).href)
      const res = await mod.performWebSearch(q, {customSettings:s})
      log('info', `[联网搜索] 检索完成：「${q}」找到 ${res.results?.length || 0} 条结果 (${res.provider})`)
      return res
    } catch (e) {
      log('error', `[联网搜索] 异常：${e.message}`)
      return { ok: false, error: e.message, unknown:Boolean(e.unknown) }
    }
  }

  // 4. 外部模型生图接口（Draw）
  if (type === 'draw') {
    const drawScript = join(WORKSPACE, 'tools', 'draw.mjs')
    if (!existsSync(drawScript)) {
      log('info', `[生图预留接口] 收到 [[draw:${action.value}]]，未检测到 ${drawScript}`)
      return { ok: false, reserved: true }
    }
    const outFile = join(WORKSPACE, 'out', `draw-${Date.now()}.png`)
    mkdirSync(join(WORKSPACE, 'out'), { recursive: true })
    const r = await runExternalTool('node', [drawScript, action.value, outFile], 60000)
    if (r.ok && existsSync(outFile) && activeContext.sendRawSegment && activeContext.publicUrl) {
      await sendSegment( [{ type: 'image', data: { file: activeContext.publicUrl(outFile) } }])
      log('info', `外部模型生图已发送：${basename(outFile)}`)
      return { ok: true, file: outFile }
    }
    return r
  }

  // 5. 发送本地图片 / 表情包（供 tools.mjs 的 send_image / send_sticker / draw_tarot 调用）
  //    v3.0.1 修复：v3.0.0 漏了这两个分支，导致上述三个工具一律返回「未知插件动作 image」。
  if (type === 'image' || type === 'emoji') {
    const filePath = resolveAuthorizedPath(String(action.value || '').trim())
    if(!canSendResource(filePath,parsed,{trustedArtifact:action.trustedArtifact}))return {ok:false,error:'这份媒体不属于当前会话或公开图库'}
    if (!filePath || !existsSync(filePath)) {
      return { ok: false, error: `图片文件不存在：${filePath || '(空路径)'}` }
    }
    if (activeContext.sendRawSegment && activeContext.publicUrl && delivery?.chatId && delivery.chatId !== 'webui') {
      await sendSegment( [{ type: 'image', data: { file: activeContext.publicUrl(filePath) } }])
      if (type === 'emoji') noteStickerSent(parsed.chatId)
      log('info', `[发图] 已发送 ${type}：${basename(filePath)}`)
      return { ok: true, file: filePath }
    }
    // WebUI 直连窗口没有 QQ 通道，视为成功但不发送
    return { ok: true, file: filePath, reserved: true }
  }

  return { ok: false, error: `未知插件动作 ${type}` }
}

export function pluginRegistryStatus() {
  const s = settings()
  return {
    crossWindow: s.crossWindowEnabled !== false,
    styleLearner: s.styleLearnEnabled !== false,
    styleRequireReview: s.styleRequireReview !== false,
    stickerBooster: Number(s.stickerWeight ?? 0.18) > 0,
    stickerRequireReview: s.stickerRequireReview !== false,
    visionPlugin: {
      enabled: isVisionPluginActive(s),
      model: s.pluginVisionModel || 'Qwen/Qwen2.5-VL-72B-Instruct',
      baseUrl: s.pluginVisionBaseUrl || '',
    },
    activeReminders: listReminders().length,
    phoneControl: {
      enabled: !!s.pluginPhoneEnabled,
      endpoint: s.pluginPhoneEndpoint || '未配置 (推荐端口转发 16400)',
      hookPath: '/workspace/tools/phone-agent.mjs',
      logFile: '/workspace/logs/phone-adb.log',
    },
    ttsVoice: {
      enabled: s.pluginTtsEnabled !== false,
      provider: s.ttsProvider || 'auto',
      voice: s.ttsVoice || 'zh-CN-XiaoyiNeural',
      script: '/workspace/tools/tts.mjs',
    },
    qzone: {
      enabled: s.pluginQzoneEnabled !== false,
      hasCustomCookie: Boolean(String(s.qzoneCookie || '').trim()),
      script: '/workspace/tools/qzone.mjs',
    },
    websearch: {
      enabled: s.websearchEnabled !== false,
      provider: s.websearchProvider || 'auto',
      script: '/workspace/tools/websearch.mjs',
    },
    atmospherePerception: s.atmospherePerception !== false,
    livingMemory: s.livingMemoryEnabled !== false,
    imageDraw: {
      enabled: !!s.pluginDrawEnabled,
      script: s.pluginDrawCommand || 'node /workspace/tools/draw.mjs',
    },
  }
}
