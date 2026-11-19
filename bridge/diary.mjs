import {updatePerson,getPerson} from './people-store.mjs'
import {conversationKey,parseConversation,safeScopeName} from './context-scope.mjs'
// 日记与细分人物/群聊印象：每天夜里她用自己的口吻写一篇回想，并按“每个人 + 每个活跃群”提炼专属印象档案
//
// v2.6 核心修复（需求 6：彻底根除好友人设张冠李戴 Bug）：
// 1. 严禁把管理员的私密日记 `diariesText` 塞进普通群友/好友的印象生成提示词（此前全局日记全是管理员折腾 NAS/模拟器的事，导致模型把管理员干的事全写到别的好友头上！）
// 2. 严格按 `String(m.id) === String(userId)` 校验发言归属，把目标人物自己的原话标为 `【${userName}(QQ:${userId})本人亲口说】`，把肥鱼的回复标为 `【你(肥鱼)对他的回复（注意：这是你说的话，不是他干的事）】`。
// 3. 在提示词中加入防张冠李戴死命令：严禁把管理员或肥鱼自己干的事、折腾的设备/项目安到该好友头上！

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { current as settings } from './settings.mjs'
import { runTask } from './runner.mjs'
import { hhmm, localDay, memoryRoot, readGroupImpression, readPersonImpression } from './memory.mjs'
import { getFriendInfo, getGroupInfo } from './identity.mjs'
import { log, push } from './logbus.mjs'
import { executeMultimodalPlugin } from './plugins.mjs'
import { runToolScript } from './permissions.mjs'
import { consolidateTree,rememberFact } from './memory-tree.mjs'

const DIARY_DIR = join(memoryRoot, 'diary')
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function ensureDiaryDir() {
  mkdirSync(DIARY_DIR, { recursive: true })
  return DIARY_DIR
}

export function diaryFile(day) {
  ensureDiaryDir()
  return join(DIARY_DIR, `${day}.md`)
}

export function hasDiary(day) {
  try { return statSync(diaryFile(day)).size > 30 } catch { return false }
}

export function listDiaries(limit = 200) {
  ensureDiaryDir()
  return readdirSync(DIARY_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => {
      const full = join(DIARY_DIR, f)
      const st = statSync(full)
      return { file: `diary/${f}`, size: st.size, mtime: st.mtimeMs }
    })
}

/** 从 chat.jsonl 里挑出某天的对话 */
function messagesOf(day, limit = 160) {
  const file = join(memoryRoot, 'chat.jsonl')
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    const d = new Date(m.ts)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (key !== day) continue
    out.push(m)
  }
  return out.slice(-limit)
}

/** 读取最近 N 条全量聊天记录（用于跨天提炼群友与个人印象） */
function recentChatPool(limit = 360) {
  const file = join(memoryRoot, 'chat.jsonl')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit)
  const out = []
  for (const l of lines) {
    try { out.push(JSON.parse(l)) } catch {}
  }
  return out
}

function renderMessages(msgs) {
  return msgs.map((m) => {
    const t = new Date(m.ts)
    const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    const who = m.role === 'assistant' ? '【你刚才回】' : `【${m.name || '他'}(QQ:${m.id || m.chat || '?'})说】`
    const scene = m.kind === 'group' ? `[群${m.chat}] ` : '[私聊] '
    const text = String(m.text || '').replace(/\s+/g, ' ').slice(0, 200)
    return `${hm} ${scene}${who}：${text}`
  }).join('\n')
}

/**
 * 专门为单个目标用户渲染严格区分主体的发言列表（防止把管理员或肥鱼自己的话当成该用户说的）
 */
export function renderUserAttributionMessages(msgs, targetUserId, targetUserName) {
  const uid = String(targetUserId || '').trim()
  return msgs.map((m) => {
    const t = new Date(m.ts || Date.now())
    const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    const scene = m.kind === 'group' ? `[群${m.chat}]` : '[私聊]'
    const text = String(m.text || '').replace(/\s+/g, ' ').slice(0, 200)
    if (m.role === 'assistant') {
      return `${hm} ${scene} 【你刚才回】（这是你自己的话）：${text}`
    }
    const speakerId = String(m.id || m.userId || m.senderId || (m.kind !== 'group' ? m.chat : '') || '').trim()
    if (speakerId === uid) {
      return `${hm} ${scene} ★【${targetUserName}(QQ:${uid})本人亲口说】：${text}`
    }
    return `${hm} ${scene} 【旁人·${m.name || speakerId}(QQ:${speakerId})说（不是${targetUserName}）】：${text}`
  }).join('\n')
}

