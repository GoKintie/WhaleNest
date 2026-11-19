import { groupCanLearn } from './context-scope.mjs'
// OneBot 事件解析、准入判断、群聊高频插话态势评估、图片/表情包物理尺寸检验与 dafeiyu 出站整形器（bridge/onebot-lib.mjs · v2.8）
// 兼容 NapCat / SnowLuma / Lagrange 等任何 OneBot v11 实现

const SEG_LABEL = {
  image: '[图片]',
  face: '[表情]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  mface: '[表情]',
  reply: '',
  forward: '[聊天记录]',
}

/**
 * 纯 Node Buffer 解析 PNG / GIF / JPEG / WebP 的像素宽高与格式（零外部依赖）
 */
export function inspectImageBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 16) return null
  const bytes = buf.length

  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && bytes >= 24) {
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt16BE ? buf.readUInt32BE(20) : 0
    return { format: 'png', width, height, bytes }
  }

  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && bytes >= 10) {
    const width = buf.readUInt16LE(6)
    const height = buf.readUInt16LE(8)
    return { format: 'gif', width, height, bytes }
  }

  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && bytes >= 30) {
    const chunk = buf.toString('ascii', 12, 16)
    if (chunk === 'VP8 ' && bytes >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff
      const height = buf.readUInt16LE(28) & 0x3fff
      return { format: 'webp', width, height, bytes }
    }
    if (chunk === 'VP8L' && bytes >= 25) {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24]
      const width = 1 + (((b1 & 0x3f) << 8) | b0)
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      return { format: 'webp', width, height, bytes }
    }
    if (chunk === 'VP8X' && bytes >= 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      return { format: 'webp', width, height, bytes }
    }
  }

  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes) {
      if (buf[offset] !== 0xff) { offset++; continue }
      const marker = buf[offset + 1]
      if (marker === 0xff) { offset++; continue }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const len = buf.readUInt16BE(offset + 2)
      if (len < 2) break
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)) {
        const height = buf.readUInt16BE(offset + 5)
        const width = buf.readUInt16BE(offset + 7)
        return { format: 'jpeg', width, height, bytes }
      }
      offset += 2 + len
    }
    return { format: 'jpeg', width: 0, height: 0, bytes }
  }

  return { format: 'unknown', width: 0, height: 0, bytes }
}

/**
 * 判断一张图片在物理规格上是否符合「表情包」特征
 */
export function isLikelyStickerBuffer(buf, meta = {}) {
  const info = inspectImageBuffer(buf)
  if (!info) return { ok: false, reason: 'invalid-buffer' }

  const explicitEmoji = Number(meta.subType) === 1 || /(动画表情|表情|商城表情|\[表情\])/i.test(String(meta.summary || ''))

  if (info.bytes > 1800 * 1024) {
    return { ok: false, reason: 'too-large-bytes', info }
  }
  if (!explicitEmoji && info.format !== 'gif' && info.bytes > 480 * 1024) {
    return { ok: false, reason: 'photo-size-bytes', info }
  }

  if (info.width > 0 && info.height > 0) {
    const maxDim = Math.max(info.width, info.height)
    const minDim = Math.min(info.width, info.height)
    const ratio = info.width / info.height

    if (ratio < 0.52 || ratio > 1.95) {
      return { ok: false, reason: 'extreme-aspect-ratio', info }
    }
    if (!explicitEmoji && maxDim > 560) {
      return { ok: false, reason: 'high-res-image', info }
    }
    if (maxDim > 960 || minDim < 32) {
      return { ok: false, reason: 'dimension-out-of-range', info }
    }
  }

  if (meta.strict && !explicitEmoji && info.format !== 'gif') {
    return { ok: false, reason: 'not-explicit-emoji-segment', info }
  }

  return { ok: true, reason: explicitEmoji ? 'explicit-emoji' : 'valid-sticker-shape', info }
}

/**
 * 识别群消息中是否直接点名呼叫了肥鱼（支持“肥鱼/大肥鱼/小鲸鱼/D指导/deepsleep/魔丸/deepseek”）
 */
export const BOT_NAME_CALL_RE = /(肥鱼|大肥鱼|小鲸鱼|鲸鱼|D指导|deepsleep|魔丸|deepseek)/i

export function hasBotNameMention(text, customBotName = '') {
  const raw = String(text || '').trim()
  if (!raw) return false
  if (BOT_NAME_CALL_RE.test(raw)) return true
  const bn = String(customBotName || '').trim()
  if (bn && bn.length >= 2) {
    const esc = bn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(esc, 'i').test(raw)) return true
  }
  return false
}

