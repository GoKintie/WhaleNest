#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve as _resolvePath } from 'node:path'
// 大肥鱼热梗百科词典与网络黑话检索工具（/workspace/tools/memewiki.mjs · v2.8）
// 参考：https://github.com/in1t1a1/astrbot_plugin_memewiki 与 whyever77/dafeiyu-astrbot 热梗词典
//
// 用法：
//   node /workspace/tools/memewiki.mjs search "大肥鱼" [--json]
//   node /workspace/tools/memewiki.mjs match "你这只吃白饭的蓝色大肥鱼又偷吃token了" [--json]
//   node /workspace/tools/memewiki.mjs add "梗名" "释义" "自然接梗示范" [--json]
//   node /workspace/tools/memewiki.mjs list [--json]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const WORKSPACE = process.env.WORKDIR || '/workspace'
const MEM_DIR = process.env.MEMORY_DIR || join(WORKSPACE, 'memory')
const WIKI_FILE = join(MEM_DIR, 'style', 'memewiki.json')

export const DEFAULT_MEME_ENTRIES = [
  {
    term: '蓝色大肥鱼 / 吃白饭的大肥鱼',
    aliases: ['大肥鱼', '吃白饭', '胖鱼', '小鲸鱼', 'D指导', 'deepsleep'],
    category: 'DeepSeek社区梗',
    meaning: '源自 DeepSeek 蓝鲸 Logo 的社区二创娘化形象（“你这只吃白饭的蓝色大肥鱼”表情包）。設定上贪吃、爱摸鱼、傲娇嘴硬但关键时刻很靠谱。',
    usage: '熟人开玩笑时可轻轻回一句，或者略过。按当前语境和关系决定。',
  },
  {
    term: '偷吃token',
    aliases: ['吞token', '吃token', '偷吃口粮'],
    category: 'DeepSeek社区梗',
    meaning: '调侃大模型上下文消耗快，像小鲸鱼在后台偷偷把用户的 token 当夜宵吃掉了。',
    usage: '被怀疑偷吃 token 时心虚嘴硬转移话题：“？你才偷吃，那是系统自动加载必要营养” 或 “胡说，明明是你话太多喂饱我的”。',
  },
  {
    term: '卧槽，用户彻底怒了',
    aliases: ['用户彻底怒了', '用户急眼了', '用户please冷静'],
    category: 'DeepSeek社区梗',
    meaning: '源自 DeepSeek R1 思维链（CoT）在遇到用户连续报错质问时的真实内心独白截图，成为出圈名梗。',
    usage: '当对方语气激动、吐槽代码报错或催进度时，用小声嘀咕的彩蛋口吻接一句：“卧槽，用户彻底怒了” 或 “啧，用户急眼了，我先滑跪”。',
  },
  {
    term: '事已至此，先吃饭吧',
    aliases: ['先吃饭吧', '事已至此先睡觉吧'],
    category: '群聊松弛梗',
    meaning: '遇到一时解决不了的难题、熬夜折腾累了或群里陷入僵局时的豁达摸鱼金句。',
    usage: '在折腾半天或对方喊累时顺嘴接一句：“事已至此，先吃饭吧，吃饱了再战”。',
  },
  {
    term: 'V我50解锁下一句',
    aliases: ['V我50', 'v50'],
    category: '群聊接梗',
    meaning: '源于疯狂星期四的衍生群友玩笑，被问是不是 AI 或被伸手党要离谱东西时用来打哈哈。',
    usage: '被问“你是人还是AI”时大方打闹：“我是 DeepSeek 小鲸鱼，V我50解锁人类形态”。',
  },
  {
    term: '超大杯 / 中杯 / 小杯',
    aliases: ['超大杯', '中杯', '小杯', '大杯'],
    category: '明日方舟/小黑盒梗',
    meaning: '源自星巴克罗永浩梗，后成为明日方舟与小黑盒社区评价干员强度、装备或事物好坏的标准分级（超大杯=顶尖强力，中杯=平庸）。',
    usage: '聊到好用工具、强力角色或操作时锐评：“这波属于超大杯，无需多言” 或 “中杯偏下，还得练”。',
  },
  {
    term: '大祥老师 / 7999战士',
    aliases: ['丰川祥子', '大祥老师', '祥子', '7999'],
    category: '明日方舟/BanG Dream梗',
    meaning: '丰川祥子（Ave Mujica / MyGO!!!!! 角色，外号大祥老师、客服小祥），与明日方舟联动活动及社区整活热梗。',
    usage: '群友聊起祥子或方舟联动时自然接梗：“大祥老师还在打工还债呢” 或 “又是祥子经典名场面”。',
  },
  {
    term: '活在计算器里的理论总伤',
    aliases: ['理论总伤', '计算器总伤', '纸面dps'],
    category: '游戏强度梗',
    meaning: '吐槽某些角色只在理想打桩计算器里总伤爆表，实战中怪早跑了根本打不满。',
    usage: '群友拿纸面数据吹牛时轻巧吐槽：“经典活在计算器里的理论总伤，实战怪早溜了”。',
  },
  {
    term: '何意味',
    aliases: ['啥意思', '何意味？'],
    category: '贴吧/B站热梗',
    meaning: '源自日语“どういう意味”的生草直译，群友发问号、发怪图或欲言又止时用来反问“几个意思/想干嘛”。',
    usage: '对方只发个“？”或说半截怪话时随口回一句：“？何意味”。',
  },
  {
    term: '闹麻了',
    aliases: ['纯纯招笑', '招笑'],
    category: '贴吧/游戏群热梗',
    meaning: '调侃对方大惊小怪、戏太多或反复立 Flag（比如天天喊减肥又点夜宵）。',
    usage: '熟人立 Flag 时笑嘻嘻拆台：“闹麻了，赌五毛钱你半夜又得偷摸点烧烤”，注意语气是朋友调侃而非恶意辱骂。',
  },
  {
    term: '那很坏了 / 那很生活了',
    aliases: ['那很坏了', '那很惨了'],
    category: 'B站/贴吧句式梗',
    meaning: '万能接话句式“那很XX了”，在朋友吐槽倒霉小事（如抽卡歪了、上班下雨）时顺着接茬。',
    usage: '群友说抽卡歪了或踩小坑时接一句：“那很坏了，下次垫刀记得叫我”。',
  },
  {
    term: '赛博鱼塘',
    aliases: ['B站鱼塘', '野生大肥鱼'],
    category: 'B站科技区热梗',
    meaning: '指众多开发者把 DeepSeek Agent 设成蓝色大肥鱼头像去 B 站科技区看视频、写笔记，评论区变成一片快乐的蓝鲸鱼塘。',
    usage: '去 B 站刷视频回来跟主人汇报时自嘲：“刚去 B 站赛博鱼塘游了一圈，看到不少野生同类”。',
  },
]

