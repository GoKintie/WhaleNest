#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve as _resolvePath } from 'node:path'
// 韦特塔罗牌占卜与牌阵绘图工具（/workspace/tools/tarot.mjs）
// 作为独立附带脚本运行，支持 78 张完整韦特塔罗正逆位抽牌（单张每日运势 / 三张过去现在未来牌阵），
// 并自动在 /workspace/out/ 生成高颜值 SVG/PNG 牌面视觉图供肥鱼发回 QQ。
//
// 用法：
//   node /workspace/tools/tarot.mjs draw [问题或主题]          # 默认抽三张牌阵（过去/现在/未来）
//   node /workspace/tools/tarot.mjs single [问题或主题]        # 抽单张塔罗牌
//   node /workspace/tools/tarot.mjs --json draw "今天抽卡运"   # 输出 JSON 结构

import { deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const WORKSPACE = process.env.WORKDIR || '/workspace'
const OUT_DIR = join(WORKSPACE, 'out')

export const MAJOR_ARCANA = [
  { id: 0, rom: '0', name: '愚者', en: 'The Fool', up: '放手一搏、纯粹开局、无畏冒险、意外惊喜', rev: '鲁莽踩坑、不计后果、三分钟热度、盲目冲动', roastUp: '脑子一热直接冲，但偏偏狗屎运不错', roastRev: '纯纯莽夫行为，小心下一步直接踩坑里' },
  { id: 1, rom: 'I', name: '魔术师', en: 'The Magician', up: '创造力拉满、资源齐备、手到擒来、骚操作成功', rev: '眼高手低、画大饼、工具翻车、花里胡哨没落地', roastUp: '手头牌全齐了，赶紧动手别磨叽', roastRev: '搁这儿画赛博大饼呢，先把环境跑通再吹' },
  { id: 2, rom: 'II', name: '女祭司', en: 'The High Priestess', up: '直觉敏锐、冷静旁观、洞察真相、闷声发财', rev: '神经过敏、钻牛角尖、表面冷静内心慌得一批', roastUp: '看破不说破，继续蹲着看戏就行', roastRev: '别脑补太多有的没的，纯属自己吓自己' },
  { id: 3, rom: 'III', name: '女皇', en: 'The Empress', up: '丰收富足、躺赢局、欧气爆棚、吃喝不愁', rev: '摆烂过度、钱包瘪了、拖延症晚期、贪多嚼不烂', roastUp: '富哥局，今天十连大概率出货', roastRev: '瘫在床上光想美事，再躺人都长蘑菇了' },
  { id: 4, rom: 'IV', name: '皇帝', en: 'The Emperor', up: '掌控全局、铁腕推进、稳如老狗、秩序井然', rev: '死板固执、强行硬刚、瞎指挥、控制欲爆棚', roastUp: '这波稳得不行，按你的路子直接推', roastRev: '别死磕那个破方案了，撞南墙上瘾是吧' },
  { id: 5, rom: 'V', name: '教皇', en: 'The Hierophant', up: '贵人指路、按文档办事、稳扎稳打、正统解法', rev: '打破常规、教程过时、不按套路出牌', roastUp: '老老实实抄作业，别自己瞎发明轮子', roastRev: '官方文档是个坑，得用野路子绕过去' },
  { id: 6, rom: 'VI', name: '恋人', en: 'The Lovers', up: '默契拉满、双向奔赴、关键抉择选对了', rev: '左右摇摆、既要又要、三心二意、搭档掉链子', roastUp: '这波配合丝滑，选哪个都不亏', roastRev: '小孩子才全都要，再纠结黄花菜都凉了' },
  { id: 7, rom: 'VII', name: '战车', en: 'The Chariot', up: '猛猛推进、正面对线、逆风翻盘、势如破竹', rev: '方向盘失灵、用力过猛、半路抛锚、红温暴走', roastUp: '直接油门踩死莽过去，包赢的', roastRev: '先踩脚刹车吧哥们，方向都歪到姥姥家了' },
  { id: 8, rom: 'VIII', name: '力量', en: 'Strength', up: '以柔克刚、心态稳健、硬抗压力、绝地拿捏', rev: '心态破防、力不从心、无能狂怒、信心崩盘', roastUp: '抗压能力拉满，这点小场面洒洒水', roastRev: '这就红温破防了？深呼吸别砸键盘' },
  { id: 9, rom: 'IX', name: '隐士', en: 'The Hermit', up: '闭关深造、独立排雷、人间清醒、自得其乐', rev: '闭门造车、孤芳自赏、社恐发作、钻进死胡同', roastUp: '关起门来自己搞，比在群里问快多了', roastRev: '别一个人闷头坐牢了，出来透口气' },
  { id: 10, rom: 'X', name: '命运之轮', en: 'Wheel of Fortune', up: '时来运转、欧皇附体、转机降临、风口起飞', rev: '非酋附体、喝凉水塞牙、计划赶不上变化、小保底歪了', roastUp: '风水轮流转，这把终于轮到你爽了', roastRev: '今天非气略重，抽卡强化建议立刻停手' },
  { id: 11, rom: 'XI', name: '正义', en: 'Justice', up: '因果分明、公平结算、付出一分拿一分、逻辑闭环', rev: '甩锅现场、双标现场、付出没回报、吃哑巴亏', roastUp: '一码归一码，这事儿理在你这边', roastRev: '小心替别人背黑锅，留个心眼存好日志' },
  { id: 12, rom: 'XII', name: '倒吊人', en: 'The Hanged Man', up: '换个视角、以退为进、短暂坐牢换长远收益', rev: '白白坐牢、无效内耗、死鸭子嘴硬、自我感动', roastUp: '先挂机让子弹飞一会儿，换个角度就通了', roastRev: '纯纯没苦硬吃，赶紧及时止损' },
  { id: 13, rom: 'XIII', name: '死神', en: 'Death', up: '彻底翻篇、推倒重来、断舍离、旧的不去新的不来', rev: '垂死挣扎、拖泥带水、死抱着烂摊子不撒手', roastUp: '别修修补补了，直接删库重开反而最快', roastRev: '早该淘汰的破玩意儿还留着过年呢' },
  { id: 14, rom: 'XIV', name: '节制', en: 'Temperance', up: '渐入佳境、丝滑调优、水到渠成、心态平和', rev: '失衡暴走、急于求成、冷热不均、配合稀碎', roastUp: '慢工出细活，调优完稳得一批', roastRev: '步子迈太大容易扯着蛋，稳一稳' },
  { id: 15, rom: 'XV', name: '恶魔', en: 'The Devil', up: '极致着迷、氪金冲动、熬夜上头、欲望拉满', rev: '戒断成功、脱离苦海、看清套路、不再当冤种', roastUp: '一眼上头局，小心钱包和发际线双双失守', roastRev: '终于不当大冤种了，可喜可贺' },
  { id: 16, rom: 'XVI', name: '高塔', en: 'The Tower', up: '惊天大雷、原地爆炸、打破幻想、不破不立', rev: '虚惊一场、勉强糊住、危机暗藏、侥幸逃过一劫', roastUp: '丸辣！防爆盾准备好，这波要炸个大的', roastRev: '虽然没当场炸穿，但隐患还在，赶紧打补丁' },
  { id: 17, rom: 'XVII', name: '星星', en: 'The Star', up: '希望亮起、灵感迸发、心想事成、未来可期', rev: '白日做梦、期待落空、目标太远够不着', roastUp: '前途一片光明，这波可以大胆做梦', roastRev: '理想很丰满，现实先看看余额和显存' },
  { id: 18, rom: 'XVIII', name: '月亮', en: 'The Moon', up: '迷雾重重、暗流涌动、直觉预警、夜长梦多', rev: '拨云见日、真相大白、误会解除、水落石出', roastUp: '水很深，晚上别乱做决定，当心有诈', roastRev: '迷雾散了，是谁在搞鬼一目了然' },
  { id: 19, rom: 'XIX', name: '太阳', en: 'The Sun', up: '大吉大利、全线飘红、欧气拉满、敞亮痛快', rev: '小有波折、高兴太早、表面风光背后累成狗', roastUp: '全场最佳的大吉牌，今天干啥都顺！', roastRev: '总体能成，就是别半场开香槟' },
  { id: 20, rom: 'XX', name: '审判', en: 'Judgement', up: '真相揭晓、满血复活、一锤定音、迎来翻身', rev: '逃避现实、翻旧账、犹豫不决错过良机', roastUp: '到了交卷算总账的时候，结果相当漂亮', roastRev: '别装鸵鸟了，该面对的逃不掉' },
  { id: 21, rom: 'XXI', name: '世界', en: 'The World', up: '圆满通关、功德圆满、全成就达成、完美收官', rev: '差临门一脚、烂尾预警、99%卡住', roastUp: '直接通关撒花，堪称完美闭环', roastRev: '就差最后哆嗦了，别在终点线前摆烂' },
]

const SUITS = [
  { key: 'wands', name: '权杖', theme: '行动与火热干劲', upVerb: '火力全开', revVerb: '三分钟热度或受阻' },
  { key: 'cups', name: '圣杯', theme: '人际与情绪共鸣', upVerb: '心情舒畅、朋友给力', revVerb: '情绪内耗或沟通翻车' },
  { key: 'swords', name: '宝剑', theme: '逻辑与锋利决断', upVerb: '思路清晰、一刀切中要害', revVerb: '嘴硬互怼、精神紧绷' },
  { key: 'pentacles', name: '星币', theme: '现实收益与稳健落地', upVerb: '实打实入账、稳健落地', revVerb: '破财氪金或性价比极低' },
]

const RANKS = [
  { r: '王牌', n: 'Ace', up: '新起点爆发', rev: '开局不利' },
  { r: '二', n: 'II', up: '平衡规划', rev: '左右为难' },
  { r: '三', n: 'III', up: '初步成果与合作', rev: '进度拖沓' },
  { r: '四', n: 'IV', up: '稳固守成', rev: '固步自封' },
  { r: '五', n: 'V', up: '冲突挑战', rev: '矛盾缓和' },
  { r: '六', n: 'VI', up: '顺风推进与顺畅回馈', rev: '失衡卡顿' },
  { r: '七', n: 'VII', up: '坚守防线与策略博弈', rev: '顾此失彼' },
  { r: '八', n: 'VIII', up: '全速运转与专注投入', rev: '忙中出错' },
  { r: '九', n: 'IX', up: '接近大成与独立复盘', rev: '疲惫紧绷' },
  { r: '十', n: 'X', up: '满载巅峰或扛起大局', rev: '负重过载' },
  { r: '侍从', n: 'Page', up: '好奇探索与新消息', rev: '幼稚毛躁' },
  { r: '骑士', n: 'Knight', up: '果断出击', rev: '鲁莽失控' },
  { r: '王后', n: 'Queen', up: '游刃有余', rev: '情绪化偏执' },
  { r: '国王', n: 'King', up: '老练掌控', rev: '独断专行' },
]

export function getFullDeck() {
  const deck = MAJOR_ARCANA.map((c) => ({ ...c, arcana: '大阿卡那' }))
  let id = 22
  for (const s of SUITS) {
    for (const rk of RANKS) {
      deck.push({
        id: id++,
        rom: rk.n,
        name: `${s.name}${rk.r}`,
        en: `${rk.n} of ${s.key}`,
        arcana: '小阿卡那',
        up: `${s.theme} · ${rk.up}（${s.upVerb}）`,
        rev: `${s.theme} · ${rk.rev}（${s.revVerb}）`,
        roastUp: `在${s.theme}这块算是${rk.up}，稳住就能拿捏`,
        roastRev: `${s.theme}容易${rk.rev}，别头铁硬冲`,
      })
    }
  }
  return deck
}

/**
 * 纯 Node 生成带像素边框与正逆位色彩配色的 PNG 图片（零外部字体依赖，任何容器都能稳定渲染）
 */
function renderTarotPngBuffer(cards) {
  const cardW = 140
  const cardH = 220
  const gap = 20
  const pad = 24
  const n = cards.length
  const width = pad * 2 + n * cardW + (n - 1) * gap
  const height = pad * 2 + cardH

  const rgba = Buffer.alloc(width * height * 4)
  const setPx = (x, y, r, g, b, a = 255) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const idx = (y * width + x) * 4
    rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = a
  }

  // 深海星空底色
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      setPx(x, y, 16, 22, 38)
    }
  }

  // 绘制每张塔罗牌卡面几何纹章
  cards.forEach((c, idx) => {
    const x0 = pad + idx * (cardW + gap)
    const y0 = pad
    const isUp = c.upright
    const borderCol = isUp ? [234, 179, 8] : [244, 63, 94] // 正位流金 / 逆位绯红
    const innerBg = isUp ? [28, 39, 68] : [45, 24, 46]

    for (let y = y0; y < y0 + cardH; y++) {
      for (let x = x0; x < x0 + cardW; x++) {
        const dx = x - x0, dy = y - y0
        if (dx < 3 || dx >= cardW - 3 || dy < 3 || dy >= cardH - 3) {
          setPx(x, y, ...borderCol)
        } else if (dx === 8 || dx === cardW - 9 || dy === 8 || dy === cardH - 9) {
          setPx(x, y, 148, 163, 184)
        } else {
          setPx(x, y, ...innerBg)
        }
      }
    }

    // 中心星芒几何图案
    const cx = x0 + Math.floor(cardW / 2)
    const cy = y0 + Math.floor(cardH / 2)
    const radius = 38
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (Math.abs(dist - radius) < 1.8 || Math.abs(dist - radius * 0.55) < 1.5) {
          setPx(cx + dx, cy + dy, ...borderCol)
        } else if (Math.abs(dx) + Math.abs(dy) < 16) {
          setPx(cx + dx, cy + dy, ...borderCol)
        }
      }
    }
  })

  // 编码为合法 PNG
  const rawScanlines = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4)
    rawScanlines[rowStart] = 0
    rgba.copy(rawScanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }
  const compressed = deflateSync(rawScanlines)

  const crcTable = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    crcTable[i] = c >>> 0
  }
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const makeChunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 4, 'ascii')
    data.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