export function parseEvent(ev) {
  if (!ev || ev.post_type !== 'message') return null

  const segments = Array.isArray(ev.message)
    ? ev.message
    : typeof ev.message === 'string'
      ? [{ type: 'text', data: { text: ev.raw_message || ev.message } }]
      : []

  const self = String(ev.self_id ?? '')
  let text = ''
  let atMe = false
  let atOthers = false
  let replyToMsgId = null
  const media = []

  for (const seg of segments) {
    const type = seg?.type
    const data = seg?.data || {}
    if (type === 'text') text += data.text ?? ''
    else if (type === 'reply') {
      replyToMsgId = data.id || null
    } else if (type === 'at') {
      if (String(data.qq) === self) atMe = true
      else if (data.qq && String(data.qq) !== 'all') atOthers = true
    } else if (type === 'atall') atMe = true
    else if (type === 'image') {
      const subType = Number(data.sub_type ?? 0)
      const summary = String(data.summary || '')
      const isSticker = subType === 1 || /(动画表情|表情|商城表情)/.test(summary)
      media.push({
        type: isSticker ? 'emoji' : 'image',
        subType,
        summary,
        url: data.url || '',
        hint: data.file || '',
      })
      text += isSticker ? `[表情包${media.length}]` : `[图片${media.length}]`
    } else if (type === 'file') {
      media.push({ type: 'file', url: data.url || '', hint: data.name || data.file || '', fileId: data.file_id || '', size: Number(data.file_size || 0) })
      text += `[文件${media.length}]`
    } else if (type === 'record') {
      media.push({ type: 'record', url: data.url || '', hint: data.file || '' })
      text += '[语音]'
    } else if (type === 'forward') {
      // 合并转发：v2 只是丢一句 [聊天记录] 就完事，等于瞎了。这里保留 id 供上层调 get_forward_msg 展开。
      const fid = String(data.id || data.message_id || '').trim()
      const title = String(data.title || data.summary || '').trim()
      if (fid) media.push({ type: 'forward', id: fid, title, url: data.url || '' })
      text += fid ? `[合并转发${media.length}${title ? '：' + title.slice(0, 18) : ''}]` : '[合并转发]'
    } else if (type === 'json' || type === 'xml') {
      let brief = ''
      try {
        const card = JSON.parse(data.data || '{}')
        brief = card?.meta?.detail?.title || card?.meta?.news?.title || card?.prompt || ''
      } catch {}
      text += brief ? `[卡片：${String(brief).slice(0, 24)}]` : '[卡片消息]'
    } else if (type === 'mface') {
      const url = data.url || data.emoji_url || ''
      const hint = data.file || data.emoji_id || ''
      if (url) {
        media.push({ type: 'emoji', subType: 1, summary: String(data.summary || '商城表情'), url, hint })
        text += `[表情包${media.length}]`
      } else {
        text += `[表情包${data.summary ? '：' + String(data.summary).slice(0, 12) : ''}]`
      }
    } else if (type in SEG_LABEL) text += SEG_LABEL[type]
  }

  const isGroup = ev.message_type === 'group'
  return {
    kind:isGroup?'group':'private', platform:ev.platform||'qq',
    chatId: String(isGroup ? ev.group_id : ev.user_id),
    userId: String(ev.user_id ?? ''),
    name: ev.sender?.card || ev.sender?.nickname || String(ev.user_id ?? ''),
    text: text.replace(/\s+/g, ' ').trim(),
    atMe,
    atOthers,
    replyToMsgId,
    self,
    media,
    messageId: ev.message_id,
  }
}

export function decide(p, conf) {  if (!p) return { reply: false, reason: 'not-a-message' }
  if (!p.text) return { reply: false, reason: 'empty' }
  if (p.self && p.userId === p.self) return { reply: false, reason: 'self' }

  if (p.kind === 'private') {
    if (!conf.allowAnyone && !conf.allowUsers.includes(p.userId)) {
      return { reply: false, reason: 'user-not-allowed' }
    }
    return { reply: true, reason: 'private-ok' }
  }

  const allowGroups = Array.isArray(conf.allowGroups) ? conf.allowGroups : []
  if (!allowGroups.includes(p.chatId)) {
    const shouldLearn = groupCanLearn(p,conf)
    if (shouldLearn) {
      return { reply: false, learnOnly: true, reason: 'group-learn-only' }
    }
    return { reply: false, reason: 'group-not-allowed' }
  }

  if (conf.atOnly && !p.atMe) {
    if (!p.atOthers && conf.allowNameCall !== false && hasBotNameMention(p.text, conf.botName)) {
      return { reply: true, nameCalled: true, reason: 'group-name-called' }
    }
    return { reply: false, reason: 'no-at' }
  }
  return { reply: true, reason: 'group-ok' }
}

const AI_CLICHE_PREFIX = /^(?:(?:好的|没问题|收到|当然可以|明白|我明白了|了解|关于这个问题|针对你的问题)[，,。！!~～：:\s]*)+/i
const AI_CLICHE_SUFFIX = /([，,。！!~～\s]*(希望这能帮到你|希望对你有帮助|有什么问题随时问我|如有需要请随时告诉我|祝你生活愉快|还有什么我可以帮你的吗)[。！!~～\s]*)$/i
const SELF_ROLE_PREFIX = /^(?:【你(?:(?:刚才)?(?:回|说)|[（(](?:肥鱼|小鲸鱼|大肥鱼|我自己|自己)[)）](?:刚才)?(?:回|说)?)】\s*[:：]?|(?:肥鱼|小鲸鱼|大肥鱼|DeepSeek)\s*[:：])\s*/i

/**
 * 拟人化去 AI 味与 dafeiyu 出站整形后处理器（融合 whyever77/dafeiyu-astrbot 草稿箱撕除与标点归一）
 */