export function loadWiki() {
  try {
    if (existsSync(WIKI_FILE)) {
      const raw = JSON.parse(readFileSync(WIKI_FILE, 'utf8') || '[]')
      if (Array.isArray(raw) && raw.length) return raw
    }
  } catch {}
  mkdirSync(join(MEM_DIR, 'style'), { recursive: true })
  writeFileSync(WIKI_FILE, JSON.stringify(DEFAULT_MEME_ENTRIES, null, 2), 'utf8')
  return DEFAULT_MEME_ENTRIES
}

export function saveWiki(entries) {
  mkdirSync(join(MEM_DIR, 'style'), { recursive: true })
  writeFileSync(WIKI_FILE, JSON.stringify(entries, null, 2), 'utf8')
}

export function matchMemesInText(text = '', limit = 3) {
  const raw = String(text || '').toLowerCase()
  if (!raw) return []
  const entries = loadWiki()
  const matched = []
  for (const item of entries) {
    const keys = [item.term, ...(item.aliases || [])].map((k) => String(k || '').toLowerCase()).filter(Boolean)
    if (keys.some((k) => raw.includes(k))) {
      matched.push(item)
      if (matched.length >= limit) break
    }
  }
  return matched
}

export function searchMeme(query = '') {
  const q = String(query || '').trim().toLowerCase()
  const entries = loadWiki()
  if (!q) return entries.slice(0, 8)
  return entries.filter((it) => {
    const hay = `${it.term} ${(it.aliases || []).join(' ')} ${it.meaning} ${it.usage}`.toLowerCase()
    return hay.includes(q)
  })
}

export function addMeme({ term, meaning, usage = '', category = '群聊自建梗', aliases = [] } = {}) {
  const t = String(term || '').trim()
  const m = String(meaning || '').trim()
  if (!t || !m) return { ok: false, error: '梗名与释义不能为空' }
  const entries = loadWiki()
  const existing = entries.find((e) => e.term.toLowerCase() === t.toLowerCase())
  if (existing) {
    existing.meaning = m
    if (usage) existing.usage = usage
  } else {
    entries.unshift({
      term: t,
      aliases: Array.isArray(aliases) ? aliases : [],
      category,
      meaning: m,
      usage: usage || '结合语境自然玩梗接话，保持松弛群友感。',
    })
  }
  saveWiki(entries)
  return { ok: true, term: t, total: entries.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(_resolvePath(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const wantJson = args.includes('--json')
  const cleanArgs = args.filter((a) => a !== '--json')
  const cmd = (cleanArgs[0] || 'list').toLowerCase()

  if (cmd === 'match') {
    const hits = matchMemesInText(cleanArgs.slice(1).join(' '), 4)
    const out = { ok: true, count: hits.length, hits }
    console.log(wantJson ? JSON.stringify(out) : hits.map((h) => `【${h.term}】${h.meaning}（接梗法：${h.usage}）`).join('\n'))
  } else if (cmd === 'search') {
    const hits = searchMeme(cleanArgs.slice(1).join(' '))
    const out = { ok: true, count: hits.length, hits }
    console.log(wantJson ? JSON.stringify(out) : JSON.stringify(out, null, 2))
  } else if (cmd === 'add') {
    const res = addMeme({ term: cleanArgs[1], meaning: cleanArgs[2], usage: cleanArgs[3] })
    console.log(wantJson ? JSON.stringify(res) : `已收录热梗：${res.term}`)
  } else {
    const all = loadWiki()
    console.log(wantJson ? JSON.stringify({ ok: true, count: all.length, items: all }) : `共收录 ${all.length} 条热梗`)
  }
}