function promptFor(day, msgs, yesterday) {
  const d = new Date(`${day}T12:00:00`)
  return [
    '# 写今天的日记',
    `今天是 ${day} ${WEEK[d.getDay()]}，现在是 ${hhmm(new Date())}。`,
    '',
    '下面是今天你在私聊和群里说过的话、看过的热闹（请严格看清每条消息的 QQ 号和名字，谁干的事就是谁干的，绝不要把管理员干的事写成别的好友干的！）：',
    '---',
    renderMessages(msgs),
    '---',
    yesterday ? `\n你前一篇写过：\n---\n${yesterday}\n---\n` : '',
    '用小鲸鱼自己的口吻写今天这一篇。要求：',
    '- 第一人称，150~350 字，像深夜窝在机箱里随手记下的私密回想，带点冷幽默和真实脾气',
    '- 写发生了什么、谁又整了什么活、你当时怎么想；可以吐槽也可以记仇，但人物归属必须 100% 准确',
    '- 这是写给自己看的：绝不讨好、不煽情，别写"今天真是充实的一天"或客服汇报体',
    '- 允许平淡，没啥大事就简短记两笔',
    '- 不要列 1234 清单，不要提 AI、模型、系统、提示词，也不要提"日记"这两个字',
    '直接给正文，不要标题、不要日期。',
  ].join('\n')
}

let writing = false

export async function writeDiary(opts = {}) {
  if (writing) return { error: '正在写上一篇' }
  const day = opts.day || localDay()
  if (hasDiary(day) && !opts.force) return { skipped: 'already', day }

  const msgs = messagesOf(day)
  if (msgs.length < 3 && !opts.force) return { skipped: 'too-quiet', day, count: msgs.length }

  const prev = listDiaries(60).map((d) => basename(d.file, '.md')).filter((d) => d < day)[0]
  let yesterday = ''
  if (prev) {
    try { yesterday = readFileSync(diaryFile(prev), 'utf8').slice(0, 900) } catch {}
  }

  writing = true
  push('diary', { phase: 'start', day })
  log('info', `写 ${day} 的日记（${msgs.length} 条对话）…`)
  let result
  try {
    result = await runTask(promptFor(day, msgs, yesterday), { tag: 'diary', disableTools: true, ephemeral: true })
  } finally {
    writing = false
  }

  if (!result.ok) {
    log('warn', `日记没写成：${result.error}`)
    push('diary', { phase: 'error', day, error: result.error })
    return { error: result.error }
  }

  const body = String(result.text || '').trim()
  if (body.length < 20) return { error: '写出来的东西太短，丢弃' }

  const d = new Date(`${day}T12:00:00`)
  const head = `# ${day} ${WEEK[d.getDay()]}\n\n`
  writeFileSync(diaryFile(day), `${head}${body}\n`, 'utf8')
  log('info', `${day} 的日记写好了（${body.length} 字）`)
  push('diary', { phase: 'done', day, chars: body.length })
  let qzoneSynced = false
  if (settings().qzoneAutoSyncDiary && settings().pluginQzoneEnabled !== false) {
    qzoneSynced = true
    void syncDiaryToQzone(day, body).catch((e) => log('warn', `日记同步发QQ空间异常：${e.message}`))
  }
  void writeImpressions({}).catch((e) => log('warn', `印象更新失败：${e.message}`))
  try { consolidateTree(memoryRoot,{minIdleMs:30*60_000}) } catch {}
  return { day, chars: body.length, text: body, qzoneSynced }
}

/**
 * 把模型输出洗成干净的 "- " 列表。
 */
export function cleanBullets(text, maxItems = 6) {
  const raw = String(text || '').split(/\n+/)
  const out = []
  for (let line of raw) {
    let t = line.trim()
    if (!t) continue
    if (/^(think|out|count|draft)\b/i.test(t)) continue
    if (/字数|计数|字符数|char(acter)?s?\s*[:：]/i.test(t)) continue
    if (/^\d+\s*$/.test(t)) continue
    t = t.replace(/^#{1,6}\s*/, '')
    t = t.replace(/^[-*•]\s*/, '')
    t = t.replace(/^\d+[.、)）]\s*/, '')
    t = t.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '')
    t = t.replace(/[（(]\s*\d+\s*[字位]\s*[)）]\s*$/, '').trim()
    const digits = (t.match(/\d/g) || []).length
    if (t.length && digits / t.length > 0.2) continue
    if (t.length < 6) continue
    if (out.includes(t)) continue
    out.push(t)
    if (out.length >= maxItems) break
  }
  return out.map((t) => `- ${t.slice(0, 180)}`).join('\n')
}