export function humanizeReply(text, opts = {}) {
  let clean = String(text || '')
    // 1. 撕掉双层括号草稿箱 （（...）） 或 ((...)) —— 给大肥鱼自己咽回心里话的出口
    .replace(/（（[\s\S]*?））|\(\([\s\S]*?\)\)/g, '')
    // 2. 中文直角引号「」统一成自然双引号，顿号后接分句连词改成逗号
    .replace(/「([^」]*)」/g, '“$1”')
    .replace(/、(?=(?:也|就|但|不过|所以|或者|而且|还是))/g, '，')
    // 只去掉成对的强调标记，保留 x ** 2、**/*.js 这类代码内容
    .replace(/\*\*(?!\s)([^*\n]*?\S)\*\*/g, '$1')
    .replace(SELF_ROLE_PREFIX, '')
    .trim()
  if (!clean) return ''

  const isTask = !!opts.isTask
  if (!isTask) {
    clean = clean.replace(/^#+\s*/gm, '').replace(/^[ \t]*[-*•]\s+/gm, '')
    if (clean.length > 6) {
      clean = clean.replace(AI_CLICHE_PREFIX, '').trim()
    }
    clean = clean.replace(AI_CLICHE_SUFFIX, '').trim()
    clean = clean.replace(/^\d+[.、）)]\s*/gm, '').trim()

    // Preserve complete clauses; reply length is a generation style, not a destructive filter.
    clean = clean.replace(/([a-zA-Z0-9\u4e00-\u9fa5])[。．]$/gm, '$1')
  }

  return clean.trim()
}

const splitGraphemes = (text) => {
  try {
    return [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(String(text))].map((x) => x.segment)
  } catch {
    return Array.from(String(text))
  }
}

/** 把一段回复切成几条，模拟人手打字 */
export function splitReply(text, max = 120) {
  max = Math.min(4000, Math.max(1, Math.floor(Number(max) || 120)))
  const clean = String(text || '').replace(/\*\*(?!\s)([^*\n]*?\S)\*\*/g, '$1').trim()
  if (!clean) return []

  const chunks = []
  for (const para of clean.split(/\n{1,}/)) {
    const line = para.trim()
    if (!line) continue
    const units = splitGraphemes(line)
    if (units.length <= max) { chunks.push(line); continue }
    for (let i = 0; i < units.length; i += max) chunks.push(units.slice(i, i + max).join(''))
  }
  return chunks
}

export function estimateTypingDelay(chunk, baseGapMs = 750, now = new Date()) {
  const len = String(chunk || '').length
  const base = Math.max(200, Number(baseGapMs || 750))
  const byLen = Math.min(2400, Math.max(base, Math.round(len * 42)))
  const h = now.getHours()
  const nightFactor = (h >= 23 || h < 7) ? 1.35 : 1.0
  return Math.round(byLen * nightFactor)
}

const LEADING_PATTERNS = [
  /^(?:(?:肥鱼|小鲸鱼|大肥鱼|那个|哎|诶|喂)[，,、\s]*)?(在[吗么不]|在不在|人呢|肥鱼|小鲸鱼|大肥鱼|哈喽|你好|您好|hi|hello|hey|那个|问个事|问下|请问|求助|救命|有个问题|有个事|跟你说个事|我跟你说|想问下|等等|等下|先别急|且慢|还有|对了|另外|话说|家人们|兄弟|哥们|卧槽|不是哥们|太离谱了|好奇怪)[呀吧呢啊吗么！!？?。，~～\s]*$/i,
  /^(?:(?:肥鱼|小鲸鱼|大肥鱼|那个|哎|诶)[，,、\s]*)?(我跟你说|跟你说|我刚发现|我发现|刚刚|刚才|你看这个|你看下|帮我看下|帮我看看|我这边|有个很?奇?怪的?事|不知道为啥)[^。！!？?]{0,12}[。！!？?~～\s]*$/i,
]
const SETUP_SENTENCE_PATTERNS = [
  /^(?:(?:肥鱼|小鲸鱼|大肥鱼|那个|哎|诶)[，,、\s]*)?(我跟你说个事|跟你说个事|有个问题想问|我发现一个问题|刚刚试了一下|刚才试了下|我这边报错了|这玩意儿又崩了|给你看个东西|先别动|等我一下)[。！!~～\s]*$/i,
]
const CLOSED_SHORT = /^(好的?|收到|行[的吧]?|ok|okk|okay|恩|嗯[嗯]?|对[的]?|算啦?|好吧?|没事了?|谢谢|谢啦|不用了?|明白|懂了|了解)[。！!~～\s]*$/i
const PURE_MEDIA_ONLY = /^(\[(图片|文件|表情包|视频|语音|聊天记录)\d*\][\s,，。]*)+$/
const DANGLING_END = /(而且|然后|但是|不过|还有就是|或者是|因为|所以|比如|另外|并且|接着|结果|就是|主要是|问题是|现在是|你看|像这种|我本来想|不知道为啥|话说|其实|本来|万一|哪怕|要是|如果|特别是|尤其是)[呀吧呢啊嘛喔哦，,：:\s]*$/

export function looksUnfinished(text) {
  const t = String(text || '').trim()
  if (!t) return false
  if (CLOSED_SHORT.test(t)) return false
  if (PURE_MEDIA_ONLY.test(t)) return true
  for (const pat of LEADING_PATTERNS) {
    if (pat.test(t)) return true
  }
  for (const pat of SETUP_SENTENCE_PATTERNS) {
    if (pat.test(t)) return true
  }
  if (/[，、,;；:：\-—~～…]$/.test(t)) return true
  if (DANGLING_END.test(t)) return true
  if (/[。．.!！?？~～…）)】」』"]$/.test(t)) {
    // 带明确收尾标点且不是极短追问（「怎么看？」这种 3 个字才算没说完），就当他说完了
    return t.length < 8
  }
  return t.length <= 52
}

