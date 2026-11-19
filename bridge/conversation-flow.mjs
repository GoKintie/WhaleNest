// Pure conversation boundaries: no IO, clocks, settings or random side effects.
import {conversationKey} from './context-scope.mjs'
export {conversationKey}
export const participantKey = (p = {}) => p.kind === 'group'
  ? `${conversationKey(p)}:${p.userId}` : conversationKey(p)
export const sameParticipant = (a, b) => Boolean(a && b &&
  conversationKey(a) === conversationKey(b) && String(a.userId) === String(b.userId))

const CLOSE = /^(?:好的?|收到|行[的吧]?|ok+|明白|懂了|谢谢|谢啦|不用了|没事了|结束|先这样)[。！!~～\s]*$/i
const REDIRECT = /(?:换个话题|说点别的|另外一件事|不聊这个|先别说这个)/
const EXTEND = /^(?:那|所以|但是|不过|而且|还有|对了|刚才|这个|那个|它|你刚|你说|为什么|怎么|还是|我试|试了|结果)/
const SHORT_ANSWER = /^(?:是的?|不是|对的?|不对|有|没有|没了|可以|不行|不可以|会|不会|能|不能|\d+(?:\.\d+)?(?:秒|分钟|小时|次|个|G|GB|MB)?)[。！!？?\s]*$/i
const STOP = new Set(['这个','那个','就是','然后','所以','但是','不过','还有','一下','什么','怎么','可以','没有','不是','真的','你说','刚才','问题','肥鱼','小鲸','鲸鱼'])
function terms(text) {
  const out = new Set()
  for (const token of String(text || '').toLowerCase().match(/[a-z0-9_]{3,}|[\u4e00-\u9fff]+/g) || []) {
    if (/^[a-z0-9_]+$/.test(token)) out.add(token)
    else for (let i = 0; i + 1 < token.length; i++) {
      const part = token.slice(i, i + 2)
      if (!STOP.has(part)) out.add(part)
    }
  }
  return out
}
export function hasTopicOverlap(text, topic) {
  const a = terms(text), b = terms(topic)
  const shared = [...a].filter((x) => b.has(x))
  return shared.some((x) => /^[a-z0-9_]{3,}$/.test(x)) || shared.length >= 2
}
export function createFollowUpState(parsed, replyText, messageIds, nowMs, previous = null, options = {}) {
  if (parsed?.kind !== 'group' || !parsed.userId || !messageIds?.length || !String(replyText || '').trim()) return null
  const rootAt = previous?.rootAt ?? nowMs
  const turns = (previous?.turns || 0) + 1
  const maxTurns=Math.max(1,Math.min(20,Number(options.groupFollowUpMaxTurns)||4))
  const windowMs=Math.max(10000,Math.min(600000,Number(options.groupFollowUpMs)||150000)),totalMs=windowMs*2
  if (turns > maxTurns || nowMs - rootAt >= totalMs) return null
  return { groupId: String(parsed.chatId), participantId: String(parsed.userId),
    messageIds: messageIds.map(String), topic: String(parsed.text || '').slice(-800),
    replyText: String(replyText).slice(-500), open: /[？?]|(?:告诉我|发来看看|贴(?:下|一下)|试试再说|等你补充)/.test(replyText),
    rootAt, sentAt: nowMs, expiresAt: Math.min(nowMs + windowMs, rootAt + totalMs), turns }
}
export function matchFollowUp(parsed, state, nowMs) {
  if (!state || parsed?.kind !== 'group' || parsed.atOthers || String(parsed.chatId) !== state.groupId ||
      String(parsed.userId) !== state.participantId || nowMs < state.sentAt || nowMs > state.expiresAt) return false
  const text = String(parsed.text || '').trim()
  if (!text || CLOSE.test(text) || REDIRECT.test(text)) return false
  if (parsed.replyToMsgId != null) return state.messageIds.includes(String(parsed.replyToMsgId))
  const overlap=hasTopicOverlap(text,`${state.topic} ${state.replyText}`)
  if(/(?:你(?:说|觉得|看|刚|能|会|怎么|咋|呢)|刚才你|刚刚你|问你)/.test(text) && text.length<=100)return true
  return overlap && (EXTEND.test(text)||text.length>6) || state.open && SHORT_ANSWER.test(text)
}
export function isPendingContinuation(parsed, items = []) {
  return !parsed?.atOthers && !parsed?.replyToMsgId && items.some((it) => sameParticipant(it.parsed, parsed))
}

export function debounceDelay({ waitMs, first, lastAdded, nowMs, maxWaitMs = 32000 }) {
  const cap = Number.isFinite(Number(maxWaitMs)) && Number(maxWaitMs) > 0 ? Number(maxWaitMs) : 32000
  // Every new fragment gets a typing gap, but repeated fragments cannot extend the absolute cap.
  return Math.max(0, Math.min(Math.max(Number(waitMs) || 0, 900 - (nowMs - lastAdded)), cap - (nowMs - first)))
}

export function selectVoiceStyle({ explicitStyle = '', text = '', context = '', fallback = 'cute' } = {}) {
  const explicit = String(explicitStyle).trim().toLowerCase()
  if (explicit === 'cute' || explicit === 'gentle') return explicit
  const input = String(context || '')
  if(/(?:不要|别用|不用)温柔.*(?:可爱|活泼)|(?:用|要)可爱(?:语气|声线|声音)/.test(input))return 'cute'
  if(/(?:不要|别用|不用)可爱.*温柔|(?:用|要)温柔(?:语气|声线|声音)/.test(input))return 'gentle'
  if (/(?:温柔|轻声|小声|安慰|哄我|晚安|睡不着|难过|难受|焦虑|紧张|失恋|生病|发烧|医院|去世|抑郁|崩溃|想哭|累了|好累)/.test(input) ||
      /(?:晚安|好好休息|别怕|慢慢来|我在听|辛苦了|抱抱|别着急)/.test(text)) return 'gentle'
  if (/(?:可爱|撒娇|元气|活泼|卖萌|庆祝|开心|开黑|出金)/.test(input)) return 'cute'
  return fallback === 'gentle' ? 'gentle' : 'cute'
}