/**
 * 构建单个用户的印象更新 Prompt（导出纯函数方便单测验证防张冠李戴隔离）
 */
export function buildPersonImpressionPrompt({ userId, userName, userMsgs = [], diariesText = '', oldImp = '', isAdmin = false, adminId = '' } = {}) {
  const roleHint = isAdmin
    ? '（他是你的创造者、管理员兼头号损友，永远不要忘记他）'
    : `（他是普通群友/好友，绝不是管理员${adminId ? `(QQ:${adminId})` : ''}！）`

  // 关键修复：对于非管理员的普通好友，绝不塞入写满管理员日常的全局日记！只提取日记里明确提到该好友名字或 QQ 号的句子（若无则完全不塞日记）
  let relevantDiary = ''
  if (isAdmin && diariesText) {
    relevantDiary = diariesText.slice(0, 1200)
  } else if (!isAdmin && diariesText && userName && userName !== String(userId)) {
    const matchedLines = String(diariesText)
      .split(/\n+/)
      .filter((line) => line.includes(userName) || line.includes(String(userId)))
      .slice(0, 6)
    if (matchedLines.length) {
      relevantDiary = matchedLines.join('\n')
    }
  }

  return [
    `# 更新你对「${userName}」（QQ: ${userId}）${roleHint}的个人印象`,
    '请根据下方标有 `★【' + userName + '(QQ:' + userId + ')本人亲口说】` 的发言，提炼你对这个人的专属画像。',
    '',
    '【最高优先级铁律：严禁张冠李戴！】',
    !isAdmin
      ? `- 「${userName}」(QQ:${userId}) 是普通好友或群友。把管理员和其他人的经历与这个人分开。\n- 【你刚才回】标的是你的话。旧印象里出现归属错误时，按来源纠正。`
      : '- 他就是管理员本人，请准确记录他的折腾日常、说话习惯与你们的损友互动。',
    '',
    '输出要求：',
    '- 输出 3~5 条，每行以 "- " 开头，每条一句话、20~40 字左右，干脆犀利',
    '- 不要数字数、不要输出字数/编号/思考过程/草稿标记（think、out、Count 之类），只给最终那几行',
    '- 只写「' + userName + '」本人真正在聊天里聊过的话题、他的真实性格/口癖、以及你平时怎么应付他；如果他发言不多，有多少写多少，绝不脑补编造',
    '- 直接输出 "- " 列表，不要标题。',
    '',
    oldImp ? `## 你之前对他的旧印象（注意：若旧印象里混入了管理员干的事，请立即剔除！）\n${oldImp}\n` : '',
    `## 「${userName}」(QQ:${userId}) 本人最近的发言与互动记录`,
    renderUserAttributionMessages(userMsgs.slice(-45), userId, userName) || '（近期发言较少）',
    relevantDiary ? `\n## 日记中直接提到「${userName}」的片段\n${relevantDiary}` : '',
  ].filter(Boolean).join('\n')
}