export function analyzeCompleteness(rawTexts, baseMs = 4500) {
  const base = Math.max(1500, Number(baseMs || 4500))
  const list = (Array.isArray(rawTexts) ? rawTexts : [rawTexts]).map((s) => String(s || '').trim()).filter(Boolean)
  if (!list.length) return { unfinished: false, stage: 'closed', waitMs: base }

  const last = list[list.length - 1]
  const combined = list.join(' ')

  if (CLOSED_SHORT.test(last) && list.length === 1) {
    return { unfinished: false, stage: 'closed', waitMs: 700 }
  }

  if (PURE_MEDIA_ONLY.test(last)) {
    // 只发了图没配字：留时间给他补说明，但别像 v2 那样干等 11 秒
    return { unfinished: true, stage: 'media_only', waitMs: 4800 }
  }

  if (LEADING_PATTERNS.some((p) => p.test(last)) || SETUP_SENTENCE_PATTERNS.some((p) => p.test(last))) {
    return { unfinished: true, stage: 'opener', waitMs: 3900 }
  }

  if (looksUnfinished(last) || (list.length === 1 && looksUnfinished(combined))) {
    return { unfinished: true, stage: 'unfinished_clause', waitMs: 3100 }
  }

  if (list.length >= 2 && !CLOSED_SHORT.test(last)) {
    return { unfinished: true, stage: 'multi_burst', waitMs: 2200 }
  }

  // 意思已经完整：不再拖满 base（v2 默认 4500ms，聊天像卡了），压到 1.4 秒内直接开火
  return { unfinished: false, stage: 'complete', waitMs: Math.min(base, 1400) }
}

const NOISE_MSG = /^(\[(表情|图片|表情包|语音).*?\]|[哈6？?！!。.…嗯哦草艹牛逼nbok123\s])+$/i
const SERIOUS_BLOCK = /(全体成员|严肃点|别插嘴|说正事|正式通知|请勿刷屏)/i
const SOFT_MENTION_RE = /(肥鱼|大肥鱼|小鲸鱼|鲸鱼|D指导|deepsleep|魔丸|deepseek|机器人|人机|赛博|ai)/i
const DIRECT_FOLLOWUP_RE = /(?:^|[，,\s])(?:那?你(?:呢|觉得|怎么|刚才|说|看|能不能|会|有|咋)|你(?:那个|这|怎么|不是说|刚说|咋|还)|为什么你|真的假的|那咋办|然后呢|咋地|还生气)/i
const OPEN_QUESTION_RE = /(有人知道|有人试过|谁懂|有大佬|怎么弄|怎么搞|求助|为啥会|为什么会|怎么办|救命|求教|咋办|有没有人|能救吗|有懂的吗|能不能|可以吗|吗[？?]?$|呢[？?]?$)/i
const TECH_TOPIC_RE = /(报错|bug|挂了|崩了|起不来|连不上|卡死|docker|nas|fnos|飞牛|群晖|端口|镜像|容器|rvc|cuda|显卡|爆显存|pytorch|gpu|跑不动|带不动|配置|证书|反代|穿透|公网|脚本|代码|服务器|虚拟机|硬盘|内存|路由|固态|linux|ssh|内网|文档|插件|提示词|模型|agi|gemini|token)/i
const GAMING_ACGN_RE = /(明日方舟|方舟|大祥老师|祥子|丰川祥子|卫戍|克莱门莎|纳斯提|森空岛|终末地|原石|合成玉|抽卡|小黑盒|steam|喜加一|epic|原神|星铁|绝区零|鸣潮|b站|贴吧|神人|dps|总伤|超大杯|中杯|小杯|肉鸽|塔罗|求签|运势|上号|开黑|大乱斗|云顶)/i
const RANT_HUMOR_RE = /(服了|离谱|纳闷|折腾|冤种|逆天|炸了|绝了|吐了|坑死|笑死|绷不住|坐牢|红温|破防|摸鱼|神金|丸辣|何意味|招笑|闹麻了|唐完了|似了|气笑了|不是哥们|八嘎|好饿|吃饭)/i

export const ATMOSPHERE_TYPES = {
  SAD_COMFORT: "sad_comfort",
  CONFLICT_FLAME: "conflict_flame",
  GAMING_HYPE: "gaming_hype",
  LATE_NIGHT_QUIET: "late_night_quiet",
  CASUAL_BANTER: "casual_banter",
}

const SAD_COMFORT_RE = /(挂科|挂了|被裁|辞退|被炒|分手|失恋|沉船|保底|大保底|难受|难过|哭了|生病|阳了|发烧|头疼|破防|倒霉|绝望|没救了|好痛|痛苦|呜呜|心梗|抑郁|emo|好累|想死|扛不住|医院|复发|丢了|被偷|被骗|被骂|委屈|掉小珍珠)/i
const CONFLICT_FLAME_RE = /(对线|吵架|撕逼|傻逼|脑瘫|死全家|孤儿|nt|弱智|cnm|nmsl|滚出|你妈|找抽|找死|欠揍|装什么|司马|贱人|吵起来|红温|互喷|拉偏架|你急了|急急急)/i
const GAMING_HYPE_RE = /(开黑|上分|四等一|三等一|二等一|来个人|打游戏|出金|双黄|十连|单抽出奇迹|终末地|方舟|鸣潮|原神|lol|云顶|大乱斗|瓦罗兰特|apex|steam|喜加一|开荒|打本|上号|通关)/i

/**
 * AI 读空气氛围感知引擎 (chat_plus · 5 档氛围自适应)
 * 根据群聊最近上下文与当前发言，实时感知群内情感基调，自适应调控插话概率与语态指导
 */
