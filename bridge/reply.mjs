// 回传指令：dsh 只产出"意图"，平台能力由 QQ 与插件底座执行（bridge/reply.mjs · v2.8）
//
// dsh 在回答末尾可写：
//   [[image:/workspace/out/slide.png]]        发一张图（本地绝对路径）
//   [[emoji:/workspace/gallery/表情包/a.gif]] 发表情包（本地文件，按图片发）
//   [[file:/workspace/out/deck.pptx]]         发文件
//   [[like:123456]]                           给某人点赞（OneBot send_like）
//   [[diary:今天发生的一句话]]                写进今日事件碎片
//   [[world:对人类世界的一句话观察反思]]      写进 memory/human-world.md（dsh-bili-humanism 人间信笺）
//   [[send:目标QQ或昵称或群:要带的话]]        跨聊天窗口主动发消息/传话（打破窗口隔阂）
//   [[remind:目标QQ或昵称或群:分钟数:提醒话]] 跨窗口/本窗口定时提醒（如 [[remind:老王:10:记得看容器]]）
//   [[tts:要转语音说的话]] / [[voice:...]]    语音合成并发送真实 QQ 语音条（feiyu_voice 多引擎 TTS）
//   [[qzone:说说内容]] 或 [[qzone:正文|图路径]] 发布 QQ 空间说说（onebot-qzone / astrbot_plugin_qzone）
//   [[draw:生图提示词]]                       调用外部模型画图并发送（多模态插件接口）
//   [[phone:动作:参数]] / [[adb:指令]]        手机/MuMu模拟器控制（如 [[phone:play:bilibili]] / [[phone:shot]]）

const RE = /\[\[(image|emoji|file|like|qzone|diary|world|send|remind|tts|voice|draw|phone|adb|search):([^\]\n]{1,600})\]\]/gi

export const SUPPORTED = new Set([
  'image', 'emoji', 'file', 'like', 'qzone', 'diary', 'world',
  'send', 'remind', 'tts', 'voice', 'draw', 'phone', 'adb', 'search',
])
export const NEEDS_EXTRA = new Set([])

/**
 * 解析跨窗口传话指令参数：[[send:目标:内容]] 或 [[send:group:30003:内容]]
 */
export function parseSendValue(rawVal) {
  const s = String(rawVal || '').trim()
  if (!s) return null
  const prefixMatch = s.match(/^(group|群|private|user|qq)[:：](\d{4,13})[:：](.+)$/i)
  if (prefixMatch) {
    const kindTag = prefixMatch[1].toLowerCase()
    const target = `${kindTag === 'group' || kindTag === '群' ? 'group' : 'private'}:${prefixMatch[2]}`
    const message = prefixMatch[3].trim()
    return message ? { target, message } : null
  }
  const idx = s.search(/[:：]/)
  if (idx <= 0) return null
  const target = s.slice(0, idx).trim()
  const message = s.slice(idx + 1).trim()
  if (!target || !message) return null
  return { target, message }
}

/**
 * 解析定时提醒指令参数：[[remind:目标:分钟数:内容]] 或 [[remind:分钟数:内容]]（默认当前会话）
 */
export function parseRemindValue(rawVal, defaultTarget = 'self') {
  const s = String(rawVal || '').trim()
  if (!s) return null

  const pref = s.match(/^(group|群|private|user|qq)[:：](\d{4,13})[:：](\d+(?:\.\d+)?)[:：](.+)$/i)
  if (pref) {
    const kindTag = pref[1].toLowerCase()
    const target = `${kindTag === 'group' || kindTag === '群' ? 'group' : 'private'}:${pref[2]}`
    const minutes = Math.max(0.1, Number(pref[3]))
    const message = pref[4].trim()
    return message ? { target, minutes, message } : null
  }

  const three = s.match(/^([^:：]+?)[:：](\d+(?:\.\d+)?)[:：](.+)$/)
  if (three) {
    return {
      target: three[1].trim(),
      minutes: Math.max(0.1, Number(three[2])),
      message: three[3].trim(),
    }
  }

  const two = s.match(/^(\d+(?:\.\d+)?)[:：](.+)$/)
  if (two) {
    return {
      target: defaultTarget,
      minutes: Math.max(0.1, Number(two[1])),
      message: two[2].trim(),
    }
  }
  return null
}

export function parseDirectives(input) {
  const actions = []
  const text = String(input || '').replace(RE, (full, rawType, value) => {
    let type = String(rawType || '').toLowerCase()
    if (type === 'voice') type = 'tts'
    const v = String(value || '').trim()
    if (!v) return full
    if (type === 'send') {
      const parsed = parseSendValue(v)
      if (parsed) actions.push({ type: 'send', value: v, ...parsed })
      return ''
    }
    if (type === 'remind') {
      const parsed = parseRemindValue(v)
      if (parsed) actions.push({ type: 'remind', value: v, ...parsed })
      return ''
    }
    if (type === 'search') {
      actions.push({ type: 'search', value: v, query: v })
      return ''
    }
    if (type === 'qzone') {
      const parts = v.split('|').map((s) => s.trim()).filter(Boolean)
      actions.push({
        type: 'qzone',
        value: v,
        content: parts[0] || v,
        images: parts.slice(1),
      })
      return ''
    }
    actions.push({ type, value: v })
    return ''
  })
  return {
    text: text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(),
    actions,
  }
}

/** 转成 OneBot 消息段；返回 null 表示这条动作由上层处理器执行 */
export function toSegment(action) {
  if (!action) return null
  if (action.type === 'image' || action.type === 'emoji') {
    return { type: 'image', data: { file: `file://${action.value}` } }
  }
  if (action.type === 'file') {
    return { type: 'file', data: { file: `file://${action.value}` } }
  }
  if (action.type === 'record') {
    return { type: 'record', data: { file: `file://${action.value}` } }
  }
  return null
}
