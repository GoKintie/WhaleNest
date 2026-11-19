import {parseConversation} from './context-scope.mjs'
// 机器人自己的身份（昵称/QQ）与全局通讯录缓存（好友 + 群列表）
// 支持跨聊天窗口时按 QQ 号、群号、昵称或备注名自动寻址（打破窗口隔阂）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

let self = { id: '', name: '' }

export function setSelf(next = {}) {
  self = { ...self, ...next }
  return self
}

export function getSelf() {
  return self
}

const groups = new Map()
const friends = new Map()
let initialSynced = false

const CONTACTS_FILE = process.env.CONTACTS_FILE ||
  join(process.env.MEMORY_DIR || join(process.env.WORKDIR || '/workspace', 'memory'), 'contacts.json')

function persistContacts() {
  try {
    mkdirSync(dirname(CONTACTS_FILE), { recursive: true })
    const data = {
      updatedAt: Date.now(),
      friends: [...friends.values()],
      groups: [...groups.values()],
    }
    writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2), 'utf8')
  } catch {}
}

function loadCachedContacts() {
  try {
    if (!existsSync(CONTACTS_FILE)) return
    const raw = JSON.parse(readFileSync(CONTACTS_FILE, 'utf8') || '{}')
    for (const f of raw.friends || []) {
      if (f?.id) {
        friends.set(String(f.id), f)
        initialSynced = true
      }
    }
    for (const g of raw.groups || []) {
      if (g?.id) groups.set(String(g.id), g)
    }
  } catch {}
}
loadCachedContacts()

export function setGroupInfo(id, info = {}) {
  const gid = String(id)
  groups.set(gid, { id: gid, ...groups.get(gid), ...info })
  persistContacts()
  return groups.get(gid)
}

export function getGroupInfo(id) {
  return groups.get(String(id)) || null
}

export function setFriendInfo(id, info = {}) {
  const uid = String(id || '').trim()
  if (!uid) return null
  const prev = friends.get(uid)
  const next = {
    id: uid,
    avatar: qlogo(uid),
    addedAt: prev?.addedAt || info.addedAt || Date.now(),
    ...prev,
    ...info,
  }
  if (!next.name) next.name = next.remark || next.nickname || uid
  friends.set(uid, next)
  persistContacts()
  return next
}

export function getFriendInfo(id) {
  return friends.get(String(id)) || null
}

/**
 * 从通讯录缓存中移除指定好友或群（用于删除测试会话或清理无效卡片）
 */
export function removeContact(id) {
  const key = String(id || '').trim()
  if (!key) return false
  const hadFriend = friends.delete(key)
  const hadGroup = groups.delete(key)
  if (hadFriend || hadGroup) persistContacts()
  return hadFriend || hadGroup
}

export function syncContactsDirectory({ friendList = [], groupList = [] } = {}) {
  const prevFriendIds = new Set(friends.keys())
  const prevGroupIds = new Set(groups.keys())
  const newFriends = []
  const newGroups = []

  for (const f of friendList) {
    const id = String(f.id || f.user_id || '').trim()
    if (!id) continue
    const prev = friends.get(id)
    const isNew = initialSynced && !prevFriendIds.has(id)
    const entry = {
      id,
      name: f.name || f.remark || f.nickname || prev?.name || id,
      nickname: f.nickname || f.name || prev?.nickname || id,
      remark: f.remark ?? prev?.remark ?? '',
      avatar: qlogo(id),
      addedAt: prev?.addedAt || (isNew ? Date.now() : 0),
    }
    friends.set(id, entry)
    if (isNew) newFriends.push(entry)
  }

  for (const g of groupList) {
    const id = String(g.id || g.group_id || '').trim()
    if (!id) continue
    const prev = groups.get(id)
    const isNew = initialSynced && !prevGroupIds.has(id)
    const entry = {
      id,
      name: g.name || g.group_name || prev?.name || `群 ${id}`,
      memberCount: g.count || g.member_count || prev?.memberCount || 0,
      avatar: groupAvatar(id),
    }
    groups.set(id, entry)
    if (isNew) newGroups.push(entry)
  }

  if (friendList.length || groupList.length) {
    initialSynced = true
  }
  persistContacts()
  return {
    friends: [...friends.values()],
    groups: [...groups.values()],
    newFriends,
    newGroups,
  }
}

export function listKnownContacts() {
  return {
    friends: [...friends.values()],
    groups: [...groups.values()],
  }
}

/**
 * 跨窗口目标解析器：
 * 支持：
 * - "private:20002" / "user:20002" / "qq:20002"
 * - "group:30003" / "群:30003" / "群30003"
 * - 纯数字（先查已知群号与 allowGroups，再归为私聊 QQ 号）
 * - 好友昵称 / 备注名 / 群名称模糊匹配（如 "老王"、"管理员甲"、"技术群"）
 */