export function analyzeChatAtmosphere(recentMsgs = [], currentMsg = null, opts = {}) {
  const allTexts = []
  if (Array.isArray(recentMsgs)) {
    for (const m of recentMsgs.slice(-5)) {
      if (m && m.text) allTexts.push(String(m.text))
    }
  }
  const cur = currentMsg ? (typeof currentMsg === "string" ? currentMsg : (currentMsg.text || "")) : ""
  if (cur) allTexts.push(cur)

  const combined = allTexts.join(" ")
  const now = opts.now instanceof Date ? opts.now : new Date(Number(opts.nowMs || Date.now()))
  const hour = now.getHours()

  // 1. 冲突对线 (conflict_flame) - 最高安全优先级，避免火上浇油
  if (CONFLICT_FLAME_RE.test(cur) || CONFLICT_FLAME_RE.test(combined)) {
    return {
      atmosphere: "conflict_flame",
      label: "冲突降温 / 打圆场",
      promptGuidance: "【当前群聊氛围读空气提示 (chat_plus)】\n当前群聊火药味浓厚、有人在争执对线。切勿火上浇油或偏袒对喷！若插话需以打圆场、递台阶或调侃转移话题为主，避免激化矛盾。",
      chimeProbFactor: 0.35,
      delayFactor: 1.8,
    }
  }

  // 2. 难过失意共情 (sad_comfort) - 温暖陪伴，放下傲娇嘴硬
  if (SAD_COMFORT_RE.test(cur) || SAD_COMFORT_RE.test(combined)) {
    return {
      atmosphere: "sad_comfort",
      label: "失意共情 / 温暖抚慰",
      promptGuidance: "【当前群聊氛围读空气提示 (chat_plus)】\n转为真诚陪伴：短句，先接住感受，不说教，不毒舌。",
      chimeProbFactor: 1.3,
      delayFactor: 0.7,
    }
  }

  // 3. 游戏开黑狂欢 (gaming_hype) - 兴奋接梗
  if (GAMING_HYPE_RE.test(cur) || GAMING_HYPE_RE.test(combined)) {
    return {
      atmosphere: "gaming_hype",
      label: "游戏开黑 / 狂欢热聊",
      promptGuidance: "【当前群聊氛围读空气提示 (chat_plus)】\n当前群聊气氛活跃，正在热火朝天地聊游戏、抽卡或约开黑。随和融入，积极接梗（吸欧气/调侃嫉妒/起哄开黑）。",
      chimeProbFactor: 1.35,
      delayFactor: 0.8,
    }
  }

  // 4. 深夜静谧 (late_night_quiet) - 0点~6点
  if (hour >= 0 && hour < 6) {
    return {
      atmosphere: "late_night_quiet",
      label: "深夜静谧 / 轻声伴聊",
      promptGuidance: "【当前群聊氛围读空气提示 (chat_plus)】\n现在处于深夜/凌晨时段，群友大多已睡或在修仙。语气轻柔放松，切忌大喊大叫，以轻声搭话或催早点睡为主。",
      chimeProbFactor: 0.9,
      delayFactor: 1.0,
    }
  }

  // 5. 日常摸鱼闲聊 (casual_banter)
  return {
    atmosphere: "casual_banter",
    label: "日常吹水 / 随性接梗",
    promptGuidance: "【当前群聊氛围读空气提示 (chat_plus)】\n日常闲聊氛围。按你的人格和说话风格自然回应，不用刻意表演。",
    chimeProbFactor: 1.0,
    delayFactor: 1.0,
  }
}

/**
 * 群聊拟人化插话态势评估器
 */
