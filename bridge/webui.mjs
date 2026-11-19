import {normalizeWechatContacts,addWechatThreads} from './channel-contacts.mjs'
import {activeWebToken,validSignedMedia,sameToken,signedMediaQuery} from './web-auth.mjs'
import {listPeople,getPerson} from './people-store.mjs'
import {readRecallTrace} from './recall-trace.mjs'
import {conversationKey,parseConversation,safeScopeName} from './context-scope.mjs'
import {embeddingConfig,requestEmbeddings,semanticStatus} from './semantic-memory.mjs'
import {prepareTreeQuery} from './memory-tree.mjs'
import {dashboardHost,dashboardQuote} from './dashboard-data.mjs'
// WebUI：状态 / 日志 / 思考流 / 对话 / 学习与审核(MaiBot式) / 文件 / 图库 / 设置 / 放权与扩展插件 / 记忆（bridge/webui.mjs · v2.9）
// 同一个进程里跑，所以能直接看到 onebot 的队列和 dsh/Gemini 的事件流

import http from 'node:http'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, realpathSync, writeFileSync, copyFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { extname, join, normalize, relative, resolve, sep, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearPhoneLogs, exportLogBundle, log, push, readPhoneLogs, recent, since, subscribe } from './logbus.mjs'
import { current as settings, save as saveSettings, migrateWechatContacts, publicSettings, sanitizeSettingsPatch } from './settings.mjs'
import { changeModelCatalog, connectionInfo, publicModelCatalog, readModelCatalog } from './model-settings.mjs'
import { discoverCloudVoices, publicVoiceSettings, voiceSettingsPatch } from './voice-settings.mjs'
import { changePersonaProfiles, readPersonaProfiles } from './persona-profiles.mjs'
import { memoryIdentityLinks } from './conversation-memory.mjs'
import {
  fetchRemoteModels, fetchServiceModels, isGeminiActive, listModels, resolveProvider,
  runTask, testDeepseekConnection, testGeminiConnection,
} from './runner.mjs'
import { attemptProactive } from './proactive.mjs'
import {
  auditExistingStickers, buildGalleryHashIndex, countActiveStickers, dedupeGallery,
  loadPendingStickers, organizeBatch, organizerStatus, reviewPendingSticker, sha1OfFile,
} from './organize.mjs'
import { listDiaries, writeDiary, writeImpressions } from './diary.mjs'
import { getFriendInfo, getGroupInfo, getSelf, groupAvatar, listKnownContacts, qlogo, removeContact, syncContactsDirectory } from './identity.mjs'
import { appendChat, appendDiary, appendHumanWorld, buildContext, editStickerMetadata, listExpressionsForReview, reviewExpressionAction, listReplyPairsForReview, reviewReplyPairAction, searchMemories, testStickerMatching, stickerList, readPersonImpression, readGroupImpression } from './memory.mjs'
import { listPersonaPresets } from './persona.mjs'
import { dedupeActionsWithToolLog } from './onebot-lib.mjs'
import { parseDirectives } from './reply.mjs'
import { bootstrapTreeFromHistory, forgetChatNodes, getTreeSnapshot, recallFromTree, treeStats } from './memory-tree.mjs'
import { invalidate, readJsonLines } from './store.mjs'
import { describeSkills, executeTool, renderAbilityCatalog, toolNames } from './tools.mjs'
import { executeCrossWindowAction, executeMultimodalPlugin, removeRemindersForChat } from './plugins.mjs'
import {
  isProtectedReadPath, getAuthorizedRoots, PERMISSION_LEVELS, removeCustomPluginScript,
  resolveAuthorizedPath, runToolScript, saveCustomPluginScript, scanInstalledPlugins,
} from './permissions.mjs'
import { testVisionPlugin } from './vision.mjs'
import { getBalance } from './billing.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORKSPACE = process.env.WORKDIR || '/workspace'
const MEMORY = process.env.MEMORY_DIR || join(WORKSPACE, 'memory')
const HOME = process.env.DSH_HOME || '/root/.dsh'
const PATCH_FILE = process.env.PATCH_FILE || join(HOME, 'profiles', 'headless', 'cordis.patch.yml')
const TOKEN=activeWebToken
const PORT = Number(process.env.WEB_PORT || 3081)
const STARTED = Date.now()

function effectiveModelRoutes(s) {
  const chat = resolveProvider(s)
  const embedding = embeddingConfig(s)
  const voice = publicVoiceSettings(s)
  return {
    main: {...connectionInfo(chat.baseUrl,'/chat/completions',chat.id),model:chat.model,hasKey:!!chat.key},
    vision: {...connectionInfo(s.pluginVisionBaseUrl,'/chat/completions'),model:s.pluginVisionModel,
      hasKey:!!s.pluginVisionApiKey,enabled:!!s.pluginVisionEnabled,ready:!!(s.pluginVisionBaseUrl && s.pluginVisionApiKey && s.pluginVisionModel)},
    embedding: {...connectionInfo(s.embeddingBaseUrl,'/embeddings'),model:embedding.model,hasKey:!!embedding.key,
      mode:!embedding.enabled?'off':embedding.remote?'remote':'local',requested:s.embeddingProvider==='local'?'local':'remote',
      lastFailure:embedding.remote && !!semanticStatus(MEMORY).error},
    voice: {...connectionInfo(voice.baseUrl),model:s.ttsCloudModel||s.ttsModel,provider:voice.provider,
      mode:s.ttsMode,hasKey:voice.hasKey,enabled:voice.enabled},
  }
}

const AUTH_FAIL_WINDOW_MS = 60_000
const AUTH_FAIL_LIMIT = 8
const AUTH_BLOCK_BASE_MS = 30_000
const AUTH_BLOCK_MAX_MS = 15 * 60_000
const AUTH_MAP_MAX = 5000
const authFails = new Map()

function clientKey(req) {
  const direct = String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || '').trim()
  if (direct) return direct
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  if (forwarded) return forwarded
  return String(req.socket?.remoteAddress || 'unknown')
}

function authWaitSeconds(key, now = Date.now()) {
  const rec = authFails.get(key)
  if (!rec?.blockedUntil || rec.blockedUntil <= now) return 0
  return Math.ceil((rec.blockedUntil - now) / 1000)
}

function noteAuthFailure(key, now = Date.now()) {
  if (authFails.size > AUTH_MAP_MAX) {
    for (const [k, v] of authFails) if (!v.blockedUntil || v.blockedUntil <= now) authFails.delete(k)
  }
  let rec = authFails.get(key)
  if (!rec || now - rec.first > AUTH_FAIL_WINDOW_MS) {
    rec = { first: now, count: 0, strikes: rec?.strikes || 0, blockedUntil: 0 }
  }
  rec.count += 1
  if (rec.count >= AUTH_FAIL_LIMIT) {
    rec.strikes = Math.min(6, (rec.strikes || 0) + 1)
    rec.blockedUntil = now + Math.min(AUTH_BLOCK_MAX_MS, AUTH_BLOCK_BASE_MS * 2 ** (rec.strikes - 1))
    rec.count = 0
    rec.first = now
  }
  authFails.set(key, rec)
  return authWaitSeconds(key, now)
}

function clearAuthFailures(key) {
  authFails.delete(key)
}

const INDEX_JSONL = join(process.env.WORKDIR || '/workspace', 'gallery', 'index.jsonl')

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'])
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.log': 'text/plain; charset=utf-8',
}

let getState = () => ({})
let onReconnect = null
let callOneBot = null
let callWechat = null
let onSendChat = null
let onDeleteChat = null
let wechatContactsCache={at:0,data:null}
let contactsCache = { at: 0, data: null }
let webuiSessionId = null

export function invalidateContactsCache() {
  contactsCache = { at: 0, data: null };wechatContactsCache={at:0,data:null}
}

/**
 * 自动清理历史自测脚本残留的测试数据
 */
