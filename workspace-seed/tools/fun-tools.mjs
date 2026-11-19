#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve as _resolvePath } from 'node:path'
// 赛博求签 / 贴吧老黄历 / 游戏喜加一与热榜工具（/workspace/tools/fun-tools.mjs）
// 作为独立附带脚本运行，支持在对话中问运势、求签、查喜加一时直接调用回答。
//
// 用法：
//   node /workspace/tools/fun-tools.mjs fortune [QQ号或名字]
//   node /workspace/tools/fun-tools.mjs freebies
//   node /workspace/tools/fun-tools.mjs --json fortune demo-user

import { createHash } from 'node:crypto'

function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const LOTS = [
  { rank: '上上签 · 欧皇附体', score: 96, poem: '十连双黄紫气来，编译一次零报错', good: ['单抽试水', '推新主线/肉鸽', '重构代码', '吃顿好的'], bad: ['帮群友背锅', '半夜改宿主机网络'], comment: '今天运势顶中顶，抽卡不歪、写码不崩，建议把存着的寻访凭证掏出来试试水' },
  { rank: '大吉 · 超大杯运势', score: 88, poem: '大祥老师七九九，顺风顺水摸大鱼', good: ['摸鱼冲浪', '刷B站看乐子', '清日常体力', '跟损友吹水'], bad: ['头铁跟杠精对线', '强行升驱动'], comment: '稳稳的幸福局，干啥都顺手，适合在群里看别人红温' },
  { rank: '中吉 · 稳如老狗', score: 78, poem: '机箱风扇慢慢转，不求暴富但求稳', good: ['按部就班搬砖', '备份配置', '森空岛签到', '喝冰可乐'], bad: ['冲动剁手原价买游戏', '不看文档乱填端口'], comment: '虽然没天降横财，但胜在绝对不翻车，属于闷声发财局' },
  { rank: '小吉 · 摸鱼咸鱼', score: 66, poem: '比上不足比下余，躺平摆烂最舒坦', good: ['准点下班/下课', '看番补剧', '清理图库'], bad: ['强行下毒池捞卡', '熬夜到两点以后'], comment: '中杯偏上水平，别整大活就行，老老实实摸鱼包平安的' },
  { rank: '末吉 · 赛博散步', score: 54, poem: '小坑不断大雷无，心态放平当看戏', good: ['先存快照再改代码', '多喝热水', '潜水偷表情包'], bad: ['裸奔改生产环境', '赌小保底不歪'], comment: '今天运气有点薛定谔，干正事前记得先备份，别赌概率' },
  { rank: '下签 · 红温预警', score: 32, poem: '端口冲突连不上，小保底歪老常驻', good: ['及时止损', '关机睡觉', '把锅甩给网络波动'], bad: ['上头氪金硬抽', 'rm -rf 不看路径'], comment: '逆天运势预警！今天谁劝你抽卡就是在害你，老实苟住等明天刷新' },
]

const LUCKY_ITEMS = [
  '丰川祥子联动皮肤', '冰镇快乐水', '罗德岛合成玉×600', '满配 4090 显卡',
  '飞牛 NAS 绿灯状态', '小黑盒喜加一提醒', '加浓冰美式', '无语猫猫头表情包',
]

export function getDailyFortune(userKey = 'default') {
  const day = localDay()
  const hash = createHash('sha256').update(`${day}:${userKey}`).digest()
  const lotIdx = hash[0] % LOTS.length
  const itemIdx = hash[1] % LUCKY_ITEMS.length
  const luckyNum = (hash[2] % 9) + 1
  const lot = LOTS[lotIdx]

  const lines = [
    `🎋 今日赛博求签（${day} · 对象：${userKey}）`,
    `· 签位：【${lot.rank}】（运势指数 ${lot.score}/100）`,
    `· 签诗：${lot.poem}`,
    `· 今日宜：${lot.good.join(' / ')}`,
    `· 今日忌：${lot.bad.join(' / ')}`,
    `· 幸运物：${LUCKY_ITEMS[itemIdx]}（幸运数字 ${luckyNum}）`,
    `· 肥鱼批语：${lot.comment}`,
  ]

  return {
    ok: true,
    day,
    user: userKey,
    ...lot,
    luckyItem: LUCKY_ITEMS[itemIdx],
    luckyNum,
    summary: lines.join('\n'),
  }
}

export async function getGamingFreebies(fetchFn = globalThis.fetch) {
  // 尝试从公开免费游戏源拉取最新喜加一信息，失败则回退到本地实用提示
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const r = await fetchFn('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN', {
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
    const d = await r.json().catch(() => ({}))
    const elems = d?.data?.Catalog?.searchStore?.elements || []
    const freeNow = elems
      .filter((e) => e?.promotions?.promotionalOffers?.length > 0 && e?.price?.totalPrice?.discountPrice === 0)
      .map((e) => `· 《${e.title}》（Epic 本周免费领）`)
    if (freeNow.length) {
      return {
        ok: true,
        items: freeNow,
        summary: `🎮 最新白嫖/喜加一速报：\n${freeNow.join('\n')}\n（打开小黑盒或 Epic 客户端即可一键入库，不领白不领）`,
      }
    }
  } catch {}
  return {
    ok: true,
    items: [],
    summary: '🎮 喜加一提示：Epic 每周五凌晨更新周免游戏，Steam 史低与背刺榜可直接在小黑盒 App 查看。',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(_resolvePath(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const wantJson = args.includes('--json')
  const clean = args.filter((a) => a !== '--json')
  const cmd = clean[0] || 'fortune'

  ;(async () => {
    if (cmd === 'freebies' || cmd === 'game') {
      const res = await getGamingFreebies()
      if (wantJson) console.log(JSON.stringify(res))
      else console.log(res.summary)
      return
    }
    const user = clean[1] || '管理员'
    const res = getDailyFortune(user)
    if (wantJson) console.log(JSON.stringify(res))
    else console.log(res.summary)
  })()
}