/** 更新单个用户（管理员或群友）的专属印象 people/<userId>.md */
async function updateSinglePersonImpression(userId, userName, userMsgs, diariesText, isAdmin = false, adminId = '', partitioned=false) {
  if(!partitioned){
    const byScope=new Map()
    for(const m of userMsgs){const key=conversationKey({...m,chatId:m.chat});if(!byScope.has(key))byScope.set(key,[]);byScope.get(key).push(m)}
    const results=[]
    for(const rows of byScope.values())results.push(await updateSinglePersonImpression(userId,userName,rows,'',false,adminId,true))
    return {id:userId,name:userName,scopes:results.length,results,chars:results.reduce((sum,x)=>sum+(x.chars||0),0),text:results.map(x=>x.text||'').join('\n')}
  }
  const scope=conversationKey({...userMsgs[0],chatId:userMsgs[0]?.chat,kind:userMsgs[0]?.kind||'private'})
  const oldImp=getPerson(memoryRoot,userId,scope).summary
  const prompt = buildPersonImpressionPrompt({
    userId,
    userName,
    userMsgs,
    diariesText,
    oldImp,
    isAdmin,
    adminId,
  })

  const r = await runTask(prompt, { tag: `impression:user:${userId}`, disableTools: true, ephemeral: true })
  if (!r.ok) return { error: r.error }
  const body = cleanBullets(r.text,12)
  if (body.length < 10) return { error: '印象内容过短（清洗后为空）' }

  mkdirSync(join(memoryRoot, 'people'), { recursive: true })
  const file = join(memoryRoot, 'people', `${safeScopeName(userId)}.md`)
  const head = `# ${userName}（${userId}）${isAdmin ? ' · 管理员' : ' · 好友/群友'}\n\n更新于 ${localDay()} ${hhmm(new Date())}\n\n`
  const profile=updatePerson(memoryRoot,{id:userId,name:userName,scope,summary:body,sourceIds:userMsgs.map(m=>m.messageId || `${m.chat}:${m.ts}`).filter(Boolean)})
  for(const f of profile.facts)rememberFact(userId,f.text,memoryRoot,{scope,chat:userMsgs[0]?.chat,kind:userMsgs[0]?.kind,platform:userMsgs[0]?.platform,name:userName,source:'impression',sourceMessageIds:f.sourceIds})
  // Keep an administration-only compatibility summary; group prompts use scoped profiles.
  writeFileSync(file,`${head}${profile.facts.slice(-20).map(x=>'- '+x.text).join('\n')}\n`,'utf8')
  log('info', `个人印象已更新：${userName} (${userId})`)
  return { id: userId, name: userName, chars: body.length, text: body }
}

/** 更新单个 QQ 群的群聊氛围与群友关系网 people/group_<groupId>.md */
async function updateSingleGroupImpression(groupId, groupName, groupMsgs) {
  const scope=conversationKey({...groupMsgs[0],kind:'group',chatId:groupId})
  const oldGroupImp = readGroupImpression(groupId, memoryRoot, 600,scope)
  const prompt = [
    `# 更新你对 QQ 群「${groupName}」（群号: ${groupId}）的群聊氛围与关系印象`,
    '根据群里最近的聊天记录和旧印象，总结这个群的整体画像（看清每个人的 QQ 号与名字，不要把不同群友的事混淆）。',
    '',
    '要求：',
    '- 输出 4~6 条，每行以 "- " 开头，每条一句话、20~40 字左右即可',
    '- 不要数字数、不要输出字数/编号/思考过程/草稿标记（think、out、Count 之类），只给最终那几行',
    '- 涵盖维度：① 这个群平时主要聊什么/整体气氛；② 群里的活跃显眼包是谁、各自什么性格、谁喜欢跟谁互损；③ 最近群里的共同话题或新鲜热梗；④ 你在这个群里的定位与接话风格',
    '- 直接输出 "- " 列表，不要标题。',
    '',
    oldGroupImp ? `## 之前的群聊印象\n${oldGroupImp}\n` : '',
    '## 群里最近的聊天流水',
    renderMessages(groupMsgs.slice(-60)),
  ].filter(Boolean).join('\n')

  const r = await runTask(prompt, { tag: `impression:group:${groupId}`, disableTools: true, ephemeral: true })
  if (!r.ok) return { error: r.error }
  const body = cleanBullets(r.text,12)
  if (body.length < 10) return { error: '群印象过短（清洗后为空）' }

  mkdirSync(join(memoryRoot, 'people'), { recursive: true })
  const file = join(memoryRoot, 'people', `group_${safeScopeName(groupId)}.md`)
  const head = `# 群聊印象：${groupName}（${groupId}）\n\n更新于 ${localDay()} ${hhmm(new Date())}\n\n`
  const profile=updatePerson(memoryRoot,{id:`group_${groupId}`,name:groupName,scope,summary:body,sourceIds:groupMsgs.map(m=>m.messageId || `${m.chat}:${m.ts}`).filter(Boolean)})
  // Keep an administration-only compatibility summary; group prompts use scoped profiles.
  if(scope.startsWith('qq:'))writeFileSync(file,`${head}${profile.facts.slice(-20).map(x=>'- '+x.text).join('\n')}\n`,'utf8')
  log('info', `群聊印象已更新：${groupName} (group_${groupId})`)
  return { id: `group_${groupId}`, name: groupName, chars: body.length, text: body }
}