export function evaluateGroupChimeIn(parsed, recentGroupMsgs = [], opts = {}) {
  const text = String(parsed?.text || '').trim()
  if (!text || text.length < 2) return { shouldCheck: false, score: 0, prob: 0, reason: 'too-short', observeDelayMs: 0 }

  const botName = String(opts.botName || '肥鱼').trim()
  const escapedBot = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const hasSoftMention = SOFT_MENTION_RE.test(text) || (escapedBot && new RegExp(escapedBot, 'i').test(text))

  const nowMs = Number(opts.nowMs || Date.now())
  const recentTail = Array.isArray(recentGroupMsgs) ? recentGroupMsgs.slice(-2) : []
  const botSpokeInLast2 = recentTail.some((m) => m && m.role === 'assistant')
  const lastBotMsg = [...(Array.isArray(recentGroupMsgs) ? recentGroupMsgs.slice(-4) : [])].reverse().find((m) => m && m.role === 'assistant')
  const msSinceBotSpoke = lastBotMsg && lastBotMsg.ts ? (nowMs - Number(lastBotMsg.ts)) : 0
  const isDirectFollowUpToBot = (botSpokeInLast2 || Boolean(lastBotMsg)) && !parsed?.atOthers && DIRECT_FOLLOWUP_RE.test(text)
  const inActiveConvo = Boolean(opts.inActiveConvo || (lastBotMsg && lastBotMsg.ts && msSinceBotSpoke >= 4_000 && msSinceBotSpoke <= 90_000)) && !parsed?.atOthers

  if (!hasSoftMention && !isDirectFollowUpToBot && NOISE_MSG.test(text)) {
    return { shouldCheck: false, score: 0, prob: 0, reason: 'noise', observeDelayMs: 0 }
  }

  if (!hasSoftMention && SERIOUS_BLOCK.test(text)) {
    return { shouldCheck: false, score: 0, prob: 0, reason: 'serious-block', observeDelayMs: 0 }
  }

  if (parsed?.atOthers && !hasSoftMention) {
    return { shouldCheck: false, score: 0, prob: 0, reason: 'at-others', observeDelayMs: 0 }
  }

  if (!hasSoftMention && !isDirectFollowUpToBot && !inActiveConvo && botSpokeInLast2) {
    return { shouldCheck: false, score: 0, prob: 0, reason: 'just-spoke', observeDelayMs: 0 }
  }

  let score = 0
  const reasons = []

  const pureText = text.replace(/\[.*?\]/g, '').trim()
  if (pureText.length >= 3) {
    score += 18
    reasons.push('chat-line')
  }

  if (hasSoftMention) {
    score += 78
    reasons.push('soft-mention')
  }
  if (isDirectFollowUpToBot) {
    score += 75
    reasons.push('reply-to-bot')
  } else if (inActiveConvo && pureText.length >= 2) {
    score += 42
    reasons.push('active-convo')
  }
  if (OPEN_QUESTION_RE.test(text)) {
    score += 34
    reasons.push('open-question')
  }
  if (TECH_TOPIC_RE.test(text)) {
    score += 34
    reasons.push('tech-topic')
  }
  if (GAMING_ACGN_RE.test(text)) {
    score += 36
    reasons.push('gaming-topic')
  }
  if (RANT_HUMOR_RE.test(text)) {
    score += 30
    reasons.push('rant-or-humor')
  }

  if (opts.memeMatch && !parsed?.atOthers) {
    score += 28
    reasons.push('recognized-meme')
  }

  const activeWindow = (Array.isArray(recentGroupMsgs) ? recentGroupMsgs : []).filter(
    (m) => m.role !== 'assistant' && m.ts && (nowMs - Number(m.ts)) <= 180_000
  )
  const uniqueSpeakers = new Set(activeWindow.map((m) => String(m.id || m.name || '')))
  if (activeWindow.length >= 2 && uniqueSpeakers.size >= 2) {
    score += 16
    reasons.push('hot-chat')
  }

  if (opts.hasUserImpression) {
    score += 10
    reasons.push('known-peer')
  }

  if (score < 16) {
    return { shouldCheck: false, score, prob: 0, reason: 'low-relevance', observeDelayMs: 0 }
  }

  const atmo = analyzeChatAtmosphere(recentGroupMsgs, parsed, opts)
  const baseProb = Number(opts.baseProb ?? 0.58)

  // v3 修复（核心 bug）：v2 这里用 Math.max(0.42, ...) / Math.max(0.05, ...) 铺了一层概率地板，
  // 于是「插话概率调成 0」也照样能插话。现在 baseProb<=0 直接判定为关闭，绝不发声。
  if (!(baseProb > 0)) {
    return {
      shouldCheck: false,
      inActiveConvo,
      score: Math.min(100, score),
      prob: 0,
      reason: `disabled@${atmo.atmosphere}`,
      observeDelayMs: 0,
      atmosphere: atmo.atmosphere,
      atmosphereLabel: atmo.label,
      atmosphereGuidance: atmo.promptGuidance,
    }
  }

  // 概率随「相关度打分」单调上升，且严格以 baseProb 为基准（0 就永远是 0）
  let prob = baseProb * (0.35 + score / 50)
  prob = Math.max(0, Math.min(0.96, prob * (atmo.chimeProbFactor ?? 1.0)))
  const rand = typeof opts.randomVal === 'number' ? opts.randomVal : Math.random()
  const shouldCheck = rand <= prob

  let delay = (hasSoftMention || isDirectFollowUpToBot || inActiveConvo) ? 1400 : 2600
  if (atmo.delayFactor) delay = Math.round(delay * atmo.delayFactor)

  return {
    shouldCheck,
    inActiveConvo,
    score: Math.min(100, score),
    prob: Number(prob.toFixed(2)),
    reason: (reasons.join('+') || 'general') + '@' + atmo.atmosphere,
    observeDelayMs: delay,
    atmosphere: atmo.atmosphere,
    atmosphereLabel: atmo.label,
    atmosphereGuidance: atmo.promptGuidance,
  }
}

