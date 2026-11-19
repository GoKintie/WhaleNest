// Platform identifiers are data. Authorization always uses the originating event.
export const platformOf = (p = {}) => p.platform || p.channel || (p.kind === 'webui' || p.chatId === 'webui' ? 'webui' : 'qq')
export const conversationKey = (p = {}) => `${platformOf(p)}:${p.kind === 'group' ? 'group' : 'private'}:${String(p.chatId || p.chat || '')}`
export const safeScopeName = value => encodeURIComponent(String(value || '')).replace(/\*/g, '%2A')
export function scopeOf(p = {}) { return p.scope || p.conversationKey || (p.kind ? conversationKey(p) : '') }
export function visibleIn(record, ctx = {}) {
  if (ctx.allScopes === true) return true // Only authenticated administration APIs set this.
  if (record?.visibility === 'public' || record?.extra?.visibility === 'public') return true
  const ex = record?.extra || record || {}
  const scope = ctx.scope || ctx.conversationKey || (ctx.kind ? conversationKey(ctx) : '')
  const own = ex.scope || record?.scope || record?.conversationKey
  if (own) return Boolean(scope && own === scope)
  const chat = String(ex.chat || record?.chat || '')
  if (!chat) return false // Legacy unsourced material is admin-only until explicitly classified.
  const targetChat = String(ctx.chatId || ctx.chat || '')
  const kind = ctx.kind || (String(ctx.userId || '') === targetChat ? 'private' : '')
  return Boolean(targetChat && chat === targetChat && (!kind || ex.kind === kind) && (!ex.platform || ex.platform === platformOf(ctx)))
}
export function ownScope(ctx = {}) { return { ...ctx, scope: ctx.scope || conversationKey(ctx) } }

export function parseConversation(value,kind='private',platform='qq'){
  const m=String(value||'').match(/^(qq|wechat|webui):(private|group):(.*)$/s)
  return m?{platform:m[1],kind:m[2],chatId:m[3],scope:String(value)}:{platform,kind,chatId:String(value||'')}
}

export function isGroupScope(value) {
  const p = parseConversation(value)
  return p.scope === value && p.kind === 'group' &&
    (p.platform === 'qq' ? /^\d{1,20}$/.test(p.chatId) : p.platform === 'wechat' && /^[\w@.-]{1,128}$/.test(p.chatId))
}

export function groupCanLearn(p, s) {
  const scope = conversationKey(p)
  if (p.kind !== 'group' || !isGroupScope(scope)) return false
  const legacy = platformOf(p) === 'qq' ? s.targets?.[String(p.chatId)] : null
  const target = s.targets?.[scope] || legacy
  const learning = Array.isArray(s.learnGroups) ? s.learnGroups : []
  return s.learnAllGroups === true || target?.learnExpression === true ||
    learning.some(id => String(id) === scope || (platformOf(p) === 'qq' && String(id) === String(p.chatId)))
}