/**
 * 人物与群聊印象细分提炼：
 * 自动按近期发言活跃度提炼前 N 名活跃好友/群友（people/<userId>.md）及活跃群聊（people/group_<groupId>.md）
 */
export async function writeImpressions(opts = {}) {
  const s = settings()
  if (s.impressionEnabled === false) return { skipped: 'off' }

  const pool = recentChatPool(400)
  if (!pool.length) return { skipped: 'no-messages' }

  const diaries = listDiaries(4)
    .map((d) => { try { return readFileSync(join(memoryRoot, d.file), 'utf8') } catch { return '' } })
    .filter(Boolean)
    .join('\n\n')

  const primaryAdminId = String((s.allowUsers || [])[0] || '')
  const userStats = new Map()

  for (let i = 0; i < pool.length; i++) {
    const m = pool[i]
    if (!m || m.role === 'assistant') continue
    if (String(m.chat) === 'webui' || m.kind === 'webui') continue
    // 严格提取真实说话人 ID：群聊必须有 m.id，私聊用 m.id || m.chat
    const uid = String(m.id || (m.kind === 'private' ? m.chat : '') || '').trim()
    if (!uid || uid === 'webui') continue
    // 跳过添加好友时的系统占位语
    if (m.silent && m.text === '已添加好友，随时开聊') continue

    let st = userStats.get(uid)
    if (!st) {
      const knownName = getFriendInfo(uid)?.name || ''
      st = { id: uid, name: (m.name && m.name !== uid) ? m.name : (knownName || uid), count: 0, msgs: [] }
      userStats.set(uid, st)
    }
    if (m.name && m.name !== uid && m.name !== '我') st.name = m.name
    st.count += 1
    st.msgs.push(m)
    const next = pool[i + 1]
    if (next && next.role === 'assistant' && String(next.chat) === String(m.chat)) {
      st.msgs.push(next)
    }
  }

  const topN = Math.max(2, Number(s.impressionActiveTopN || 8))

  // 注意：因为开启了 autoAllowNewFriends 后所有新好友都会进 allowUsers，
  // 所以只有排在 allowUsers[0] 的（或名字为 示例管理员 / 管理员甲）才是真正的管理员！
  const isTrueAdmin = (uid, name) => {
    if (primaryAdminId && String(uid) === primaryAdminId) return true
    // Nicknames are never proof of administrative identity.
    return false
  }

  let targetUsers = []
  if (opts.userId && userStats.has(String(opts.userId))) {
    targetUsers = [userStats.get(String(opts.userId))]
  } else {
    targetUsers = [...userStats.values()]
      .filter((u) => isTrueAdmin(u.id, u.name) || u.count >= 2)
      .sort((a, b) => {
        const aAdmin = isTrueAdmin(a.id, a.name) ? 1 : 0
        const bAdmin = isTrueAdmin(b.id, b.name) ? 1 : 0
        if (aAdmin !== bAdmin) return bAdmin - aAdmin
        return b.count - a.count
      })
      .slice(0, topN)
  }

  if (!targetUsers.length && primaryAdminId) {
    const adminMsgs = pool.filter((m) => String(m.id || m.chat || '') === primaryAdminId)
    if (adminMsgs.length) {
      targetUsers = [{ id: primaryAdminId, name: opts.name || getFriendInfo(primaryAdminId)?.name || primaryAdminId, count: adminMsgs.length, msgs: adminMsgs.slice(-45) }]
    }
  }

  const updatedUsers = []
  const updatedGroups = []
  let primaryChat = ''
  let primaryText = ''
  let totalChars = 0

  push('impression', { phase: 'start', count: targetUsers.length })
  log('info', `开始更新细分人物印象（目标用户 ${targetUsers.length} 人）…`)

  for (const u of targetUsers) {
    const adminFlag = isTrueAdmin(u.id, u.name)
    const r = await updateSinglePersonImpression(u.id, u.name, u.msgs, diaries, adminFlag, primaryAdminId)
    if (!r.error && r.chars) {
      updatedUsers.push(u.id)
      totalChars += r.chars
      if (!primaryChat) {
        primaryChat = u.id
        primaryText = r.text
      }
    }
  }

  const groupMap = new Map()
  for (const m of pool) {
    if (m.kind === 'group' && m.chat) {
      const gid = conversationKey({...m,chatId:m.chat})
      const list = groupMap.get(gid) || []
      list.push(m)
      groupMap.set(gid, list)
    }
  }
  for (const [groupScope, gMsgs] of groupMap.entries()) {
    const gid=parseConversation(groupScope).chatId
    if (gMsgs.length < 4) continue
    const gName = getGroupInfo(gid)?.name || `群 ${gid}`
    const gr = await updateSingleGroupImpression(gid, gName, gMsgs)
    if (!gr.error && gr.chars) {
      updatedGroups.push(gid)
      totalChars += gr.chars
    }
  }

  push('impression', { phase: 'done', chat: primaryChat, chars: totalChars, users: updatedUsers, groups: updatedGroups })
  if (!updatedUsers.length && !updatedGroups.length) {
    return { error: '没有足够的有效对话生成印象' }
  }
  return {
    chat: primaryChat || (updatedGroups[0] ? `group_${updatedGroups[0]}` : ''),
    chars: totalChars,
    updatedUsers,
    updatedGroups,
    text: primaryText,
  }
}