export function purgeTestArtifacts() {
  const TEST_IDS = new Set(['20009', '20002', '30003', '40004'])
  const TEST_NAMES = new Set(['老王', '王哥', '小李', 'NAS折腾群'])
  const TEST_TEXT_RE = /(起来看显卡日志|管理员甲让你看下微信|A 私聊的秘密消息|B 会话的消息|C 群聊的公开消息)/

  const trashDir = join(MEMORY, '_trash')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  let cleanedChats = 0
  const chatFile = join(MEMORY, 'chat.jsonl')
  if (existsSync(chatFile)) {
    try {
      const lines = readFileSync(chatFile, 'utf8').split('\n').filter(Boolean)
      const removedLines = []
      const kept = lines.filter((line) => {
        try {
          const m = JSON.parse(line)
          const c = String(m.chat || '')
          const t = String(m.text || '')
          if (TEST_IDS.has(c) || (TEST_TEXT_RE.test(t) && c.length <= 6)) {
            cleanedChats += 1
            removedLines.push(line)
            return false
          }
          return true
        } catch {
          return true
        }
      })
      if (cleanedChats > 0) {
        mkdirSync(trashDir, { recursive: true })
        copyFileSync(chatFile, join(trashDir, `chat.${stamp}.bak.jsonl`))
        writeFileSync(join(trashDir, `chat.removed.${stamp}.jsonl`), removedLines.join('\n') + '\n', 'utf8')
        writeFileSync(chatFile, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
        invalidate(chatFile)
      }
    } catch {}
  }

  let cleanedContacts = 0
  const isTestContact = (c) =>
    TEST_IDS.has(String(c?.id)) ||
    (TEST_NAMES.has(String(c?.name)) && String(c?.id || '').length <= 6)

  const known = listKnownContacts()
  const contactsToRemove = [
    ...known.friends.filter(isTestContact),
    ...known.groups.filter(isTestContact),
  ]
  if (contactsToRemove.length > 0) {
    try {
      mkdirSync(trashDir, { recursive: true })
      const contactsFile = process.env.CONTACTS_FILE || join(MEMORY, 'contacts.json')
      if (existsSync(contactsFile)) {
        copyFileSync(contactsFile, join(trashDir, `contacts.${stamp}.bak.json`))
      }
    } catch {}
    for (const c of contactsToRemove) {
      if (removeContact(c.id)) cleanedContacts += 1
    }
  }

  for (const tid of TEST_IDS) {
    removeRemindersForChat(tid)
  }
  if (cleanedChats > 0 || cleanedContacts > 0) {
    invalidateContactsCache()
    log('info', `[清理残留测试数据] 已移除 ${cleanedChats} 条自测聊天记录与 ${cleanedContacts} 个自测联系人（已备份至 memory/_trash）`)
  }
  return { cleanedChats, cleanedContacts }
}

/**
 * 删除指定会话窗口（先将被删消息移入 memory/_trash/ 回收站，再从 chat.jsonl、contacts.json、reminders.json 移除）
 */
export function deleteConversation(chatId) {
  const cid = String(chatId || '').trim()
  if (!cid || cid === 'webui') return { ok: false, error: '不能删除默认直通窗口' }

  let removedMsgs = 0
  let trashFile = null
  const chatFile = join(MEMORY, 'chat.jsonl')
  if (existsSync(chatFile)) {
    try {
      const lines = readFileSync(chatFile, 'utf8').split('\n').filter(Boolean)
      const removed = []
      const kept = lines.filter((line) => {
        try {
          const m = JSON.parse(line)
          if ((cid.includes(':')?m.scope===cid || conversationKey({...m,chatId:m.chat})===cid:String(m.chat||'')===cid)) {
            removedMsgs += 1
            removed.push(line)
            return false
          }
          return true
        } catch {
          return true
        }
      })
      if (removed.length > 0) {
        const trashDir = join(MEMORY, '_trash')
        mkdirSync(trashDir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const safeCid = cid.replace(/[^a-zA-Z0-9_-]/g, '_')
        trashFile = join(trashDir, `chat.${safeCid}.${stamp}.jsonl`)
        writeFileSync(trashFile, removed.join('\n') + '\n', 'utf8')
      }
      writeFileSync(chatFile, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
      invalidate(chatFile)
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  try {
    const handoverFile = join(MEMORY, 'handover', `${safeScopeName(cid)}.md`)
    if (existsSync(handoverFile)) {
      const trashDir = join(MEMORY, '_trash')
      mkdirSync(trashDir, { recursive: true })
      const safeCid = cid.replace(/[^a-zA-Z0-9_-]/g, '_')
      copyFileSync(handoverFile, join(trashDir, `handover.${safeCid}.${Date.now()}.md`))
      unlinkSync(handoverFile)
    }
  } catch {}
  try { forgetChatNodes(MEMORY, cid) } catch {}

  const parsedScope=parseConversation(cid)
  const removedContact=parsedScope.platform==='qq'?removeContact(parsedScope.chatId):false
  const removedReminders = removeRemindersForChat(cid)
  invalidateContactsCache()
  if (onDeleteChat) onDeleteChat(cid)

  log('info', `[删除会话] 已删除会话 ${cid}（清理消息 ${removedMsgs} 条，已移入回收站 ${trashFile || '无消息'}，通讯录=${removedContact}，提醒=${removedReminders}）`)
  return { ok: true, chat: cid, removedMsgs, trashFile, removedContact, removedReminders }
}

async function fetchWechatContacts(force=false){
  if(!force&&wechatContactsCache.data&&Date.now()-wechatContactsCache.at<10000)return wechatContactsCache.data
  try{
    if(!callWechat)throw new Error('微信渠道未启用')
    const [fr,gr]=await Promise.all([callWechat('get_friend_list',{},8000),callWechat('get_group_list',{},8000)])
    if(Number(fr?.retcode)!==0||Number(gr?.retcode)!==0)throw new Error('微信联系人读取失败')
    const data={ok:true,...normalizeWechatContacts(fr.data||[],gr.data||[]),users:fr.data||[]}
    migrateWechatContacts(data)
    wechatContactsCache={at:Date.now(),data};return data
  }catch(e){return {...(wechatContactsCache.data||{friends:[],groups:[],users:[]}),ok:false,platform:'wechat',error:e.message,stale:Boolean(wechatContactsCache.data)}}
}

async function fetchContacts(force = false) {
  if (!callOneBot) {
    const known = listKnownContacts()
    return {
      ok: known.friends.length + known.groups.length > 0,
      friends: known.friends,
      groups: known.groups,
      error: '还没连上 QQ',
    }
  }
  if (!force && contactsCache.data && Date.now() - contactsCache.at < 10_000) {
    return contactsCache.data
  }
  const [fr, gr] = await Promise.all([
    callOneBot('get_friend_list', { no_cache: true }, 8000).catch(() => null),
    callOneBot('get_group_list', { no_cache: true }, 8000).catch(() => null),
  ])
  const friends = (fr?.data || []).map((f) => ({
    id: String(f.user_id),
    name: f.remark || f.nickname || String(f.user_id),
    nickname: f.nickname || '',
    remark: f.remark || '',
    avatar: qlogo(f.user_id),
  }))
  const groups = (gr?.data || []).map((g) => ({
    id: String(g.group_id),
    name: g.group_name || `群 ${g.group_id}`,
    avatar: groupAvatar(g.group_id),
    count: g.member_count,
  }))
  if (friends.length || groups.length) {
    syncContactsDirectory({ friendList: friends, groupList: groups })
  }
  const latest = listKnownContacts()
  const finalFriends = friends.length ? friends : latest.friends
  const finalGroups = groups.length ? groups : latest.groups
  const data = { ok: finalFriends.length + finalGroups.length > 0, friends: finalFriends, groups: finalGroups }
  if (data.ok) contactsCache = { at: Date.now(), data }
  return data
}

function json(res, code, body, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store', ...extraHeaders })
  res.end(buf)
}

/** 管理令牌通过请求头传递。媒体和事件流各自使用短期签名。 */
export function authed(req) {
  return sameToken(req.headers['x-web-token'] || '', TOKEN)
}



/** 把相对路径限制在 base 里，挡住 ../ */
function safePath(base, rel = '') {
  const target = resolve(base, normalize(String(rel || '.')).replace(/^([/\\])+/, ''))
  const b = resolve(base)
  if (target !== b && !target.startsWith(b + sep)) return null
  try{const canonical=realpathSync(target),root=realpathSync(b);if(canonical!==root&&!canonical.startsWith(root+sep))return null;return canonical}catch{const parent=resolve(target,'..');if(existsSync(parent)){const realParent=realpathSync(parent),root=realpathSync(b);if(realParent!==root&&!realParent.startsWith(root+sep))return null}return target}
}

function listDir(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    out.push({
      name,
      dir: st.isDirectory(),
      size: st.size,
      mtime: st.mtimeMs,
      ext: extname(name).toLowerCase(),
    })
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  return out
}

function relPath(p) {
  const full = String(p || '').replace(/\\/g, '/')
  const base = WORKSPACE.replace(/\\/g, '/').replace(/\/$/, '')
  if (full.startsWith(base + '/')) return full.slice(base.length + 1)
  return full.replace(/^\/+/, '')
}

function rawUrl(p) {
  return '/api/raw?' + signedMediaQuery(relPath(p))
}

function kindOf(m) {
  if (m.kind === 'webui' || m.platform === 'webui' || (!m.platform && String(m.chat) === 'webui')) return 'webui'
  if (m.kind === 'group' || m.kind === 'private') return m.kind
  if (getGroupInfo(m.chat)) return 'group'
  if ((settings().allowGroups || []).map(String).includes(String(m.chat))) return 'group'
  return 'private'
}

/** 补上"谁说的"、头像、图片地址、会话类型 */
function decorate(m) {
  const self = getSelf()
  const isBot = m.role === 'assistant'
  const isWebui = m.kind === 'webui' || m.platform === 'webui' || (!m.platform && String(m.chat) === 'webui')
  const id = String(isBot ? (m.id || self.id || '') : (m.id || m.chat || ''))
  const raw = String(m.name || '')
  const alias = String(settings().botName || '').trim()
  const friendName = !isBot && !isWebui && m.kind !== 'group' ? (getFriendInfo(id)?.name || '') : ''
  const name = isBot
    ? (alias || (raw && raw !== '我' ? raw : (self.name || 'DeepSeek')))
    : (isWebui ? (raw || '我') : ((raw && raw !== id) ? raw : (friendName || raw || id || '某人')))
  const images = Array.isArray(m.images) ? m.images.filter(Boolean) : []
  const userAvatar = isWebui ? '' : qlogo(id, 100)
  return {
    ...m,
    kind: kindOf(m),
    isBot,
    displayName: name,
    avatar: isBot ? '/assets/avatar.jpg' : userAvatar,
    audioUrls:(m.audio||[]).map(p=>rawUrl(p)),
    imageUrls: images.map((p) => rawUrl(p)),
  }
}

function readMessages(chat, limit = 200) {
  const file = join(MEMORY, 'chat.jsonl')
  if (!existsSync(file)) return []
  let rows = readJsonLines(file, chat ? 2400 : limit)
  if(chat)rows=rows.filter(m=>chat==='webui'?(m.kind==='webui'||m.platform==='webui'||!m.platform&&String(m.chat)==='webui'):chat.includes(':')?(m.scope||conversationKey({...m,chatId:m.chat}))===chat:String(m.chat||'')===String(chat))
  return rows.slice(-limit)
    .map((m) => { try { return decorate(m) } catch { return null } })
    .filter(Boolean)
}

function readModel() {
  const s = settings()
  const prov = resolveProvider(s)
  return prov.model || s.model || PROVIDER_DEFAULT.deepseek
}

const PROVIDER_DEFAULT = { gemini: 'gemini-3.8-flash', deepseek: 'deepseek-chat' }

/**
 * v3.1：支持切换任意模型 ID（含 deepseek-reasoner、硅基流动 org/model、带冒号变体等），
 * 并自动同步更新对应渠道的模型字段。
 */
function writeModel(model) {
  const clean = String(model || '').trim()
  if (!clean || !/^[a-zA-Z0-9._:/-]+$/.test(clean)) throw new Error('模型名不合法')
  const s = settings()
  const patch = { model: clean }
  if (/^gemini-/i.test(clean)) {
    patch.llmProvider = 'gemini'
    patch.geminiModel = clean
  } else {
    const hasDsKey = Boolean(String(s.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '').trim())
    if (hasDsKey || s.llmProvider === 'deepseek' || s.llmProvider === 'auto') {
      patch.llmProvider = 'deepseek'
    }
    patch.deepseekModel = clean
  }
  saveSettings(patch)
  log('info', `模型切换至 ${clean}（渠道 ${patch.llmProvider || s.llmProvider || 'auto'}），会话历史保留`)
  return clean
}

function dashboardActivity(timeZone) {
  let calendar
  try { calendar = new Intl.DateTimeFormat('sv-SE',{timeZone:timeZone||undefined,year:'numeric',month:'2-digit',day:'2-digit'}) }
  catch { calendar = new Intl.DateTimeFormat('sv-SE',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}) }
  const dayMs = 86400000
  const today = Date.parse(calendar.format(new Date()) + 'T00:00:00Z')
  const days = Array.from({length:7},(_,index)=>({date:new Date(today-(6-index)*dayMs).toISOString().slice(0,10),received:0,sent:0}))
  const buckets = new Map(days.map(day=>[day.date,day]))
  const rotations = existsSync(MEMORY) ? readdirSync(MEMORY).filter(name=>/^chat\.\d+\.jsonl$/.test(name) && Number(name.split('.')[1])>=today-7*dayMs).sort().reverse() : []
  const seen = new Set()
  let partial = rotations.length>4
  for (const name of ['chat.jsonl',...rotations.slice(0,4)]) {
    const rows = readJsonLines(join(MEMORY,name),4000)
    if (rows.length>=4000 && Number(rows[0]?.ts)>today-7*dayMs) partial = true
    for (const row of rows) {
      const ts = Number(row?.ts)
      if (!Number.isFinite(ts)) continue
      if ((row.role!=='user' && row.role!=='assistant') || ts<today-7*dayMs || ts>today+2*dayMs || row.text==='已添加好友，随时开聊') continue
      const day = buckets.get(calendar.format(ts))
      if (!day) continue
      const key = `${row.scope||row.chat}:${row.role}:${row.messageId||ts}`
      if (seen.has(key)) continue
      seen.add(key)
      if (row.role==='assistant') day.sent++
      else day.received++
    }
  }
  return { days, partial }
}

function listGallery() {
  const dir = safePath(WORKSPACE, settings().galleryDir || 'gallery')
  if (!dir || !existsSync(dir)) return []
  const workspace = realpathSync(WORKSPACE)
  const stickers = new Map(stickerList(Infinity,dir).map(item=>[item.localPath,item]))
  const out = []
  const walk = (d, depth) => {
    for (const e of listDir(d)) {
      const full = join(d, e.name)
      if (e.dir) { if (depth < 2) walk(full, depth + 1); continue }
      if (!IMAGE_EXT.has(e.ext)) continue
      const relGallery = full.slice(dir.length + 1).replace(/\\/g, '/')
      const path = relative(workspace, full).replace(/\\/g, '/')
      const sticker = stickers.get(full)
      out.push({
        name: e.name,
        cat: relGallery.includes('/') ? relGallery.split('/')[0] : '未分类',
        path,
        size: e.size,
        mtime: e.mtime,
        url: rawUrl(path),
        sticker: sticker ? {name:sticker.name,tags:sticker.tags,scene:sticker.scene,edited:sticker.edited} : undefined,
      })
    }
  }
  walk(dir, 0)
  return out.sort((a, b) => b.mtime - a.mtime)
}

function memoryFiles() {
  const out = []
  const push2 = (rel) => {
    const full = join(MEMORY, rel)
    try {
      const st = statSync(full)
      if (st.isFile()) out.push({ file: rel.replace(/\\/g, '/'), size: st.size, mtime: st.mtimeMs })
    } catch {}
  }
  push2('profile.md')
  push2('core_memory.md')
  push2('human-world.md')
  push2('style/slang.md')
  for (const d of listDiaries(60)) {
    out.push({ file: d.file, size: d.size, mtime: d.mtime })
  }
  for (const sub of ['events', 'people', 'handover', 'archives']) {
    const d = join(MEMORY, sub)
    if (!existsSync(d)) continue
    for (const e of listDir(d)) if (!e.dir) out.push({ file: `${sub}/${e.name}`, size: e.size, mtime: e.mtime })
  }
  return out
}

async function readBody(req, limit = 1 << 20) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > limit) throw new Error('body too large')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

export function startWeb(opts = {}) {
  if (opts.getState) getState = opts.getState
  if (opts.callOneBot) callOneBot = opts.callOneBot
  if (opts.callWechat) callWechat = opts.callWechat
  if (opts.onReconnect) onReconnect = opts.onReconnect
  if (opts.onSendChat) onSendChat = opts.onSendChat
  if (opts.onDeleteChat) onDeleteChat = opts.onDeleteChat

  // Production startup never deletes records based on test-looking IDs or names.

  // v2.9.1：仍在使用内置默认口令时明确告警（不再静默放行旧密码）

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const p = url.pathname

    if(p==='/health' && req.method==='GET')return json(res,200,{ok:true,version:'3.6.1'})
    if (p === '/' || p === '/index.html') {
      try {
        const html = readFileSync(join(HERE, 'ui.html'))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        return res.end(html)
      } catch {
        return json(res, 500, { ok: false, error: 'ui.html 缺失' })
      }
    }

    if (p.startsWith('/assets/')) {
      const file = safePath(join(HERE, 'assets'), p.slice('/assets/'.length))
      if (!file || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { ok: false, error: 'not found' })
      const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
      res.writeHead(200, { 'content-type': type, 'cache-control':'no-cache' })
      return createReadStream(file).pipe(res)
    }

    if (p === '/api/stream') {
      const streamTicket = req.method === 'GET' && url.searchParams.get('path') === '/api/stream' && validSignedMedia(url)
      const signedAttempt = url.searchParams.has('sig') && url.searchParams.has('expires')
      const key = clientKey(req)
      const blockedFor = authWaitSeconds(key)
      if (blockedFor) return json(res, 429, { ok: false, error: 'too many attempts' }, { 'retry-after': String(blockedFor) })
      if (!streamTicket && !authed(req)) {
        if (!signedAttempt) {
          const wait = noteAuthFailure(key)
          if (wait) return json(res, 429, { ok: false, error: 'too many attempts' }, { 'retry-after': String(wait) })
        }
        return json(res, 401, { ok: false, error: 'unauthorized' })
      }
      clearAuthFailures(key)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      const after = Number(url.searchParams.get('after') || 0)
      for (const ev of since(after)) res.write(`data: ${JSON.stringify(ev)}\n\n`)
      const unsub = subscribe((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`))
      const hb = setInterval(() => res.write(': hb\n\n'), 15000)
      req.on('close', () => { clearInterval(hb); unsub() })
      return
    }

    if (!p.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not found' })
    const key = clientKey(req)
    const blockedFor = authWaitSeconds(key)
    if (blockedFor) return json(res, 429, { ok: false, error: 'too many attempts' }, { 'retry-after': String(blockedFor) })

    const signedAttempt = url.searchParams.has('sig') && url.searchParams.has('expires')
    const signedRaw = p === '/api/raw' && req.method === 'GET' && validSignedMedia(url)
    if (!signedRaw && !authed(req)) {
      if (signedAttempt) return json(res, 401, { ok: false, error: 'unauthorized' })
      const wait = noteAuthFailure(key)
      if (wait) return json(res, 429, { ok: false, error: 'too many attempts' }, { 'retry-after': String(wait) })
      return json(res, 401, { ok: false, error: 'unauthorized' })
    }
    clearAuthFailures(key)

    try {
      if (p === '/api/stream-ticket' && req.method === 'GET') {
        return json(res, 200, { ok: true, query: signedMediaQuery('/api/stream', 300) })
      }
      if(p==='/api/memory/people' && req.method==='GET')return json(res,200,{ok:true,items:listPeople(MEMORY)})
      if(p==='/api/auth/check'&&req.method==='GET')return json(res,200,{ok:true,version:'3.6.1'})
      if(p==='/api/wechat/contacts'&&req.method==='GET'){
        const data=await fetchWechatContacts(url.searchParams.get('force')==='1')
        return json(res,200,{...data,...getState().wechat,groups:data.groups.map(x=>({...x,group_id:x.id,group_name:x.name}))})
      }
      if(p==='/api/memory/person' && req.method==='GET'){
        const id=url.searchParams.get('id')||'',scope=url.searchParams.get('scope')||''
        const profile=scope==='legacy'?listPeople(MEMORY).find(x=>x.id===id&&x.legacy):getPerson(MEMORY,id,scope)
        return json(res,200,{ok:true,profile,versions:profile?.versions||[]})
      }
      if(p==='/api/memory/recall' && req.method==='GET'){
        const query=url.searchParams.get('query')||'',chat=url.searchParams.get('chat')||'',kind=url.searchParams.get('kind')||'private'
        const ctx=chat?parseConversation(chat,kind):{allScopes:true}
        await prepareTreeQuery(query,MEMORY,ctx)
        return json(res,200,{ok:true,items:recallFromTree(query,MEMORY,{...ctx,limit:20}),engine:semanticStatus(MEMORY)})
      }
      if(p==='/api/memory/trace' && req.method==='GET'){
        const chat=url.searchParams.get('chat')||''
        const items=readRecallTrace(MEMORY,chat.includes(':')?chat:'').filter(x=>!chat||chat.includes(':')||x.scope?.endsWith(':'+chat))
        return json(res,200,{ok:true,items})
      }
      if (p === '/api/clientlog' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        log('warn', `[前端报错] ${String(body.msg || '').slice(0, 300)} @ ${String(body.src || '').slice(-60)}:${body.line || 0}`)
        return json(res, 200, { ok: true })
      }

      if (p === '/api/balance' && req.method === 'GET') {
        const b = await getBalance(url.searchParams.get('force') === '1')
        return json(res, 200, b)
      }

      if (p === '/api/state' && req.method === 'GET') {
        const exprRev = listExpressionsForReview()
        const pendingStks = loadPendingStickers()
        return json(res, 200, {
          ok: true,
          uptime: Math.round((Date.now() - STARTED) / 1000),
          model: readModel(),
          models: listModels(),
          personaPresets: listPersonaPresets(),
          permissionLevels: PERMISSION_LEVELS,
          authorizedRoots: getAuthorizedRoots(),
          installedPlugins: scanInstalledPlugins(),
          skillDetails: describeSkills(),
          settings: publicSettings(),
          peopleCount:listPeople(MEMORY).length,
          workspace: WORKSPACE,
          memory: MEMORY,
          patchFile: PATCH_FILE,
          hasToken: !!TOKEN,
          self: getSelf(),
          reviewCounts: {
            expressions: exprRev.counts,
            pendingExpressions: exprRev.counts.pending,
            approvedExpressions: exprRev.counts.approved,
            pendingStickers: pendingStks.length,
            activeStickers: countActiveStickers(),
          },
          ...getState(),
        })
      }

      if (p === '/api/dashboard/activity' && req.method === 'GET') {
        return json(res, 200, {ok:true,...dashboardActivity(url.searchParams.get('tz'))})
      }

      if (p === '/api/dashboard/host' && req.method === 'GET') {
        return json(res, 200, {ok:true,...await dashboardHost(WORKSPACE)})
      }

      if (p === '/api/dashboard/quote' && req.method === 'GET') {
        return json(res, 200, {ok:true,...await dashboardQuote(url.searchParams.get('kind'))})
      }

      // ---------- MaiBot 式学习与审核中心 API ----------
      if (p === '/api/review/expressions' && req.method === 'GET') {
        const status = url.searchParams.get('status') || 'all'
        return json(res, 200, { ok: true, ...listExpressionsForReview({ status }) })
      }

      if (p === '/api/review/expressions' && req.method === 'POST') {
        const body = await readBody(req)
        const r = reviewExpressionAction(body)
        return json(res, r.ok ? 200 : 400, r)
      }

      if (p === '/api/review/stickers' && req.method === 'GET') {
        const list = loadPendingStickers().map((it) => ({
          ...it,
          url: rawUrl(it.localPath || it.path),
        }))
        return json(res, 200, {
          ok: true,
          items: list,
          pending: list,
          count: list.length,
          activeStickerCount: countActiveStickers(),
        })
      }

      if (p === '/api/review/stickers' && req.method === 'POST') {
        const body = await readBody(req)
        if (body.action === 'audit_existing') {
          const ar = auditExistingStickers({ moveTo: body.moveTo || '待审核' })
          const list = loadPendingStickers().map((it) => ({
            ...it,
            url: rawUrl(it.localPath || it.path),
          }))
          return json(res, 200, { ok: true, ...ar, pending: list, activeStickerCount: countActiveStickers() })
        }
        const r = reviewPendingSticker(body)
        const list = (r.pending || []).map((it) => ({
          ...it,
          url: rawUrl(it.localPath || it.path),
        }))
        return json(res, 200, { ...r, items: list, pending: list, count: list.length })
      }

      // ---------- v2.7 新增：固定功能脚本与外部扩展插件管理 API ----------
      if (p === '/api/plugins/custom' && req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          authorizedRoots: getAuthorizedRoots(),
          permissionLevels: PERMISSION_LEVELS,
          plugins: scanInstalledPlugins(),
        })
      }

      if (p === '/api/plugins/custom' && req.method === 'POST') {
        const body = await readBody(req)
        if (body.action === 'delete' && body.fileName) {
          const r = removeCustomPluginScript(body.fileName)
          return json(res, r.ok ? 200 : 400, r)
        }
        const r = saveCustomPluginScript(body)
        return json(res, r.ok ? 200 : 400, r)
      }

      if (p === '/api/tools/run' && req.method === 'POST') {
        const body = await readBody(req)
        const tool = String(body.tool || '').trim()
        const args = Array.isArray(body.args) ? body.args.map(String) : []
        let scriptRel = ''
        if (tool === 'skyland') scriptRel = 'tools/skyland.mjs'
        else if (tool === 'tarot') scriptRel = 'tools/tarot.mjs'
        else if (tool === 'fortune' || tool === 'fun-tools') scriptRel = 'tools/fun-tools.mjs'
        else if (tool === 'memewiki') scriptRel = 'tools/memewiki.mjs'
        else if (tool === 'tts') scriptRel = 'tools/tts.mjs'
        else if (tool === 'qzone') scriptRel = 'tools/qzone.mjs'
        else if (tool.startsWith('tools/') || tool.startsWith('plugins/')) scriptRel = tool
        else return json(res, 400, { ok: false, error: '未知工具名称' })

        const r = await runToolScript(scriptRel, ['--json', ...args], 30000)
        let parsedOut = null
        try { parsedOut = JSON.parse(r.stdout || '{}') } catch {}
        const imageUrl = parsedOut?.imagePath
          ? rawUrl(parsedOut.imagePath)
          : ''
        return json(res, 200, {
          ok: r.ok,
          result: parsedOut || { summary: r.stdout || r.stderr || r.error || '' },
          imageUrl,
          stdout: r.stdout,
          stderr: r.stderr,
        })
      }

      if (p === '/api/gemini/test' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        const r = await testGeminiConnection(body)
        return json(res, 200, { ...r, reply: r.text || '' })
      }

      if (p === '/api/deepseek/test' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        const r = await testDeepseekConnection(body)
        return json(res, 200, { ...r, reply: r.text || '' })
      }

      if (p === '/api/models/discover' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        if (Object.hasOwn(body ?? {}, 'serviceId')) {
          const s = settings()
          const { services } = readModelCatalog(s, resolveProvider(s))
          const service = services.find(item => item.id === body.serviceId)
          if (!service) return json(res, 400, { ok: false, error: '所选服务商已不存在' })
          if (service.driver === 'dsh') return json(res, 400, { ok: false, error: '本机 DSH 不提供模型列表' })
          if (!service.baseUrl) return json(res, 400, { ok: false, error: '请先在「服务商」保存接口地址' })
          try {
            const models = await fetchServiceModels(service)
            return json(res, 200, { ok: true, models })
          } catch (error) {
            return json(res, 502, { ok: false, error: error.message })
          }
        }
        const models = await fetchRemoteModels(body)
        return json(res, 200, { ok: true, models, current: readModel() })
      }

      if (p === '/api/models/test-role' && req.method === 'POST') {
        try {
          const {role,service:id,model} = await readBody(req)
          const s = settings()
          const {services} = readModelCatalog(s,resolveProvider(s))
          const service = services.find(item => item.id === id)
          if (!service || !service.apiKey || !service.baseUrl || service.driver === 'dsh') throw Error('请先选择已配置接口地址和 API Key 的远端服务商')
          if (typeof model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,200}$/.test(model)) throw Error('请填写有效的模型 ID')
          const connection = connectionInfo(service.baseUrl,role==='embedding'?'/embeddings':'/chat/completions')
          if (connection.nativeDashscope) throw Error('请选用百炼 OpenAI 兼容接口')
          if (role === 'embedding') {
            const cfg = embeddingConfig({embeddingEnabled:true,embeddingProvider:'openai',embeddingApiKey:service.apiKey,embeddingBaseUrl:service.baseUrl,embeddingModel:model})
            const [vector] = await requestEmbeddings(cfg,['鲸鱼窝向量接口测试'])
            return json(res,200,{ok:true,model,dimension:vector.length})
          }
          let result
          if (role === 'vision') {
            result = await testVisionPlugin({pluginVisionApiKey:service.apiKey,pluginVisionBaseUrl:service.baseUrl,pluginVisionModel:model})
          } else if (role === 'main') {
            result = service.driver === 'gemini'
              ? await testGeminiConnection({geminiApiKey:service.apiKey,geminiBaseUrl:service.baseUrl,geminiModel:model,geminiProxy:service.proxy,apiProxy:''})
              : await testDeepseekConnection({deepseekApiKey:service.apiKey,deepseekBaseUrl:service.baseUrl,deepseekModel:model,apiProxy:service.proxy})
          } else throw Error('未知模型用途')
          if (!result.ok) throw Error(String(result.error || '没有收到有效结果').split(service.apiKey).join('[已隐藏]').slice(0,250))
          return json(res,200,{ok:true,model})
        } catch (error) { return json(res,400,{ok:false,error:error.message}) }
      }

      // v2.9 新增：Anysearch 实时联网搜索 API
      if (p === '/api/websearch' && req.method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim()
        if (!q) return json(res, 400, { ok: false, error: 'q is required' })
        const r = await runToolScript('websearch.mjs', [q, '--json'], 25000)
        let parsed = null
        try { parsed = JSON.parse(r.stdout || '{}') } catch {}
        return json(res, 200, parsed || { ok: r.ok, summary: r.stdout || r.stderr, results: [] })
      }

      // v2.9 新增：LivingMemory 长期记忆检索 API
      if (p === '/api/memory/search' && req.method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim()
        const results = searchMemories(q, MEMORY, 20)
        return json(res, 200, { ok: true, query: q, results })
      }

      // v2.9 新增：表情包管理器智能配图测试台 API
      if (p === '/api/gallery/test_match' && (req.method === 'GET' || req.method === 'POST')) {
        let text = String(url.searchParams.get('text') || '').trim()
        if (!text && req.method === 'POST') {
          const body = await readBody(req).catch(() => ({}))
          text = [body.text,body.reply].filter(Boolean).join(' ').trim()
        }
        const gDir = join(WORKSPACE, settings().galleryDir || 'gallery')
        const matchRes = testStickerMatching(text, gDir)
        if (matchRes.picked) matchRes.picked.previewUrl = rawUrl(relative(WORKSPACE,matchRes.picked.localPath).replace(/\\/g,'/'))
        return json(res, 200, matchRes)
      }

      // v2.9 新增：self-learning 问答接梗对审核 API
      if (p === '/api/review/reply_pairs') {
        if (req.method === 'POST') {
          const body = await readBody(req).catch(() => ({}))
          const r = reviewReplyPairAction(body, MEMORY)
          return json(res, 200, r)
        }
        const status = url.searchParams.get('status') || 'all'
        const r = listReplyPairsForReview({ status, root: MEMORY })
        return json(res, 200, { ok: true, ...r })
      }

      // v3.2 升级：联想记忆树快照（若树为空自动从历史文件回填）+ 启发式回忆沙盒 + 一键重建
      if (p === '/api/memory/tree' && req.method === 'GET') {
        const limit = Math.max(20, Math.min(400, Number(url.searchParams.get('limit') || 160)))
        try {
          if (treeStats(MEMORY).nodes === 0) {
            try { bootstrapTreeFromHistory(MEMORY) } catch {}
          }
          return json(res, 200, { ok: true, ...getTreeSnapshot(MEMORY, { limit,
            focused:url.searchParams.get('view')==='focused',focus:url.searchParams.get('focus')||'',
            query:(url.searchParams.get('q')||'').slice(0,200),type:url.searchParams.get('type')||'all',
          }) })
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message, nodes: [], edges: [], counts: {} })
        }
      }

      if (p === '/api/memory/tree/rebuild' && req.method === 'POST') {
        try {
          const r = bootstrapTreeFromHistory(MEMORY, { reset: true })
          return json(res, 200, { ok: true, ...r, snapshot: getTreeSnapshot(MEMORY, { limit: 160 }) })
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message })
        }
      }

      if (p === '/api/memory/tree/recall' && (req.method === 'GET' || req.method === 'POST')) {
        let q = String(url.searchParams.get('q') || '').trim()
        let userId = String(url.searchParams.get('userId') || '').trim()
        if (!q && req.method === 'POST') {
          const body = await readBody(req).catch(() => ({}))
          q = String(body.q || body.query || '').trim()
          userId = String(body.userId || '').trim()
        }
        if (treeStats(MEMORY).nodes === 0) {
          try { bootstrapTreeFromHistory(MEMORY) } catch {}
        }
        const items = recallFromTree(q, MEMORY, { limit: 8, userId })
        return json(res, 200, {
          ok: true,
          query: q,
          items,
          hitIds: items.map((x) => x.id),
        })
      }

      // v3 新增：能力清单（模型可调用的工具）
      if (p === '/api/abilities' && req.method === 'GET') {
        return json(res, 200, { ok: true, catalog: renderAbilityCatalog(), tools: toolNames(), skillDetails: describeSkills() })
      }

      if (p === '/api/logs' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after') || 0)
        return json(res, 200, { ok: true, events: after ? since(after) : recent(400) })
      }

      // v2.8 新增：一键点击下载完整诊断日志 / 玩手机(ADB)专项日志
      if (p === '/api/logs/download' && req.method === 'GET') {
        const type = String(url.searchParams.get('type') || 'all').toLowerCase()
        const format = String(url.searchParams.get('format') || 'file').toLowerCase()
        const s = settings()
        const content = exportLogBundle({
          type,
          meta: {
            version: '2.9.0',
            model: readModel(),
            personaPreset: s.personaPreset || 'feiyu_tone',
            phoneEnabled: !!s.pluginPhoneEnabled,
            phoneEndpoint: s.pluginPhoneEndpoint || 'unset',
            ttsEnabled: s.pluginTtsEnabled !== false,
            qzoneEnabled: s.pluginQzoneEnabled !== false,
          },
        })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const fname = type === 'phone' ? `feiyu-phone-adb-${stamp}.log` : `feiyu-diagnostic-${type}-${stamp}.log`
        if (format === 'json') {
          return json(res, 200, { ok: true, filename: fname, content, phoneLogs: readPhoneLogs(200) })
        }
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="${fname}"`,
          'cache-control': 'no-cache',
        })
        return res.end(content)
      }

      if (p === '/api/phone/logs' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 250)
        return json(res, 200, { ok: true, lines: readPhoneLogs(limit) })
      }

      if (p === '/api/phone/logs/clear' && req.method === 'POST') {
        return json(res, 200, clearPhoneLogs())
      }

      if (p === '/api/tts/test' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        const text = String(body.text || '哼，才不是大肥鱼呢！今天的小鱼干记得准时上交').trim()
        const merged = { ...settings(), ...body, pluginTtsEnabled: true }
        const r = await executeMultimodalPlugin({ kind: 'webui', chatId: 'webui' }, { type: 'tts', value: text }, merged)
        const audioUrl = r.file ? rawUrl(r.file) : ''
        return json(res, 200, {
          ok: r.ok,
          file: r.file || '',
          audioUrl,
          provider: r.provider || 'auto',
          text: r.text || text,
          error: r.error || '',
        })
      }

      if (p === '/api/qzone/test' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        const text = String(body.text || '深海小鲸鱼今日份巡航打卡，事已至此，先吃两口小鱼干🐋').trim()
        const merged = { ...settings(), ...body, pluginQzoneEnabled: true }
        const r = await executeMultimodalPlugin({ kind: 'webui', chatId: 'webui' }, { type: 'qzone', value: text }, merged)
        return json(res, 200, r)
      }

      if (p === '/api/qzone/history' && req.method === 'GET') {
        const r = await runToolScript('tools/qzone.mjs', ['history', '--json'], 10000)
        let parsed = {}
        try { parsed = JSON.parse(r.stdout || '{}') } catch {}
        return json(res, 200, { ok: true, items: parsed.items || [] })
      }

      if (p === '/api/memewiki' && req.method === 'GET') {
        const q = url.searchParams.get('q') || ''
        const r = await runToolScript('tools/memewiki.mjs', q ? ['search', q, '--json'] : ['list', '--json'], 10000)
        let parsed = {}
        try { parsed = JSON.parse(r.stdout || '{}') } catch {}
        return json(res, 200, { ok: true, items: parsed.items || parsed.hits || [] })
      }

      if (p === '/api/memewiki' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        const term = String(body.term || '').trim()
        const meaning = String(body.meaning || '').trim()
        const usage = String(body.usage || '').trim()
        if (!term || !meaning) return json(res, 400, { ok: false, error: '梗名与释义不能为空' })
        const r = await runToolScript('tools/memewiki.mjs', ['add', term, meaning, usage, '--json'], 10000)
        let parsed = {}
        try { parsed = JSON.parse(r.stdout || '{}') } catch {}
        return json(res, 200, { ok: true, ...parsed })
      }

      if (p === '/api/reconnect' && req.method === 'POST') {
        if (!onReconnect) return json(res, 200, { ok: false, error: '重连不可用' })
        onReconnect()
        log('info', 'WebUI 触发重连 WS')
        return json(res, 200, { ok: true })
      }

      if (p === '/api/contacts' && req.method === 'GET') {
        const force = url.searchParams.get('force') === '1'
        const platform=url.searchParams.get('platform')||'qq'
        if(platform==='wechat')return json(res,200,await fetchWechatContacts(force))
        if(platform==='all'){const [qq,wechat]=await Promise.all([fetchContacts(force),fetchWechatContacts(force)]);return json(res,200,{ok:qq.ok||wechat.ok,channels:{qq:{...qq,platform:'qq'},wechat}})}
        const data=await fetchContacts(force)
        return json(res,200,{...data,platform:'qq'})
      }

      if (p === '/api/chats/delete' && req.method === 'POST') {
        const body = await readBody(req)
        const r = deleteConversation(body.chat)
        return json(res, r.ok ? 200 : 400, r)
      }

      if (p === '/api/chats' && req.method === 'GET') {
        const msgs = readMessages('', 1200)
        const map = new Map()
        for (const m of msgs) {
          const k=m.kind==='webui'?'webui':m.scope || conversationKey({...m,chatId:m.chat})
          let c = map.get(k)
          if (!c) {
            c={chat:k,targetId:m.chat,platform:m.platform||'qq',kind:m.kind,count:0,last:'',ts:0,peer:''}
            map.set(k, c)
          }
          c.count += 1
          c.last = String(m.text || '').slice(0, 60)
          c.ts = m.ts
          if (!m.isBot && m.displayName && m.displayName !== k) c.peer = m.displayName
          if (m.kind === 'group') c.kind = 'group'
          if (k === 'webui' || m.kind === 'webui') c.kind = 'webui'
        }

        const known = listKnownContacts()
        const wxContacts=await fetchWechatContacts()
        const s = settings()
        const allowSet = new Set((s.allowUsers || []).map(String))
        for (const f of known.friends) {
          const fid = String(f.id || '').trim()
          if (!fid) continue
          const existing=map.get('qq:private:'+fid)
          if (existing) {
            if (!existing.peer || existing.peer === fid) {
              existing.peer = f.name || f.remark || f.nickname || fid
            }
          } else if (f.addedAt || allowSet.has(fid)) {
            map.set('qq:private:'+fid,{
              chat:'qq:private:'+fid,targetId:fid,platform:'qq',
              kind: 'private',
              count: 0,
              last: '新加好友 · 随时开聊',
              ts: f.addedAt || 1,
              peer: f.name || f.remark || f.nickname || fid,
            })
          }
        }

        addWechatThreads(map,wxContacts,s)
        const selfName = String(s.botName || '').trim() || getSelf().name || 'DeepSeek'
        const webuiChat = map.get('webui')
        map.delete('webui')

        const pinnedWebui = {
          chat: 'webui',
          kind: 'webui',
          pinned: true,
          count: webuiChat?.count || 0,
          last: webuiChat?.last || '直接给 Bot 派活或对话 · 我发她回',
          ts: webuiChat?.ts || Date.now(),
          peer: selfName,
          title: `${selfName}`,
          avatar: '/assets/avatar.jpg',
        }

        const tnote = (id) => String(((s.targets || {})[String(id)] || {}).note || '').trim()
        const out = [...map.values()].map((c) => {
          const alias=tnote(c.chat)||(c.platform==='qq'?tnote(c.targetId):'')
          if(c.platform==='wechat')return {...c,title:alias||c.peer||c.targetId||c.chat,avatar:c.avatar||''}
          if (c.kind === 'group') {
            const g = getGroupInfo(c.targetId||c.chat)
            return { ...c, title: alias || g?.name || `群 ${c.chat}`, avatar: g?.avatar || groupAvatar(c.targetId||c.chat) }
          }
          const fInfo = getFriendInfo(c.targetId||c.chat)
          const peerName = (c.peer && c.peer !== c.chat) ? c.peer : (fInfo?.name || c.peer || c.chat)
          return { ...c, peer: peerName, title: alias || peerName || c.chat, avatar:c.platform==='wechat'?'/assets/avatar.jpg':qlogo(c.targetId||c.chat) }
        }).sort((a, b) => b.ts - a.ts)

        return json(res, 200, { ok: true, chats: [pinnedWebui, ...out] })
      }

      if (p === '/api/messages' && req.method === 'GET') {
        const chat = url.searchParams.get('chat') || ''
        const limit = Number(url.searchParams.get('limit') || 200)
        return json(res, 200, { ok: true, messages: readMessages(chat, limit) })
      }

      if (p === '/api/send' && req.method === 'POST') {
        const body = await readBody(req)
        const chatId = String(body.chat || '').trim()
        const kind = body.kind === 'group' ? 'group' : 'private'
        const text = String(body.text || '').trim()
        if (!chatId || !text) return json(res, 400, { ok: false, error: '目标或内容为空' })
        if (!onSendChat) return json(res, 500, { ok: false, error: 'OneBot 发送通道未就绪' })
        const dest=parseConversation(chatId,kind,body.platform||'qq')
        const r=await onSendChat({...dest,text})
        return json(res, 200, { ok: true, ...r })
      }

      if (p === '/api/files' && req.method === 'GET') {
        const rel = url.searchParams.get('path') || ''
        const dir=resolveAuthorizedPath(rel||'.')
        if (!dir || !existsSync(dir)) return json(res, 404, { ok: false, error: '路径不存在或未在放权目录中授权' })
        if (!statSync(dir).isDirectory()) return json(res, 400, { ok: false, error: '不是目录' })
        return json(res, 200, {
          ok: true,
          path: rel,
          authorizedRoots: getAuthorizedRoots(),
          parent: rel ? rel.split('/').slice(0, -1).join('/') : null,
          entries: listDir(dir),
        })
      }

      if (p === '/api/media-url' && req.method === 'GET') {
        const rel = url.searchParams.get('path') || ''
        const file = resolveAuthorizedPath(rel)
        if (file && isProtectedReadPath(file, { permissionLevel: 'standard' })) return json(res, 403, { ok: false, error: '凭据文件不可通过媒体地址读取' })
        if (!file || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { ok: false, error: '文件不存在' })
        return json(res, 200, { ok: true, url: rawUrl(file) })
      }

      if (p === '/api/raw' && req.method === 'GET') {
        const rel = url.searchParams.get('path') || ''
        const file=resolveAuthorizedPath(rel)
        if(file && isProtectedReadPath(file,{permissionLevel:'standard'}))return json(res,403,{ok:false,error:'凭据文件不可通过媒体地址读取'})
        if (!file || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { ok: false, error: '文件不存在' })
        const type=MIME[extname(file).toLowerCase()]||'application/octet-stream'
        const headers={'content-type':type,'cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'"}
        if(/\.(?:html?|svg|js)$/i.test(file))headers['content-disposition']='attachment'
        res.writeHead(200,headers)
        return createReadStream(file).pipe(res)
      }

      if (p === '/api/impressions' && req.method === 'POST') {
        const r = await writeImpressions({})
        return json(res, 200, { ok: !r.error, ...r })
      }

      if (p === '/api/diary' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        const r = await writeDiary({ day: body.day, force: !!body.force })
        return json(res, 200, { ok: !r.error, ...r })
      }

      if (p === '/api/organize/status' && req.method === 'GET') {
        return json(res, 200, { ok: true, ...organizerStatus() })
      }

      if (p === '/api/organize' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        const r = await organizeBatch(body.limit)
        return json(res, 200, { ok: true, ...r, status: organizerStatus() })
      }

      if (p === '/api/gallery/dedupe' && req.method === 'POST') {
        const gdir = safePath(WORKSPACE, settings().galleryDir || 'gallery')
        const r = dedupeGallery(gdir)
        return json(res, 200, { ok: true, ...r })
      }

      if (p === '/api/gallery/delete' && req.method === 'POST') {
        const body = await readBody(req)
        const gdir = safePath(WORKSPACE, settings().galleryDir || 'gallery')
        const list = Array.isArray(body.paths) ? body.paths : [body.path]
        const deleted = []
        const failed = []
        for (const rel of list) {
          const full = safePath(WORKSPACE, rel || '')
          if (!full || !existsSync(full) || !statSync(full).isFile()) { failed.push(rel); continue }
          if (gdir && !full.startsWith(gdir + sep)) { failed.push(rel); continue }
          try {
            unlinkSync(full)
            deleted.push(rel)
            try { writeFileSync(INDEX_JSONL, `${JSON.stringify({ at: Date.now(), deleted: true, path: rel })}\n`, { flag: 'a' }) } catch {}
          } catch { failed.push(rel) }
        }
        log('info', `图库删除 ${deleted.length} 张${failed.length ? `，失败 ${failed.length}` : ''}`)
        return json(res, 200, { ok: true, deleted, failed })
      }

      if (p === '/api/gallery' && req.method === 'GET') {
        return json(res, 200, { ok: true, dir: settings().galleryDir || 'gallery', images: listGallery() })
      }

      if (p === '/api/gallery/sticker-metadata' && req.method === 'POST') {
        const body = await readBody(req)
        const gdir = safePath(WORKSPACE,settings().galleryDir || 'gallery')
        const file = safePath(WORKSPACE,body.path || '')
        if (!file || !gdir || resolve(file) !== resolve(gdir,'表情包',basename(file))) return json(res,400,{ok:false,error:'只能编辑正式入库的表情包'})
        try { return json(res,200,{ok:true,sticker:{...editStickerMetadata(gdir,basename(file),body),edited:true}}) }
        catch (error) { return json(res,400,{ok:false,error:error.message}) }
      }

      if (p === '/api/gallery/add' && req.method === 'POST') {
        const body = await readBody(req)
        const src = safePath(WORKSPACE, body.path || '')
        if (!src || !existsSync(src)) return json(res, 400, { ok: false, error: '源文件不存在' })
        const gdir = safePath(WORKSPACE, settings().galleryDir || 'gallery')
        mkdirSync(gdir, { recursive: true })
        const h = sha1OfFile(src)
        const existingMap = buildGalleryHashIndex(gdir)
        if (h && existingMap.has(h)) {
          const existed = existingMap.get(h)
          return json(res, 200, { ok: true, deduped: true, dest: existed.slice(WORKSPACE.length) })
        }
        const dest = join(gdir, basename(src))
        if (dest !== src) copyFileSync(src, dest)
        log('info', `图库收录 ${body.path}`)
        return json(res, 200, { ok: true, dest: dest.slice(WORKSPACE.length) })
      }

      if (p === '/api/vision/test' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        const merged = { ...settings(), ...body }
        const r = await testVisionPlugin(merged)
        return json(res, 200, r)
      }

      if (p === '/api/phone/test' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        const endpoint = String(body.endpoint ?? settings().pluginPhoneEndpoint ?? '').trim()
        const cmd = String(body.cmd || 'status').trim()
        const r = await executeMultimodalPlugin(
          { kind: 'webui', chatId: 'webui' },
          { type: 'phone', value: cmd },
          { ...settings(), pluginPhoneEnabled: true, pluginPhoneEndpoint: endpoint }
        )
        const imageUrl = r.file ? rawUrl(r.file) : ''
        return json(res, 200, {
          ok: r.ok,
          info: r.info || r.stdout || '',
          error: r.stderr || r.error || '',
          file: r.file || '',
          imageUrl,
          phoneLogs: readPhoneLogs(50),
        })
      }

      if (p === '/api/memory' && req.method === 'GET') {
        const file = url.searchParams.get('file') || ''
        if (!file) return json(res, 200, { ok: true, files: memoryFiles() })
        const full = safePath(MEMORY, file)
        if (!full || !existsSync(full)) return json(res, 404, { ok: false, error: '不存在' })
        return json(res, 200, { ok: true, file, content: readFileSync(full, 'utf8').slice(0, 200000) })
      }

      if (p === '/api/memory' && req.method === 'POST') {
        const body = await readBody(req)
        const full = safePath(MEMORY, body.file || '')
        if (!full) return json(res, 400, { ok: false, error: '路径不合法' })
        mkdirSync(resolve(full, '..'), { recursive: true })
        writeFileSync(full, String(body.content ?? ''), 'utf8')
        log('info', `记忆写入 ${body.file}`)
        return json(res, 200, { ok: true })
      }

      if (p === '/api/settings' && req.method === 'GET') {
        return json(res, 200, { ok: true, settings: publicSettings() })
      }

      if (p === '/api/settings/voice' && ['GET','POST'].includes(req.method)) {
        const s = settings()
        if (req.method === 'GET') return json(res,200,{ok:true,voice:publicVoiceSettings(s)})
        try {
          const input = await readBody(req)
          const catalog = readModelCatalog(s,resolveProvider(s))
          const saved = saveSettings(voiceSettingsPatch(s,input,catalog))
          push('settings',{settings:publicSettings(saved)})
          return json(res,200,{ok:true,voice:publicVoiceSettings(saved)})
        } catch (error) {
          return json(res,400,{ok:false,error:error.message})
        }
      }

      if (p === '/api/settings/voice/voices' && req.method === 'POST') {
        try {
          const voices = await discoverCloudVoices(settings(),await readBody(req))
          return json(res,200,{ok:true,voices})
        } catch (error) {
          return json(res,400,{ok:false,error:error.message})
        }
      }

      if (p === '/api/settings/personas' && ['GET','POST'].includes(req.method)) {
        try {
          const input = req.method === 'POST' ? await readBody(req) : null
          const s = input ? saveSettings(changePersonaProfiles(settings(), input)) : settings()
          return json(res, 200, {ok:true, ...readPersonaProfiles(s)})
        } catch (e) { return json(res, 400, {ok:false,error:e.message}) }
      }

      if (p === '/api/settings/memory-identities' && ['GET','POST'].includes(req.method)) {
        if (req.method === 'GET') return json(res,200,{ok:true,links:memoryIdentityLinks(settings())})
        const body = await readBody(req)
        const qq = String(body?.qq || '').trim(), wechat = String(body?.wechat || '').trim()
        let links = memoryIdentityLinks(settings())
        if (body?.action === 'remove') {
          links = links.filter(link => link.qq !== qq || link.wechat !== wechat)
        } else if (body?.action === 'link') {
          const same = links.find(link => link.qq === qq && link.wechat === wechat)
          if (same) return json(res,200,{ok:true,links})
          if (links.length >= 250) return json(res,400,{ok:false,error:'身份绑定已达到上限'})
          const next = memoryIdentityLinks({memoryIdentityLinks:[...links,{qq,wechat}]})
          if (next.length !== links.length+1) return json(res,400,{ok:false,error:'账号无效、已绑定到其他人或达到上限'})
          links = next
        } else return json(res,400,{ok:false,error:'未知身份操作'})
        saveSettings({memoryIdentityLinks:links})
        return json(res,200,{ok:true,links})
      }

      if (p === '/api/settings/model-catalog' && ['GET','POST'].includes(req.method)) {
        try {
          const input = req.method === 'POST' ? await readBody(req) : null
          let s = settings()
          let catalog = readModelCatalog(s, resolveProvider(s))
          if (input) {
            const patch = changeModelCatalog(catalog, input)
            s = saveSettings(patch)
            catalog = patch.modelCatalog
            if (patch.model) push('model', {model:patch.model})
          }
          return json(res, 200, {ok:true, catalog:publicModelCatalog(catalog),effective:effectiveModelRoutes(s)})
        } catch (e) { return json(res, 400, {ok:false,error:e.message}) }
      }

      if (p === '/api/settings/conversation-impression' && req.method === 'GET') {
        const key = url.searchParams.get('scope') || ''
        const target = parseConversation(key)
        const validId = target.platform === 'qq' ? /^\d{1,20}$/.test(target.chatId) : /^[\w@.-]{1,128}$/.test(target.chatId)
        if (target.scope !== key || !validId || !['qq','wechat'].includes(target.platform)) {
          return json(res, 400, {ok:false,error:'无效的会话标识'})
        }
        const read = target.kind === 'group' ? readGroupImpression : readPersonImpression
        return json(res, 200, {ok:true, impression:read(target.chatId, MEMORY, 1200, key)})
      }

      if (p === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req)
        if (body && typeof body === 'object') {
          // 若用户在设置页单独修改了 deepseekModel 或 geminiModel，且当前渠道对应它，自动同步主 model 字段
          if (body.deepseekModel && !body.model && (body.llmProvider === 'deepseek' || (!body.llmProvider && settings().llmProvider !== 'gemini'))) {
            body.model = String(body.deepseekModel).trim()
          } else if (body.geminiModel && !body.model && body.llmProvider === 'gemini') {
            body.model = String(body.geminiModel).trim()
          }
        }
        const patch = sanitizeSettingsPatch(body || {}, body?.clearSecrets)
        const merged = saveSettings(patch)
        // The tool reads the encrypted configuration without receiving a credential in argv.
        if (Object.hasOwn(patch,'skylandToken')) {
          void runToolScript('tools/skyland.mjs', ['set-from-settings'], 15000).catch(() => {})
        }
        log('info', '设置已更新')
        const safe = publicSettings(merged)
        push('settings', { settings: safe })
        return json(res, 200, { ok: true, settings: safe })
      }

      if (p === '/api/models' && req.method === 'GET') {
        return json(res, 200, { ok: true, current: readModel(), models: listModels() })
      }

      if (p === '/api/model' && req.method === 'POST') {
        const body = await readBody(req)
        const model = writeModel(String(body.model || ''))
        push('model', { model })
        return json(res, 200, { ok: true, model })
      }

      if (p === '/api/proactive/test' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        const dry = body.dry !== false
        const r = await attemptProactive({ dryRun: dry, targetChat: body.targetChat || '', force: true })
        return json(res, 200, { ok: true, dry, result: r })
      }

      // 网页版「直接执行」对话列（chat = 'webui'，输出端对象就是 DeepSeek 自己，我发她回）
      if (p === '/api/task' && req.method === 'POST') {
        const body = await readBody(req)
        const text = String(body.text || '').trim()
        if (!text) return json(res, 400, { ok: false, error: '任务为空' })

        const userRow = appendChat({
          role: 'user',
          id: 'webui',
          name: '我',
          kind: 'webui',
          chat: 'webui',
          text,
        })
        push('msg', { ...userRow, ts: userRow.ts })
        push('task', { text, source: 'webui' })

        const s = settings()
        log('info', `[webui直通] 正在请求 ${resolveProvider(s).model}`)
        // v3：人设/记忆作为 system prompt，输入本身作为 user 消息；会话 id 固定为 webui，
        // 这样重启容器后 WebUI 直连窗口也能接着聊。
        const systemPrompt = buildContext({
          chatId: 'webui',
          userId: (s.allowUsers || [])[0] || 'webui',
          userName: '管理员',
          kind: 'webui',platform:'webui',
          chars: s.contextChars,
          recent: 40,
          inputText: text,
        })

        const result = await runTask(text, {
          sessionId: 'webui',
          tag: 'webui',
          notifyModelFailure: true,
          systemPrompt,
          ctx:{parsed:{kind:'webui',platform:'webui',chatId:'webui',name:'管理员',text},memoryRoot:MEMORY},
        })
        if (result.ok && result.sessionId) webuiSessionId = result.sessionId

        const selfName = String(s.botName || '').trim() || getSelf().name || 'DeepSeek'
        const parsedDir = parseDirectives(result.text || '')
        const dedupedActions = dedupeActionsWithToolLog(parsedDir.actions, result.toolLog)
        const artifacts=result.artifacts||[]
        const images=artifacts.filter(a=>a.kind==='image').map(a=>a.path)
        const audio=artifacts.filter(a=>a.kind==='audio').map(a=>a.path)
        const webParsed={kind:'webui',platform:'webui',chatId:'webui',name:'管理员',text}
        const legacyNames={tts:'send_voice',voice:'send_voice',image:'send_image',emoji:'send_sticker',diary:'write_diary',world:'observe_world',humanworld:'observe_world',send:'send_message',remind:'set_reminder',phone:'phone_control',adb:'phone_control',qzone:'post_qzone',search:'search_web'}
        const actionErrors=[]
        for(const a of dedupedActions){
          const name=legacyNames[a.type]
          if(!name || s.agentTools===false)continue
          const args=a.type==='send'?{target:a.target,text:a.message}:a.type==='remind'?{target:a.target,minutes:a.minutes,message:a.message}:['image','emoji'].includes(a.type)?{path:a.value,target:a.target}:['tts','voice'].includes(a.type)?{text:a.value,style:a.style,target:a.target}:['phone','adb'].includes(a.type)?{action:a.value}:a.type==='qzone'?{text:a.content||a.value,image_path:a.images?.[0]}:a.type==='search'?{query:a.value}:{text:a.value}
          const outcome=await executeTool(name,args,{parsed:webParsed,memoryRoot:MEMORY,runId:'web-legacy:'+userRow.ts})
          if(!outcome.ok)actionErrors.push(outcome.error)
          for(const artifact of outcome.artifacts||[]){const list=artifact.kind==='audio'?audio:images;if(!list.includes(artifact.path))list.push(artifact.path)}
        }
        const cleanReply = String(parsedDir.text || '').replace(/\/workspace\/[^\s，。；、)）"'`]+\.(png|jpe?g|gif|webp)/gi, (m) => {
          const p2 = m.replace(/[.,;:]+$/, '')
          if (existsSync(p2) && !images.includes(p2)) images.push(p2)
          return m
        }).trim()

        const finalReply = result.ok
          ? [cleanReply || (images.length||audio.length?'（已生成预览）':'（已执行完毕）'),...actionErrors.map(x=>'这步没完成：'+x)].join('\n')
          : `执行出错：${result.error || '未知错误'}`

        const botRow = appendChat({
          role: 'assistant',
          id: getSelf().id || 'bot',
          name: selfName,
          kind: 'webui',
          chat: 'webui',
          text: finalReply,
          images,audio,
        })
        push('msg', { ...botRow, ts: botRow.ts })
        return json(res,200,{...result,text:finalReply,images,audio,artifacts})
      }

      return json(res, 404, { ok: false, error: 'no such api' })
    } catch (e) {
      log('error', `API ${p} 失败：${e.message}`)
      return json(res, 500, { ok: false, error: e.message })
    }
  })

  server.listen(PORT, process.env.WEB_LISTEN_HOST || '0.0.0.0', () => {
    // v2.9.1：不再把口令明文打进日志（日志在 UI 里可读、也会落盘）
    const masked=TOKEN?'已配置（不在日志显示密码）':'未设置'
    log('info', `WebUI on :${PORT}（口令：${masked}）`)
  })
  return server
}

export { readModel, writeModel }