export function resolveContactTarget(rawTarget, opts = {}) {
  const raw = String(rawTarget || '').trim()
  if (!raw) return null
  if(/^(qq|wechat):(private|group):[^\r\n]+$/.test(raw)){const p=parseConversation(raw);return {...p,name:opts.targets?.[raw]?.note||p.chatId}}

  const targetsMap = opts.targets || {}
  const allowGroups = new Set((opts.allowGroups || []).map(String))
  const allowUsers = new Set((opts.allowUsers || []).map(String))
  const recentChats = Array.isArray(opts.recentChats) ? opts.recentChats : []

  // 1. 显式前缀 group:xxx / private:xxx
  const prefixMatch = raw.match(/^(group|群|群聊|private|user|qq|好友|私聊)[:：\s]*(\d{4,13})$/i)
  if (prefixMatch) {
    const p = prefixMatch[1].toLowerCase()
    const id = prefixMatch[2]
    const isG = p === 'group' || p === '群' || p === '群聊'
    return {
      kind: isG ? 'group' : 'private',
      chatId: id,
      name: isG ? (groups.get(id)?.name || `群 ${id}`) : (friends.get(id)?.name || id),
    }
  }

  // 2. 纯数字 ID
  if (/^\d{4,13}$/.test(raw)) {
    if (groups.has(raw) || allowGroups.has(raw)) {
      return { kind: 'group', chatId: raw, name: groups.get(raw)?.name || `群 ${raw}` }
    }
    if (friends.has(raw) || allowUsers.has(raw)) {
      return { kind: 'private', chatId: raw, name: friends.get(raw)?.name || raw }
    }
    const recentHit = recentChats.find((m) => String(m.chat) === raw || String(m.id) === raw)
    if (recentHit) {
      const isG = recentHit.kind === 'group' && String(recentHit.chat) === raw
      return { kind: isG ? 'group' : 'private', chatId: raw, name: recentHit.name || raw }
    }
    return { kind: 'private', chatId: raw, name: raw }
  }

  const q = raw.toLowerCase().replace(/^(给|向|对|找|群|好友)/, '').trim() || raw.toLowerCase()

  // 3. 查 settings.targets 里的自定义备注 note
  for (const [id, cfg] of Object.entries(targetsMap)) {
    const note = String(cfg?.note || '').trim().toLowerCase()
    if (note && (note === q || note.includes(q) || q.includes(note))) {
      if(/^(qq|wechat):(private|group):/.test(id))return {...parseConversation(id),name:cfg.note||id}
      const isG = groups.has(id) || allowGroups.has(id)
      return { kind: isG ? 'group' : 'private', chatId: String(id), name: cfg.note }
    }
  }

  // 4. 查好友通讯录（精确优先，包含次之）
  for (const f of friends.values()) {
    const n1 = String(f.name || '').toLowerCase()
    const n2 = String(f.nickname || '').toLowerCase()
    const n3 = String(f.remark || '').toLowerCase()
    if (n1 === q || n2 === q || n3 === q) {
      return { kind: 'private', chatId: f.id, name: f.name || f.id }
    }
  }
  for (const f of friends.values()) {
    const n1 = String(f.name || '').toLowerCase()
    const n2 = String(f.nickname || '').toLowerCase()
    const n3 = String(f.remark || '').toLowerCase()
    if ((n1 && (n1.includes(q) || q.includes(n1))) ||
        (n2 && (n2.includes(q) || q.includes(n2))) ||
        (n3 && (n3.includes(q) || q.includes(n3)))) {
      return { kind: 'private', chatId: f.id, name: f.name || f.id }
    }
  }

  // 5. 查群通讯录
  for (const g of groups.values()) {
    const gn = String(g.name || '').toLowerCase()
    if (gn && (gn === q || gn.includes(q) || q.includes(gn))) {
      return { kind: 'group', chatId: g.id, name: g.name }
    }
  }

  // 6. 查近期聊天记录里的发言人昵称
  for (let i = recentChats.length - 1; i >= 0; i--) {
    const m = recentChats[i]
    if (!m || m.role === 'assistant') continue
    const mn = String(m.name || '').toLowerCase()
    const uid = String(m.id || (m.kind === 'private' ? m.chat : '') || '')
    if (uid && mn && (mn === q || mn.includes(q) || q.includes(mn))) {
      return { kind: 'private', chatId: uid, name: m.name || uid }
    }
  }

  return null
}

/** 群头像直链 */
export function groupAvatar(id, size = 100) {
  const gid = String(id || '').trim()
  if (!/^\d{5,12}$/.test(gid)) return ''
  return `https://p.qlogo.cn/gh/${gid}/${gid}/${size}`
}

/** QQ 头像直链，不需要调接口；浏览器直接加载 */
export function qlogo(qq, size = 100) {
  const id = String(qq || '').trim()
  if (!/^\d{5,12}$/.test(id)) return ''
  return `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=${size}`
}