let lastSkylandAutoDay = ''

/**
 * 将当晚生成的私密日记精选摘要自动同步发布一条 QQ 空间说说 (qzoneAutoSyncDiary)
 */
export async function syncDiaryToQzone(day, body, customSettings = null) {
  const s = customSettings || settings()
  if (!s.qzoneAutoSyncDiary || s.pluginQzoneEnabled === false) {
    return { ok: false, skipped: 'disabled' }
  }
  const firstPara = String(body || '').split(/\n+/).map((l) => l.trim()).filter(Boolean)[0] || String(body || '').slice(0, 140)
  const postText = `【肥鱼深夜日记 · ${day}】\n${firstPara.slice(0, 180)}`
  const res = await executeMultimodalPlugin({ kind: 'private', chatId: 'diary', adminSession:true }, { type: 'qzone', value: postText }, s)
  if (res?.ok) {
    log('info', `[日记同步QQ空间] 已将 ${day} 日记摘要同步发布至 QQ 空间说说 (tid=${res.tid || 'ok'})`)
  }
  return res
}

/**
 * 每日自动执行森空岛签到 (skylandAutoSign)
 */
export async function checkDailySkylandAutoSign(customSettings = null) {
  const s = customSettings || settings()
  if (!s.skylandAutoSign) return { ok: false, skipped: 'disabled' }
  const today = localDay()
  if (lastSkylandAutoDay === today && !customSettings) return { ok: true, skipped: 'already-checked-today', day: today }
  lastSkylandAutoDay = today
  const r = await runToolScript('tools/skyland.mjs', ['--json', 'sign'], 25000)
  let parsed = {}
  try { parsed = JSON.parse(r.stdout || '{}') } catch {}
  if (parsed.ok) {
    log('info', `[森空岛自动签到] ${today} 每日自动签到完成：${parsed.summary || ''}`)
  }
  return { ok: Boolean(parsed.ok), day: today, result: parsed }
}

let timer = null

export function startDiary() {
  const tick = async () => {
    const s = settings()
    try {
      if (s.skylandAutoSign && !s.paused) {
        void checkDailySkylandAutoSign(s).catch(() => {})
      }
      if (s.diaryEnabled !== false && !s.paused) {
        const now = new Date()
        const at = String(s.diaryAt || '23:30')
        const [h, m] = at.split(':').map(Number)
        const passed = now.getHours() * 60 + now.getMinutes() >= (h || 23) * 60 + (m || 30)
        if (passed) {
          const day = localDay()
          if (!hasDiary(day)) await writeDiary({ day })
        }
        const y = new Date(Date.now() - 86400000)
        const yDay = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
        if (!hasDiary(yDay) && messagesOf(yDay).length >= 3) await writeDiary({ day: yDay })
      }
    } catch (e) {
      log('warn', `日记调度异常：${e.message}`)
    }
    timer = setTimeout(tick, 30 * 60_000)
  }
  timer = setTimeout(tick, 45_000)
  log('info', `日记排程：每天 ${settings().diaryAt || '23:30'} 之后写，若当天有聊天`)
}

export function stopDiary() {
  if (timer) clearTimeout(timer)
  timer = null
}