export function isCompactCommand(text) {
  const t = String(text || '').trim()
  return /^(#?整理记忆|#?清理上下文|#?打包记忆|#?重置会话|整理一下记忆|把记忆整理一下|清理一下上下文|换个新会话)[。！!~～\s]*$/i.test(t)
}

const TASK_HINT = /(帮|做|弄|生成|整理|改|写|查|找|下载|上传|转|提取|总结|统计|分析|安装|部署|执行|跑|刷视频|刷B站|刷b站|去B站|去b站|看视频|玩手机|模拟器|发说说|发空间|QQ空间|qq空间|发语音|说句语音|森空岛|签到|塔罗|占卜|求签|运势|喜加一|PPT|ppt|文档|表格|图片|文件|代码|脚本|命令|备份|压缩|画|排版|翻译|归档|清点|发给|转告|带句话|提醒)/

export function looksLikeTask(text) {
  const t = String(text || '').trim()
  if (!t) return false
  if (t.length >= 22) return true
  return TASK_HINT.test(t)
}

// v3：模板只保留「这一轮要干什么」，人设/记忆/工具目录全部由 memory.buildContext 与 persona 注入，
// 不再像 v2 那样在人设、模板、续跑锚点、上下文约定里各写一份铁律（四处重复、还互相打架）。
export const DEFAULT_TEMPLATE = [
  '你正在 {scene} 跟「{name}」说话。',
  '{name} 刚对你说：',
  '{text}',
  '',
  '【怎么回】',
  '1. 回应「{name}」这次说的事。【你刚才回】标的是你自己的旧话。',
  '2. 按共同的人格和表达风格自然回应；聊天尽量简洁，任务结果完整。别为了凑人设重复口癖或机械追问。',
  '3. 要动手就调工具（发语音、发说说、玩模拟器、刷B站、签到、塔罗、求签、联网、跑命令…），拿到真实结果再说话；做不到就直说做不到。',
  '4. 不要翻炒前面已经聊透的旧话题，也不要重复你上一句说过的句式。',
].join('\n')

/** 组装交给 dsh 的任务文本 */
export function buildTask(p, template, extraContext = {}) {
  let content = p.text
  if (Array.isArray(p.rawItems) && p.rawItems.length > 1) {
    const lines = p.rawItems.map((line, idx) => `  ${idx + 1}. ${line}`).join('\n')
    content = `以下是这一批 ${p.rawItems.length} 条消息（逐条保留说话人；同一个人的补充连起来理解，不同人的话不能混为一个请求）：\n${lines}\n\n【核心要求】对方是一口气分开发送的，请综合理解其全部消息的完整意图，极简、直接地一次性统一回复，直奔主题，绝对不要逐句分开回复，禁止单独对开头的打招呼客套寒暄。`
  }
  if (extraContext?.atmosphereGuidance) {
    content += `\n\n${extraContext.atmosphereGuidance}`
  }
  if (extraContext?.searchGuidance) {
    content += `\n\n${extraContext.searchGuidance}`
  }
  if (extraContext?.recalledMemories) {
    content += `\n\n${extraContext.recalledMemories}`
  }
  const tpl = template && String(template).trim() ? String(template) : DEFAULT_TEMPLATE
  const scene = p.kind === 'group' ? `在 QQ 群（${p.chatId}）里` : '在 QQ 私聊里'
  return tpl
    .replaceAll('{name}', p.name)
    .replaceAll('{text}', content)
    .replaceAll('{scene}', scene)
}

/**
 * 把 get_forward_msg 返回的合并转发内容拍平成对话文本（v3 新增）
 * OneBot 各实现的字段名不统一，这里同时兼容 messages / content / message。
 * @param {any} payload get_forward_msg 的 data，或直接是 messages 数组
 * @param {number} depth 递归深度保护
 */
export function flattenForwardMessages(payload, depth = 0) {
  const list = Array.isArray(payload?.messages)
    ? payload.messages
    : Array.isArray(payload?.message)
      ? payload.message
      : Array.isArray(payload)
        ? payload
        : []
  const out = []
  for (const item of list.slice(0, 60)) {
    const sender = item?.sender?.card || item?.sender?.nickname || item?.nickname || '某人'
    const segs = Array.isArray(item?.message) ? item.message : Array.isArray(item?.content) ? item.content : []
    let line = ''
    for (const s of segs) {
      const t = s?.type
      if (t === 'text') line += s.data?.text ?? ''
      else if (t === 'image' || t === 'mface') line += '[图片]'
      else if (t === 'face') line += '[表情]'
      else if (t === 'record') line += '[语音]'
      else if (t === 'video') line += '[视频]'
      else if (t === 'file') line += `[文件:${s.data?.name || ''}]`
      else if (t === 'forward') line += depth < 2 ? '[嵌套转发]' : ''
      else if (t === 'at') line += `@${s.data?.qq || ''}`
    }
    const text = String(line).replace(/\s+/g, ' ').trim()
    if (text) out.push(`${sender}: ${text}`)
  }
  return out
}

/**
 * 把防抖缓冲里的一批消息合并成一次任务（v3.0.1 抽出为纯函数，便于单测）
 * 关键点：不能只取最后一条的 parsed —— 首条带的 replyToMsgId（引用）与 media 里的 forward（合并转发）
 * 会因此整段丢失，表现为「引用/转发只在单独发时才认得出」。
 * @param {Array<{parsed:object, media?:{paths?:string[],failed?:string[]}}>} items
 */
export function mergeParsedBatch(items = []) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.parsed)
  if (!list.length) return null
  const last = list[list.length - 1].parsed
  const participants = [...new Map(list.map(it=>[String(it.parsed.userId), {userId:it.parsed.userId,name:it.parsed.name}])).values()]
  const rawItems = list.map((it) => participants.length > 1 ? `【${it.parsed.name || it.parsed.userId}(ID:${it.parsed.userId})说】${it.parsed.text}` : it.parsed.text).filter(Boolean)
  const mediaSegments = list.flatMap((it) => it.parsed.media || [])
  const replyToMsgId = list.find((it) => it.parsed.replyToMsgId)?.parsed.replyToMsgId || last.replyToMsgId || null
  const quotedText = list.map((it) => it.parsed.quotedText).filter(Boolean).join(' ') || last.quotedText || ''
  return {
    parsed: {
      ...last,
      text: rawItems.join('\n'),
      rawItems,
      participants,
      sourceItems: list.map(it=>({userId:it.parsed.userId,name:it.parsed.name,text:it.parsed.text,messageId:it.parsed.messageId})),
      media: mediaSegments,
      replyToMsgId,
      quotedText,
    },
    media: {
      paths: list.flatMap((it) => it.media?.paths || []),
      failed: list.flatMap((it) => it.media?.failed || []),
    },
  }
}

/**
 * 把「被引用的那条消息」拍成上下文块（v3 新增，解决引用了什么完全看不见的问题）
 */