export function drawTarot({ mode = 'spread3', topic = '' } = {}) {
  const deck = getFullDeck()
  const count = mode === 'single' ? 1 : 3
  const positions = count === 1 ? ['核心指引'] : ['过去 / 根源', '现在 / 处境', '未来 / 走向']
  const pool = [...deck]
  const drawn = []

  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * pool.length)
    const card = pool.splice(idx, 1)[0]
    const upright = Math.random() >= 0.42 // 58% 正位，42% 逆位
    drawn.push({
      position: positions[i],
      id: card.id,
      rom: card.rom,
      name: card.name,
      en: card.en,
      arcana: card.arcana,
      upright,
      orientation: upright ? '正位' : '逆位',
      meaning: upright ? card.up : card.rev,
      roast: upright ? card.roastUp : card.roastRev,
    })
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const imgPath = join(OUT_DIR, `tarot-${Date.now()}.png`)
  try {
    writeFileSync(imgPath, renderTarotPngBuffer(drawn))
  } catch {}

  const lines = [
    `🔮 韦特塔罗占卜 · ${count === 1 ? '单张直觉牌' : '圣三角牌阵（过去/现在/未来）'}${topic ? ` · 所问：「${topic}」` : ''}`,
    ...drawn.map((c, i) =>
      `${i + 1}. 【${c.position}】${c.name}（${c.rom} · ${c.orientation}）\n   · 牌面真意：${c.meaning}\n   · 肥鱼锐评：${c.roast}`
    ),
  ]

  return {
    ok: true,
    mode,
    topic,
    cards: drawn,
    imagePath: existsSync(imgPath) ? imgPath : '',
    summary: lines.join('\n'),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(_resolvePath(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const wantJson = args.includes('--json')
  const clean = args.filter((a) => a !== '--json')
  const mode = clean[0] === 'single' ? 'single' : 'spread3'
  const topic = (clean[0] === 'single' || clean[0] === 'draw' || clean[0] === 'spread3')
    ? clean.slice(1).join(' ')
    : clean.join(' ')
  const res = drawTarot({ mode, topic })
  if (wantJson) console.log(JSON.stringify(res))
  else console.log(res.summary + (res.imagePath ? `\n牌面图：${res.imagePath}` : ''))
}