export function formatQuotedContext(original, currentName = '') {
  if (!original) return ''
  const parsed = parseEvent({ ...original, post_type: 'message', message_type: original.message_type || (original.group_id ? 'group' : 'private') })
  if (!parsed) return ''
  const who = parsed.name || parsed.userId || '某人'
  const body = String(parsed.text || '').replace(/\s+/g, ' ').trim()
  if (!body) return ''
  const quoted = body.slice(0, 300)
  const selfNote = String(parsed.userId) === String(parsed.self || '') ? '（这是你自己说过的话）' : ''
  return [
    '## 对方这条消息是在引用回复',
    `${currentName ? `${currentName} ` : ''}引用了「${who}」的这句话${selfNote}：`,
    `  > ${quoted}`,
    '回应时请理解它指的是这句，别答非所问。',
  ].join('\n')
}

export const SEARCH_INTENT_RE = /(?:帮我(?:搜|查)|搜(?:一下|下|搜|看)?|查(?:一下|下|查|看)?|网上搜|最新消息|最近有什么|最新动态|什么时候开服|什么时候上线|天气|最新版本|更新了什么|实时信息)/i
export const VOICE_INTENT_RE = /(?:发(?:条|段|个)?语音|用语音(?:说|回|念|讲|骂)?|语音(?:说|回|骂|念|讲|来一句)|说句话听听|听听你的声音|亲口跟我说)/i
export const QZONE_INTENT_RE = /(?:发(?:条|个|一篇)?(?:qq)?空间|发(?:条|个)?说说|更(?:一条|个)?说说|去(?:qq)?空间发)/i
export const PHONE_INTENT_RE = /(?:玩(?:会儿|一下|下)?手机|看(?:一眼|下)模拟器|模拟器截(?:个)?屏|连(?:上)?模拟器|用模拟器(?:刷|看|玩)|去模拟器(?:刷|看|打开))/i
export const INTENT_NEGATION_OR_TROUBLESHOOT_RE = /(?:为什么|为啥|怎么.{0,8}(?:没|不|失败|报错|问题|弄|配|设)|有点问题|没找到|找不到|日志|开关|配置|设置|别发|不要发|不用发)/i

/**
 * 判断用户输入是否真正要求触发语音/空间/模拟器动作（排除“玩手机有点问题/没找到日志/为什么发说说失败”等故障排查提问）
 */
export function isActionIntentTriggered(re, text) {
  const raw = String(text || '').trim()
  if (!raw || INTENT_NEGATION_OR_TROUBLESHOOT_RE.test(raw)) return false
  return re.test(raw)
}

const TOOL_TO_DIRECTIVE_TYPES = {
  send_voice: ['tts', 'voice'],
  post_qzone: ['qzone'],
  send_message: ['send'],
  set_reminder: ['remind'],
  phone_control: ['phone', 'adb'],
  write_diary: ['diary'],
  observe_world: ['world', 'humanworld'],
  search_web: ['search'],
  send_image: ['image'],
  send_sticker: ['emoji'],
  draw_tarot: ['image'],
}

/**
 * 过滤掉本轮已经在 Function Calling 工具循环中成功执行过的同类 [[...]] 后置指令，根除双轨制重复发送
 */
export function dedupeActionsWithToolLog(actions = [], toolLog = []) {
  if (!Array.isArray(actions) || !actions.length) return []
  if (!Array.isArray(toolLog) || !toolLog.length) return actions.slice()
  const norm = x => String(x || '').trim().replace(/^(?:private:|user:|qq:)/,'')
  return actions.filter(a => !toolLog.some(t => {
    if (!t?.ok || !(TOOL_TO_DIRECTIVE_TYPES[t.name] || []).includes(a.type)) return false
    const arg=t.args || {}
    if(a.type==='send') return norm(a.target)===norm(arg.target) && norm(a.message)===norm(arg.text)
    if(a.type==='remind') return norm(a.target||'self')===norm(arg.target||'self') && Number(a.minutes)===Number(arg.minutes) && norm(a.message)===norm(arg.message)
    if(['image','emoji','file'].includes(a.type)) return norm(a.value)===norm(arg.path || t.artifacts?.[0]?.path)
    if(['tts','voice'].includes(a.type)) return norm(a.value)===norm(arg.text)
    if(a.type==='qzone') return norm(a.content||a.value)===norm(arg.text)
    if(['phone','adb'].includes(a.type)) return norm(a.value)===norm(arg.action)
    if(a.type==='search') return norm(a.value)===norm(arg.query)
    return norm(a.value)===norm(arg.text)
  }))
}

/**
 * 格式化消息来源与发送人标签（供 WebUI 日志流清晰展示是谁在哪个窗口发出的消息）
 */
export function formatSenderLabel(parsed = {}, opts = {}) {
  const kind = parsed?.kind || 'private'
  const cid = String(parsed?.chatId || '')
  const uid = String(parsed?.userId || (kind === 'private' ? cid : '') || '')
  const uName = String(parsed?.name || opts.userName || uid || '未知').trim()
  if (kind === 'group') {
    const gName = String(opts.groupName || `群${cid}`).trim()
    return `[群:${gName}(${cid}) · 发送人:${uName}${uid ? `(QQ:${uid})` : ''}]`
  }
  if (kind === 'webui' || cid === 'webui') {
    return `[WebUI直连 · 发送人:${uName || '管理员'}]`
  }
  return `[私聊 · 发送人:${uName}${uid ? `(QQ:${uid})` : ''}]`
}

