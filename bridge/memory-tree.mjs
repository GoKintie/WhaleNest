import {prepareRemoteRecall,remoteSimilarity,embeddingConfig,requestEmbeddings} from './semantic-memory.mjs'
// 联想记忆树 + 128 维语义向量引擎 + 情景层/夜间巩固/遗忘曲线（bridge/memory-tree.mjs · v3.3）
//
// 核心架构（v3.3 升级）：
// 1. 满配 36 组核心语义同义词簇 + 2~3 字词元有符号随机投影（128 维单空间正交向量，零外部依赖、微秒级、不混用异构向量空间）。
// 2. 向量与 JSON 结构物理分家：
//    - `tree.json` 只存轻量图拓扑与节点元数据（不含 800 字节的浮点数组，单节点体积缩小 90%）；
//    - 向量常驻内存 `vecCache` 并以 Int8 量化二进制落盘 `tree-vec.bin`。
// 3. 三层记忆结构与艾宾浩斯遗忘曲线（Ebbinghaus Retention）：
//    - 往事层 (`episode`) → 情景层 (`scene`，30 分钟同窗口连续话题自动归并) → 事实层 (`fact`，夜间巩固 `consolidateTree` 提炼并记录 `derived_from` 溯源)；
//    - 有效强度 `Strength = (w + ln(1+hits)*2.5) * exp(-ageDays / halfLife)`，淘汰时按强度+最新时间戳排序，绝不“删新留旧”，且 `MAX_EPISODES` 独立生效。
// 4. 高信噪比启发式召回（`recallFromTree`）：
//    - 纯读操作不触发写盘；
//    - 说话人先验与 `suspense` 仅在与当前查询存在语义/概念交集时提权，配合相对分数截断（`score >= top1 * 0.45`）彻底砍掉第 2~5 名凑数噪音。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readJson, readJsonLines, writeJsonSoon } from './store.mjs'
import {conversationKey,visibleIn} from './context-scope.mjs'

const MAX_NODES = 4000
const MAX_EPISODES = 2200
const MAX_SCENES = 800
const EMBED_DIM = 128
const SCENE_WINDOW_MS = 30 * 60 * 1000

const STOP_CHARS = new Set('的了和是我你他她它们这那有就不在也都还吗呢吧啊呀哦嗯个把被让给对向从与及或但而所以因为如果就是没有什么怎么为什么可以可能应该已经一个自己时候现在今天明天昨天这个那个哪些着过啦嘛呗哈嘿呵额'.split(''))
const STOP_SUFFIX_CHARS = new Set('的了着过吗呢吧啊呀哦嗯啦嘛呗'.split(''))

// 300+ 高频虚词与口语碎片停用表，防止滑窗切出「卡好」「好多」「重启了」等无意义概念节点
const STOP_TOKENS = new Set([
  '肥鱼', '小鲸鱼', '大肥鱼', '群友', '大家', '这个', '那个', '什么', '怎么', '为什么', '可以', '觉得',
  '今天', '明天', '昨天', '我们', '你们', '他们', '一下', '还是', '现在', '如果', '不是', '就是', '而且',
  '所以', '因为', '然后', '哈哈', '哈哈哈', '笑死', '图片', '表情包', '语音', '文件', '视频', '聊天记录',
  '嗯嗯', '好的', '收到', '谢谢', '在吗', '在不在', '知道', '看到', '听到', '出来', '进去', '过来', '过去',
  '起来', '下去', '上来', '下来', '回去', '回来', '没有', '可能', '应该', '已经', '自己', '时候', '哪里',
  '哪儿', '怎么弄', '怎么办', '怎么搞', '不知道', '能不能', '有没有', '好不好', '行不行', '是不是', '对不对',
  '这玩意', '那玩意', '好多', '好少', '好大', '好小', '卡好', '重启了', '看一下', '看下', '看看', '帮我',
  '帮忙', '麻烦', '请问', '问下', '说下', '说说', '聊下', '聊聊', '刚才', '刚刚', '最近', '平时', '一般',
  '基本', '差不多', '左右', '之类', '等等', '哪怕', '万一', '其实', '本来', '原来', '果然', '居然', '竟然',
  '简直', '根本', '完全', '实在', '确实', '肯定', '一定', '大概', '也许', '或者', '还是说', '就是说', '说是',
  '没啥', '干嘛', '干啥', '为啥', '咋办', '咋弄', '咋搞', '咋样', '怎么样', '如何', '多少', '几个', '一点',
  '一些', '一直', '一起', '一共', '一样', '一般般', '一会儿', '一会', '马上', '立刻', '赶紧', '随便', '顺便',
  '直接', '突然', '忽然', '终于', '居然', '反正', '横竖', '干脆', '索性', '不如', '宁可', '哪怕是', '至于',
  '关于', '对于', '按照', '根据', '通过', '由于', '为了', '除了', '除非', '无论', '不管', '尽管', '虽然',
  '但是', '不过', '然而', '可是', '只是', '偏偏', '倒也', '倒是', '反而', '反倒', '否则', '不然', '要不然',
  '的话', '罢了', '而已', '罢了', '算了', '行吧', '好吧', '得了吧', '拉倒', '随便吧', '无所谓', '没问题',
  '不要', '不用', '不必', '不准', '不行', '不好', '不对', '不够', '不到', '不了', '不会', '不能', '不敢',
  '不想', '不愿', '不肯', '不懂', '不明白', '不清楚', '不晓得', '没看', '没听', '没说', '没做', '没弄',
  '完了', '去了', '来了', '走了', '到了', '好了', '行了', '算了', '罢了', '够了', '多了', '少了', '大了',
])

const NOISE_RE = /^(\[(?:图片|表情包|文件|语音|视频|聊天记录|表情)\d*\][\s,，。]*)+$/
const LAUGH_RE = /^[哈嘿呵啊嗯哦额6？?！!。.，,~～\s]+$/
const LOW_ENTROPY_RE = /^(在吗|在不在|你好|早|早安|晚安|哈哈+|笑死|草|牛逼|nb|6+|好的|收到|行吧|好吧|哦+|嗯+|？+|\?+|！+|略+|原来如此|这样啊|好家伙|确实|没事|咋不回|有个很诡异的|嗯嗯收到|[啊哈嘿嗯哦]+太强了)$/i
const SINGLE_CONCEPT_OK = new Set('猫狗钱吃睡病车房茶酒书歌雨雪风药表妈爸姐哥弟妹'.split(''))
const CONCEPT_RE = /(docker|nas|fnos|飞牛|群晖|端口|容器|镜像|显卡|显存|gpu|cuda|pytorch|rvc|applio|cosyvoice|indextts|模型|机器人|插件|音色|音频|声线|语音条|token|额度|方舟|终末地|森空岛|塔罗|求签|星铁|原神|鸣潮|舞萌|maimai|mc|minecraft|steam|epic|b站|bilibili|刷视频|视频|贴吧|小黑盒|空间|说说|t2i|agn|agi|gemini|deepseek|claude|operit|shizuku|flclash|napcat|maibot|记忆树|海马体|人设|代码|脚本|报错|崩溃|重启|备份|硬盘|固态|内存|电源|功耗|路由|反向代理|证书|域名|公网|内网|端口映射|权限|锁屏|前台|开黑|上号|抽卡|大保底|沉船|加班|熬夜|摸鱼|外卖|午饭|晚饭|早饭|夜宵|食堂|汉堡|牛肉|土豆|烧烤|火锅|奶茶|咖啡|炸鸡|麦当劳|小鱼干|考试|四级|六级|挂科|汇报|ppt|结课报告|导盲头盔|头盔|摄像头|社团|手表|套餐|驾照|搬家|生病|发烧|感冒|头疼|胃疼|医院|看病|吃药|失眠|做梦|天气|降温|下雨|下雪|生日|礼物|过年|春节|放假|假期|回家|老家|吃饭|做饭|聚餐|发票|报销|收据|工资|房租|租房|快递|网购|电影|音乐|减肥|健身|面试|简历|offer|工作|上班|下班|辞职|请假|迟到|出差|旅游|妈妈|我妈|老妈|爸爸|我爸|老爸|姐姐|哥哥|弟弟|妹妹|朋友|室友|同学|同事|老板|导师|对象|女朋友|男朋友|紧张|焦虑|害怕|开心|难过|伤心|委屈|生气|气死|可爱|漂亮|弄丢|丢了|黑屏|猫|猫咪|小猫|狗|小狗|宠物|电源线)/gi

// 关系谓词模式（参考 MaiBot A_Memorix 事实/关系三元组提取：Subject -> Predicate -> Object）
const RELATION_FACT_RE = /(?:我|本人|自己|刚|最近|正在|还在|准备|打算|喜欢|讨厌|买了|换了|装了|配了|在做|在写|在弄|在玩|把|以后默认用)([^，。！？\n]{3,38})/i

// ---------------------------------------------------------------------------
// 满配 36 组核心语义同义词簇（严格对应前 0..35 维正交语义锚点，0 空转）
// ---------------------------------------------------------------------------
export const SEMANTIC_CLUSTERS = [
  { name: '显卡算力', re: /(显卡|gpu|显存|vram|5090|5080|5070|5060|4090|4080|4070|4060|3090|3080|cuda|nvenc|tensor|算力|掉驱动|黑屏|花屏|帧率|fps|光追)/gi },
  { name: '电源硬件', re: /(电源|电源线|瓦数|550w|650w|750w|850w|1000w|功耗|供电|跳闸|重启|死机|主板|cpu|处理器|内存条|散热|风扇|水冷|机箱|装机|硬件|配电脑)/gi },
  { name: '存储网络', re: /(硬盘|固态|ssd|nvme|机械盘|raid|阵列|容量|备份|路由器|交换机|网线|千兆|万兆|内网|公网|穿透|frp|tailscale|cloudflare|tunnel|反代|nginx|域名|证书|ssl|https|端口|映射|防火墙)/gi },
  { name: 'NAS与容器', re: /(nas|飞牛|fnos|群晖|synology|威联通|unraid|truenas|docker|compose|容器|镜像|虚拟化|虚拟机|pve|esxi|linux|debian|ubuntu|ssh|挂载|宿主机)/gi },
  { name: '大模型AI', re: /(大模型|llm|ai|人工智能|deepseek|gemini|claude|gpt|openai|qwen|千问|百炼|硅基流动|vertex|argon|token|额度|余额|计费|配额|429|限流|推理|思考|reasoner|r1|v3|prompt|提示词|上下文|agent|微调|训练)/gi },
  { name: 'AI语音翻唱', re: /(语音|tts|音色|复刻|cosyvoice|sovits|rvc|applio|svc|翻唱|唱歌|声线|模型训练|音频|wav|mp3|降噪|伴奏|干声|电音|走音)/gi },
  { name: '代码开发', re: /(代码|脚本|编程|写代码|bug|报错|异常|崩溃|死锁|竞态|单测|测试|selftest|修复|重构|函数|接口|api|前端|后端|node|js|mjs|python|shell|git|打包|发布|上线)/gi },
  { name: '安卓模拟器', re: /(模拟器|mumu|雷电|蓝叠|安卓|android|手机|adb|portproxy|16384|16400|截屏|划拉|点击|触控|装应用|apk)/gi },
  { name: '明日方舟', re: /(明日方舟|方舟|arknights|鹰角|海猫|森空岛|skland|终末地|endfield|干员|六星|抽卡|寻访|合成玉|源石|理智|基建|肉鸽|萨卡兹|卫戍|大祥|祥子|克莱门莎|火陈|超大杯|中杯|小杯|总伤|dps)/gi },
  { name: 'PC主机游戏', re: /(游戏|开黑|上号|上分|五黑|四等一|steam|epic|喜加一|打折|特惠|lol|英雄联盟|大乱斗|云顶|金铲铲|瓦罗兰特|无畏契约|打瓦|apex|csgo|cs2|吃鸡|黑神话|怪猎|通关|坐牢|红温)/gi },
  { name: '二游抽卡', re: /(原神|星铁|崩铁|星穹铁道|绝区零|zzz|鸣潮|蔚蓝档案|ba|nikke|fgo|保底|大保底|小保底|歪了|沉船|出金|双黄|十连|单抽|欧皇|非酋|氪金|月卡|首充)/gi },
  { name: 'B站视频冲浪', re: /(b站|bilibili|哔哩|刷视频|up主|弹幕|评论区|热评|神评|字幕|番剧|二次元|动画|鬼畜|整活|抽象|贴吧|老哥|小黑盒|盒友|知乎|微博|小红书|抖音|吃瓜)/gi },
  { name: '情绪低落', re: /(难受|难过|伤心|委屈|想哭|哭了|掉小珍珠|破防|抑郁|emo|沮丧|失落|绝望|心累|烦死|崩溃|倒霉|叹气|孤单|压力大|顶不住|扛不住)/gi },
  { name: '愤怒吐槽', re: /(生气|气死|火大|暴躁|红温|怒了|傻逼|逆天|离谱|招笑|闹麻了|唐完了|气笑了|服了|无语|坑死|冤种|背刺|恶心|垃圾|烂透了)/gi },
  { name: '开心得意', re: /(开心|高兴|爽|舒服|太棒了|牛逼|nb|起飞|稳了|搞定|成功|通关|好耶|哈哈|笑死|乐|惊喜|走运|赚麻了)/gi },
  { name: '疲惫睡眠', re: /(累|困|好困|想睡|睡觉|睡了|晚安|熬夜|通宵|修仙|失眠|早起|起不来|打哈欠|犯困|摸鱼|摆烂|躺平|歇会儿)/gi },
  { name: '工作学业', re: /(上班|下班|加班|打工|牛马|老板|领导|同事|开会|周报|项目|出差|工资|发薪|辞职|裁员|面试|找工作|offer|上学|上课|考试|挂科|考研|论文|作业|毕业|放假|周末)/gi },
  { name: '美食干饭', re: /(吃|吃饭|干饭|饿|好饿|肚子饿|早饭|午饭|晚饭|夜宵|外卖|食堂|做饭|烧烤|火锅|奶茶|咖啡|炸鸡|麦当劳|疯狂星期四|kfc|汉堡|面条|米饭|小鱼干|零食|减肥|减脂|难吃|好吃)/gi },
  { name: '健康医疗', re: /(生病|发烧|感冒|阳了|咳嗽|嗓子疼|头疼|胃疼|拉肚子|发炎|过敏|医院|挂号|看病|吃药|打针|体检|熬夜伤身|保重)/gi },
  { name: '财务消费', re: /(钱|块钱|人民币|美元|预算|存款|余额|钱包|穷|吃土|破产|花钱|买单|剁手|网购|淘宝|京东|快递|退货|报销|理财|股票|基金|亏麻了)/gi },
  { name: '宠物猫狗', re: /(猫|猫咪|小猫|喵|主子|吸猫|撸猫|猫粮|铲屎|狗|小狗|修勾|汪|遛狗|宠物|咬断|抓坏)/gi },
  { name: '天气出行', re: /(天气|下雨|暴雨|台风|下雪|降温|加衣服|冷死|热死|空调|暖气|出门|堵车|地铁|公交|高铁|飞机|旅游|出差|搬家|租房|房东|驾照|开车)/gi },
  { name: '约定待办', re: /(记得|提醒|别忘了|答应|约定|说好了|下次|明天|周末|待办|计划|打算|准备|目标|flag)/gi },
  { name: '空间语音社交', re: /(说说|qq空间|发空间|动态|点赞|朋友圈|传话|带话|转告|提醒他|私聊|群聊|加好友|拉群)/gi },
  { name: '运维监控', re: /(重启|日志|查看日志|status|状态|监控|负载|占用|卡死|oom|爆内存|进程|杀进程|守护|定时任务|cron)/gi },
  { name: '办公文档', re: /(文档|word|docx|表格|excel|xlsx|ppt|pptx|pdf|汇报|材料|模板|排版|总结|笔记|转换)/gi },
  { name: '外设屏幕', re: /(显示器|屏幕|2k|4k|高刷|144hz|键盘|鼠标|机械键盘|磁轴|耳机|麦克风|声卡|手柄|摄像头|充电器|数据线|线材)/gi },
  { name: '摄影图像', re: /(照片|拍照|摄影|相机|镜头|修图|壁纸|插画|立绘|头像|表情包|gif|动图|截图|录屏|分辨率|画质)/gi },
  { name: '音乐影视', re: /(歌|音乐|听歌|歌单|网易云|qq音乐|apple\s*music|演唱会|电影|电视剧|追剧|综艺|动漫|新番|剧透)/gi },
  { name: '生日纪念', re: /(生日|几号|几月|出生|岁数|星座|纪念日|过年|春节|除夕|中秋|国庆|元旦|圣诞|情人节|礼物|祝福)/gi },
  { name: '运动健身', re: /(运动|健身|跑步|撸铁|深蹲|俯卧撑|游泳|打球|篮球|羽毛球|体重|瘦了|胖了|体重秤|腹肌)/gi },
  { name: '梦境作息', re: /(做梦|梦见|噩梦|睡不着|赖床|闹钟|午睡|回笼觉|生物钟|倒时差|打呼噜|落枕)/gi },
  { name: '网购物流', re: /(拼多多|闲鱼|二手|包邮|发货|物流|驿站|取件码|拆快递|差评|客服|保修|售后|踩雷|种草|拔草)/gi },
  { name: '人际八卦', re: /(对象|男朋友|女朋友|脱单|恋爱|表白|暧昧|相亲|分手|前任|狗粮|结婚|室友|同学|损友|内鬼|放鸽子)/gi },
  { name: '玄学运势', re: /(塔罗|占卜|抽牌|正位|逆位|求签|运势|黄历|水逆|锦鲤|转运|八字|算命|玄学|毒奶)/gi },
  { name: '家务生活', re: /(洗衣服|打扫|收拾|做卫生|扔垃圾|停电|停水|断网|物业|邻居|装修|家电|洗衣机|冰箱|热水器|扫地机)/gi },
]

const MOOD_PATTERNS = {
  sad: /(难受|难过|伤心|委屈|哭|破防|抑郁|emo|崩溃|心累|倒霉|失眠|生病|发烧|挂科|沉船|歪了)/i,
  joy: /(开心|爽|搞定|成功|起飞|稳了|出金|双黄|好耶|舒服|赚麻)/i,
  rant: /(服了|离谱|逆天|招笑|闹麻了|唐完了|气笑了|坑死|冤种|红温|报错|又崩了|难吃)/i,
  tech: /(docker|nas|飞牛|显卡|gpu|5090|电源|代码|脚本|模型|api|token|模拟器|adb|端口|固态|硬盘)/i,
  game: /(方舟|森空岛|终末地|开黑|上号|抽卡|steam|lol|原神|星铁|鸣潮|大祥)/i,
}
const SUSPENSE_RE = /(记得|别忘|答应|约定|下次|改天|回头|等会儿|明天要|准备去|打算|还没修好|还没解决)/i

function detectMoodAndSuspense(text = '') {
  const s = String(text || '')
  let mood = 'neutral'
  for (const [k, re] of Object.entries(MOOD_PATTERNS)) {
    if (re.test(s)) { mood = k; break }
  }
  const suspense = SUSPENSE_RE.test(s)
  return { mood, suspense }
}

/**
 * 计算 128 维本地语义 Embedding 向量（前 36 维同义词簇正交锚点 + 后 92 维 2~3 字词元随机投影 + L2 归一化）
 */
export function computeLocalEmbedding(text = '') {
  const raw = String(text || '').trim().toLowerCase()
  const vec = new Float32Array(EMBED_DIM)
  if (!raw) return Array.from(vec)

  // 1. 前 36 维：语义同义词簇正交激活
  for (let i = 0; i < SEMANTIC_CLUSTERS.length && i < 36; i++) {
    const matches = raw.match(SEMANTIC_CLUSTERS[i].re)
    if (matches && matches.length) {
      vec[i] = Math.min(7.5, 3.8 + (matches.length - 1) * 1.2)
    }
  }

  // 2. 提取概念词与 2~3 字中文 N-gram / 英文词元（剔除单字噪声防碰撞），投影到 36..127 维
  const clean = raw.replace(/[^\u4e00-\u9fa5a-z0-9]/g, ' ')
  const features = []
  for (const tok of extractConcepts(raw, 12)) {
    features.push({ t: tok, w: 0.75 })
  }
  for (const seg of clean.split(/\s+/)) {
    if (!seg) continue
    if (/^[a-z0-9]+$/.test(seg)) {
      if (seg.length >= 2) features.push({ t: seg, w: 0.65 })
      continue
    }
    for (let i = 0; i < seg.length; i++) {
      if (i + 1 < seg.length) {
        const bg = seg.slice(i, i + 2)
        if (!STOP_TOKENS.has(bg) && !STOP_CHARS.has(bg[0])) features.push({ t: bg, w: 0.45 })
      }
      if (i + 2 < seg.length) {
        const tg = seg.slice(i, i + 3)
        if (!STOP_CHARS.has(tg[0])) features.push({ t: tg, w: 0.55 })
      }
    }
  }

  const bucketSpan = EMBED_DIM - 36
  for (const { t, w } of features) {
    let h1 = 2166136261
    let h2 = 16777619
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 16777619)
      h2 = Math.imul(h2 ^ (c * 31), 2166136261)
    }
    const idx1 = 36 + ((h1 >>> 0) % bucketSpan)
    const sign1 = (h1 & 1) === 0 ? 1 : -1
    vec[idx1] += sign1 * w

    const idx2 = 36 + ((h2 >>> 0) % bucketSpan)
    const sign2 = (h2 & 1) === 0 ? 1 : -1
    vec[idx2] += sign2 * (w * 0.35)
  }

  // 3. L2 归一化
  let normSq = 0
  for (let i = 0; i < EMBED_DIM; i++) normSq += vec[i] * vec[i]
  if (normSq > 1e-8) {
    const inv = 1 / Math.sqrt(normSq)
    for (let i = 0; i < EMBED_DIM; i++) {
      vec[i] = Math.round(vec[i] * inv * 10000) / 10000
    }
  }
  return Array.from(vec)
}

/**
 * 计算两个向量的余弦相似度
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || !vecA.length || vecA.length !== vecB.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < vecA.length; i++) {
    const a = Number(vecA[i]) || 0
    const b = Number(vecB[i]) || 0
    dot += a * b
    na += a * a
    nb += b * b
  }
  if (na <= 1e-9 || nb <= 1e-9) return 0
  return dot / Math.sqrt(na * nb)
}

/**
 * 识别两个文本在哪些语义同义簇上发生了跨词面共振
 */
export function explainSemanticResonance(queryText = '', targetText = '') {
  const q = String(queryText || '').toLowerCase()
  const t = String(targetText || '').toLowerCase()
  const shared = []
  for (const c of SEMANTIC_CLUSTERS) {
    const qm = q.match(c.re)
    const tm = t.match(c.re)
    if (qm && tm) {
      const qw = qm[0]
      const tw = tm[0]
      shared.push(qw === tw ? `${c.name}(${qw})` : `${c.name}(${qw}≈${tw})`)
    }
  }
  return shared.slice(0, 2)
}

/**
 * 保持与本地语义空间一致，避免将异构 1024 维向量直接模折叠覆盖本地正交空间
 */
export async function fetchRemoteEmbedding(text,options={}) {
  const clean=String(text||'').trim();if(!clean)return null
  const cfg=embeddingConfig(options.settings)
  if(!cfg.enabled)return null
  if(!cfg.remote)return computeLocalEmbedding(clean)
  const [vector]=await requestEmbeddings(cfg,[clean],options.fetch)
  return vector
}
export async function prepareTreeQuery(query,root,ctx={}){
  const g=loadGraph(root)
  const candidates=Object.values(g.nodes).filter(n=>['fact','scene','episode'].includes(n.type)&&visibleIn(n,ctx)).sort((a,b)=>b.at-a.at).map(n=>({id:n.id,text:n.label}))
  let timer
  try{return await Promise.race([prepareRemoteRecall(root,String(query||''),candidates),new Promise(resolve=>{timer=setTimeout(()=>resolve({engine:'local',pending:true}),3000)})])}finally{clearTimeout(timer)}
}

// ---------------------------------------------------------------------------
// 图存储与二进制向量分家（tree.json + tree-vec.bin）
// ---------------------------------------------------------------------------

const graphs = new Map()      // root -> graph
const vecStores = new Map()   // root -> Map<nodeId, number[]>
const vecSaveTimers = new Map()

function treePath(root) {
  return join(root, 'tree.json')
}

function vecBinPath(root) {
  return join(root, 'tree-vec.bin')
}

function emptyGraph() {
  return { v: 3.3, updatedAt: 0, bootstrapped: false, nodes: {}, edges: {} }
}

function getVecMap(root) {
  if (!vecStores.has(root)) vecStores.set(root, new Map())
  return vecStores.get(root)
}

function getNodeVec(root, n) {
  if (!n || !n.id) return null
  const vmap = getVecMap(root)
  if (vmap.has(n.id)) return vmap.get(n.id)
  if (Array.isArray(n.vec) && n.vec.length === EMBED_DIM) {
    vmap.set(n.id, n.vec)
    delete n.vec
    n.hasVec = true
    return vmap.get(n.id)
  }
  if (n.label && (n.type === 'episode' || n.type === 'fact' || n.type === 'scene' || n.type === 'concept')) {
    const v = computeLocalEmbedding(n.label)
    vmap.set(n.id, v)
    n.hasVec = true
    return v
  }
  return null
}

/**
 * 将内存中的向量以紧凑 Int8 量化二进制格式写入 tree-vec.bin（每个向量固定 128 B，与 tree.json 分离）
 */
function writeVecBinNow(root, g) {
  try {
    mkdirSync(dirname(vecBinPath(root)), { recursive: true })
    const vmap = getVecMap(root)
    const aliveIds = Object.keys(g.nodes).filter((id) => vmap.has(id))
    const chunks = []
    const header = Buffer.alloc(8)
    header.write('DSHV', 0, 4, 'ascii')
    header.writeUInt32LE(aliveIds.length, 4)
    chunks.push(header)
    for (const id of aliveIds) {
      const idBuf = Buffer.from(String(id), 'utf8').subarray(0, 64)
      const rec = Buffer.alloc(1 + idBuf.length + EMBED_DIM)
      rec[0] = idBuf.length
      idBuf.copy(rec, 1)
      const vec = vmap.get(id)
      const offset = 1 + idBuf.length
      for (let i = 0; i < EMBED_DIM; i++) {
        const clamped = Math.max(-1, Math.min(1, Number(vec[i]) || 0))
        rec.writeInt8(Math.round(clamped * 127), offset + i)
      }
      chunks.push(rec)
    }
    writeFileSync(vecBinPath(root), Buffer.concat(chunks))
  } catch {}
}

function loadGraph(root) {
  if (graphs.has(root)) return graphs.get(root)
  const raw = readJson(treePath(root), null)
  const g = raw && raw.nodes && raw.edges ? { ...emptyGraph(), ...raw } : emptyGraph()
  const vmap = getVecMap(root)
  // 迁移剥离旧版残留在 tree.json 里的 vec 数组，瘦身 JSON 体积
  for (const n of Object.values(g.nodes)) {
    if (Array.isArray(n.vec)) {
      if (n.vec.length === EMBED_DIM) vmap.set(n.id, n.vec)
      delete n.vec
      n.hasVec = true
    } else if (n.type === 'episode' || n.type === 'fact' || n.type === 'scene' || n.type === 'concept') {
      n.hasVec = true
    }
  }
  graphs.set(root, g)
  sanitizeGraph(g, root)
  return g
}

function scheduleSave(root, g) {
  g.updatedAt = Date.now()
  const nodeList = Object.values(g.nodes)
  const epCount = nodeList.filter((n) => n.type === 'episode').length
  if (nodeList.length > MAX_NODES || epCount > MAX_EPISODES) {
    prune(g, root)
  }
  writeJsonSoon(treePath(root), g, 800)
  if (!vecSaveTimers.has(root)) {
    const t = setTimeout(() => {
      vecSaveTimers.delete(root)
      writeVecBinNow(root, g)
    }, 900)
    t.unref?.()
    vecSaveTimers.set(root, t)
  }
}

function edgeKey(a, b) {
  return a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`
}

function ensureNode(g, id, type, label, computeVec = false, root = '') {
  let n = g.nodes[id]
  if (!n) {
    const cleanLabel = String(label || '').slice(0, 120)
    n = {
      id,
      type,
      label: cleanLabel,
      w: 1,
      hits: 0,
      at: Date.now(),
      extra: {},
    }
    if (computeVec && cleanLabel) {
      n.hasVec = true
      if (root) getVecMap(root).set(id, computeLocalEmbedding(cleanLabel))
    }
    g.nodes[id] = n
  } else {
    if (label && !n.label) n.label = String(label).slice(0, 120)
    if (computeVec && n.label) {
      n.hasVec = true
      if (root && !getVecMap(root).has(id)) {
        getVecMap(root).set(id, computeLocalEmbedding(n.label))
      }
    }
  }
  n.at = Date.now()
  return n
}

function bumpEdge(g, a, b, delta = 1, kind = 'assoc') {
  if (!a || !b || a === b) return
  if (!g.nodes[a] || !g.nodes[b]) return
  const k = edgeKey(a, b)
  const e = g.edges[k] || { a, b, w: 0, kind, at: Date.now() }
  e.w = Number((e.w + delta).toFixed(2))
  e.at = Date.now()
  if (delta > 0) e.kind = kind
  g.edges[k] = e
}

/**
 * 艾宾浩斯遗忘曲线留存强度计算（Ebbinghaus Retention Strength）：
 * Strength = (w + ln(1 + hits) * 2.5) * exp(-ageDays / halfLife)
 */
export function nodeRetentionStrength(n, now = Date.now()) {
  const ts = Number(n?.extra?.ts || n?.at || now)
  const ageDays = Math.max(0, (now - ts) / 86_400_000)
  const halfLife = n?.type === 'fact' ? 90 : n?.type === 'scene' ? 30 : 14
  const decay = Math.exp(-ageDays / halfLife)
  const base = (Number(n?.w) || 1) + Math.log1p(Number(n?.hits) || 0) * 2.5
  return base * decay
}

/**
 * 按遗忘曲线留存强度 + 时间新近度淘汰超限节点（彻底修复“删最新留最旧” bug）
 */
function prune(g, root = '') {
  const now = Date.now()
  const vmap = root ? getVecMap(root) : null
  const cmpKeepFirst = (a, b) => {
    const diff = nodeRetentionStrength(b, now) - nodeRetentionStrength(a, now)
    if (Math.abs(diff) > 1e-6) return diff
    const tsB = Number(b?.extra?.ts || b?.at || 0)
    const tsA = Number(a?.extra?.ts || a?.at || 0)
    return tsB - tsA
  }

  const allNodes = Object.values(g.nodes)
  const episodes = allNodes.filter((n) => n.type === 'episode').sort(cmpKeepFirst)
  if (episodes.length > MAX_EPISODES) {
    for (const n of episodes.slice(MAX_EPISODES)) {
      delete g.nodes[n.id]
      vmap?.delete(n.id)
    }
  }

  const scenes = Object.values(g.nodes).filter((n) => n.type === 'scene').sort(cmpKeepFirst)
  if (scenes.length > MAX_SCENES) {
    for (const n of scenes.slice(MAX_SCENES)) {
      delete g.nodes[n.id]
      vmap?.delete(n.id)
    }
  }

  const rest = Object.values(g.nodes).sort((a, b) => -cmpKeepFirst(a, b))
  let over = Object.keys(g.nodes).length - MAX_NODES
  for (const n of rest) {
    if (over <= 0) break
    if (n.type === 'person' || n.type === 'group') continue
    delete g.nodes[n.id]
    vmap?.delete(n.id)
    over -= 1
  }

  const alive = new Set(Object.keys(g.nodes))
  for (const [k, e] of Object.entries(g.edges)) {
    if (!alive.has(e.a) || !alive.has(e.b)) delete g.edges[k]
  }
}

/**
 * MaiBot 风格的高纯度概念/主题词抽取（废除会产生半截废话的无脑全句滑窗）：
 * 1) 领域核心词表精确提取；
 * 2) 英文/数字型号专有名词提取（如 5090 / operit / shizuku / docker）；
 * 3) 中文复合名词短语提取（仅提取围绕核心词或特定定语结构的 2~4 字有效名词，严禁切出虚词碎片）。
 */
const MEDIA_TAG_STRIP_RE = /\[(?:图片|表情包|表情|语音|文件|视频|聊天记录)\d*[^\]]*\]|\[\[[\s\S]*?\]\]|（（[\s\S]*?））/g
const BAD_CONCEPT_RE = /^(表情|图片|语音|文件|视频|消息|群友|好友|机器人|主人|自己|感觉|觉得|认为|应该|可能|或者|然后|所以|因为|如果|虽然|但是|这个|那个|什么|怎么|为什么|多少|几个|一下|一点|一些|今天|明天|昨天|现在|刚才|最近|以前|以后|时候|地方|东西|事情|问题|结果|原因|开始|结束|出来|进去|起来|下去|知道|看到|听到|说话|聊天)$/i

export function extractConcepts(text, max = 8) {
  const cleaned = String(text || '').replace(MEDIA_TAG_STRIP_RE, ' ').trim()
  if (!cleaned) return []
  const found = []
  const seen = new Set()
  const push = (t) => {
    const v = String(t || '').trim().toLowerCase()
    if (!v || (v.length < 2 && !SINGLE_CONCEPT_OK.has(v)) || v.length > 18 || seen.has(v)) return
    if (STOP_TOKENS.has(v) || STOP_CHARS.has(v) || BAD_CONCEPT_RE.test(v)) return
    if (/^\d+$/.test(v)) return // 纯数字不当概念（除非带型号后缀如 5090w/850w）
    seen.add(v)
    found.push(v)
  }

  for (const m of cleaned.match(CONCEPT_RE) || []) push(m)
  for (const m of cleaned.match(/[a-zA-Z][a-zA-Z0-9_+#.-]{1,16}|\d{3,4}[wW]|[45]0[6789]0(?:ti|super)?/g) || []) push(m)

  // 提取定中结构末尾或常见介词/时间词后的 2~3 字独立实词（如“好吃的牛肉粒”->“牛肉粒”，“把发票弄丢”->“发票”，“下周三面试”->“面试”）
  const structMatches = cleaned.matchAll(/(?:的|把|被|去|回|找|买|卖|吃|喝|玩|看|写|做|考|等|有|没|很|好|真|太|周[一二三四五六日天]|明天|昨天|今天|过年)([\u4e00-\u9fa5]{2,3})/g)
  for (const m of structMatches) {
    const w = m[1].replace(/[了着过吗呢吧啊呀哦嗯]+$/, '')
    if (w.length >= 2 && !STOP_CHARS.has(w[0]) && !STOP_SUFFIX_CHARS.has(w[w.length - 1])) {
      push(w)
    }
  }

  // 若整句本身就是 2~4 字的短名词查询（如用户在搜索框搜“牛肉粒”），直接作为概念保留
  const pureCjk = cleaned.replace(/[^\u4e00-\u9fa5]/g, '').trim()
  if (found.length === 0 && pureCjk.length >= 2 && pureCjk.length <= 4) {
    if (!STOP_CHARS.has(pureCjk[0]) && !STOP_SUFFIX_CHARS.has(pureCjk[pureCjk.length - 1])) {
      push(pureCjk)
    }
  }

  return found.slice(0, max)
}

/**
 * 信息熵门控（借鉴 MaiBot 海马体过滤机制）：判断一句话是否具备长期记忆价值
 */
export function computeInformationScore(rawText = '') {
  const clean = String(rawText || '').replace(MEDIA_TAG_STRIP_RE, '').trim()
  if (!clean || clean.length < 4) return 0
  if (NOISE_RE.test(clean) || LAUGH_RE.test(clean) || LOW_ENTROPY_RE.test(clean)) return 0
  // 过滤纯语气重复（如“啊啊啊啊啊太强了”“嗯嗯好的收到”）
  const dedupChars = clean.replace(/(.)\1{2,}/g, '$1')
  if (LOW_ENTROPY_RE.test(dedupChars)) return 0
  const concepts = extractConcepts(clean, 6)
  if (concepts.length === 0 && dedupChars.length <= 7) return Number((dedupChars.length / 18).toFixed(2))
  let score = Math.min(1.5, dedupChars.length / 16) + concepts.length * 0.68
  if (RELATION_FACT_RE.test(clean)) score += 0.85
  if (SUSPENSE_RE.test(clean)) score += 0.75
  const { mood } = detectMoodAndSuspense(clean)
  if (mood !== 'neutral') score += 0.45
  return Number(score.toFixed(2))
}

/**
 * 读取通讯录与群印象，建立权威的群 ID 集合与名称字典，彻底根治“私聊QQ号被当成群、群号被当成人”的张冠李戴
 */
function loadIdentityHints(root) {
  const groups = new Map() // groupId -> groupName
  const users = new Map()  // userId -> userName
  try {
    const cFile = join(root, 'contacts.json')
    if (existsSync(cFile)) {
      const c = readJson(cFile, {})
      for (const [gid, ginfo] of Object.entries(c.groups || {})) {
        groups.set(String(gid), String(ginfo?.name || `群${gid}`))
      }
      for (const [uid, uinfo] of Object.entries(c.users || {})) {
        users.set(String(uid), String(uinfo?.name || uinfo?.remark || uid))
      }
    }
    const pDir = join(root, 'people')
    if (existsSync(pDir)) {
      for (const f of readdirSync(pDir)) {
        if (!f.endsWith('.md')) continue
        const head = readFileSync(join(pDir, f), 'utf8').slice(0, 200)
        const tm = head.match(/^#\s+([^\n（(]+)/m)
        const cleanTitle = tm ? tm[1].replace(/^(?:群聊印象|好友印象)[:：]\s*/, '').trim() : ''
        if (f.startsWith('group_')) {
          const gid = f.slice(6, -3)
          if (cleanTitle || !groups.has(gid)) groups.set(gid, cleanTitle || groups.get(gid) || `群${gid}`)
        } else {
          const uid = f.slice(0, -3)
          if (cleanTitle && !users.has(uid)) users.set(uid, cleanTitle)
        }
      }
    }
  } catch {}
  return { groups, users }
}

/**
 * 自动净化历史图谱中的异常脏节点（如 g:global、私聊变群 g:<userId>、群变人 p:<groupId>、无意义 c:表情）
 */
export function sanitizeGraph(g, root = '') {
  if (!g || !g.nodes) return 0
  const { groups, users } = root ? loadIdentityHints(root) : { groups: new Map(), users: new Map() }
  const vmap = root ? getVecMap(root) : null
  let removed = 0

  for (const [id, n] of Object.entries(g.nodes)) {
    const rawId = id.slice(2)
    // 1. 删除 g:global / p:global / p:bot / p:webui
    if (rawId === 'global' || rawId === 'bot' || rawId === 'webui') {
      delete g.nodes[id]; vmap?.delete(id); removed += 1; continue
    }
    // 2. 修复把私聊好友错建成 group 的节点 (g:<uid>)
    if (n.type === 'group' && (users.has(rawId) || g.nodes[`p:${rawId}`]) && !groups.has(rawId)) {
      delete g.nodes[id]; vmap?.delete(id); removed += 1; continue
    }
    // 3. 修复把群号错建成 person 的节点 (p:<gid>)
    if (n.type === 'person' && (groups.has(rawId) && !users.has(rawId))) {
      const gNode = ensureNode(g, `g:${rawId}`, 'group', groups.get(rawId) || n.label || `群${rawId}`, false, root)
      gNode.w = Math.max(gNode.w, n.w || 1)
      delete g.nodes[id]; vmap?.delete(id); removed += 1; continue
    }
    // 4. 用真实群名更新死板的“群30008”标签
    if (n.type === 'group' && groups.has(rawId) && (!n.label || /^群\d+$/.test(n.label))) {
      n.label = groups.get(rawId)
    }
    // 5. 清理被拉黑的废话概念节点（如 c:表情、c:图片）
    if (n.type === 'concept' && (BAD_CONCEPT_RE.test(n.label || '') || STOP_TOKENS.has(n.label || ''))) {
      delete g.nodes[id]; vmap?.delete(id); removed += 1; continue
    }
  }

  if (removed > 0) {
    const alive = new Set(Object.keys(g.nodes))
    for (const [k, e] of Object.entries(g.edges)) {
      if (!alive.has(e.a) || !alive.has(e.b)) delete g.edges[k]
    }
  }
  return removed
}

function hashId(prefix, text) {
  let h = 2166136261
  const s = String(text)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${prefix}:${(h >>> 0).toString(36)}`
}

/**
 * 吃进一条聊天记录，自动长树（构建 person / group / concept / episode 并按 30 分钟窗口归并进 scene 情景层）。
 */
export function ingestChat(row, root, opts = {}) {
  if (!root || !row) return null
  const text = String(row.text || '').split(' " ')[0].trim()
  if (!text || NOISE_RE.test(text) || LAUGH_RE.test(text)) return null
  if (text === '已添加好友，随时开聊') return null

  const g = opts.graph || loadGraph(root)
  const chatId = String(row.chat || '').trim()
  const uid = String(row.id || '').trim()
  const ts = Number(row.ts) || Date.now()
  const { groups, users } = loadIdentityHints(root)

  // 严格判定群聊：显式 kind==='group'，或 chatId 在已知群列表中；绝不因为 assistant 回复 (uid='bot') 把私聊误判成群！
  const isGroup = row.kind === 'group' ||
    (row.kind !== 'private' && chatId && chatId !== 'global' && (
      groups.has(chatId) ||
      (uid && uid !== 'bot' && row.role !== 'assistant' && chatId !== uid && !users.has(chatId))
    ))
  const concepts = extractConcepts(text, 6)

  const touched = []
  if (uid && uid !== 'bot' && uid !== 'global' && row.role !== 'assistant' && !groups.has(uid)) {
    const personName = row.name || users.get(uid) || uid
    const p = ensureNode(g, `p:${row.platform&&row.platform!=='qq'?row.platform+':':''}${uid}`, 'person', personName, false, root)
    p.w += 1
    if (personName && personName !== uid) p.label = String(personName).slice(0, 60)
    p.extra.name = personName
    touched.push(p.id)
  }
  if (isGroup && chatId && chatId !== 'global') {
    const groupLabel = row.groupName || groups.get(chatId) || `群${chatId}`
    const grp = ensureNode(g, `g:${row.platform&&row.platform!=='qq'?row.platform+':':''}${chatId}`, 'group', groupLabel, false, root)
    if (groupLabel && !/^群\d+$/.test(groupLabel)) grp.label = groupLabel
    grp.w += 1
    touched.push(grp.id)
  }

  const conceptIds = []
  for (const c of concepts) {
    const n = ensureNode(g, `c:${c}`, 'concept', c, true, root)
    n.w += 1
    conceptIds.push(n.id)
  }

  for (const cid of conceptIds) {
    for (const t of touched) bumpEdge(g, t, cid, 1, 'mentions')
  }
  for (let i = 0; i < conceptIds.length; i++) {
    for (let j = i + 1; j < conceptIds.length; j++) bumpEdge(g, conceptIds[i], conceptIds[j], 0.6, 'co-occur')
  }

  // MaiBot 海马体信息熵门控：过滤低信息量口水话，同时保留有概念或高信息分的日常对话
  const cleanText = text.replace(MEDIA_TAG_STRIP_RE, '').trim()
  const infoScore = computeInformationScore(cleanText)
  const meaningful = cleanText.length >= 5 && (conceptIds.length >= 1 || infoScore >= 1.15) && infoScore >= 0.82
  let epId = null
  let sceneId = null
  if (meaningful) {
    const slot = Math.floor(ts / SCENE_WINDOW_MS)
    sceneId = (chatId && chatId !== 'global') ? `s:${row.scope||conversationKey({...row,chatId})}:${slot}` : null
    epId = hashId('e', `${row.scope||conversationKey({...row,chatId})}|${row.ts||''}|${cleanText.slice(0,40)}`)
    const speakerPrefix = (row.role !== 'assistant' && (row.name || users.get(uid))) ? `${row.name || users.get(uid)}: ` : ''
    const ep = ensureNode(g, epId, 'episode', `${speakerPrefix}${cleanText}`.slice(0, 110), true, root)
    ep.w = Number((ep.w + Math.min(2.2, infoScore * 0.5)).toFixed(2))
    const { mood, suspense } = detectMoodAndSuspense(cleanText)
    ep.extra = {
      chat: chatId, scope:row.scope || conversationKey({...row,chatId}), platform:row.platform||'qq',
      kind: isGroup ? 'group' : 'private',
      fullText:cleanText,sourceMessageIds:[String(row.messageId||`${chatId}:${ts}`)],
      role: row.role || 'user',
      name: row.name || users.get(uid) || '',
      uid,
      mood,
      suspense,
      ts,
      ...(sceneId ? { sceneId } : {}),
    }
    if (suspense) ep.w += 0.6
    for (const cid of conceptIds) bumpEdge(g, ep.id, cid, 1.2, 'about')
    for (const t of touched) bumpEdge(g, ep.id, t, 1, 'by')

    // 若发言包含明显的长期事实/个人进展/偏好（MaiBot A_Memorix 关系三元组抽取），自动沉淀为结构化 fact（绑定 sceneId 以便同源去重）
    if (row.role !== 'assistant' && uid && RELATION_FACT_RE.test(cleanText) && infoScore >= 1.65 && cleanText.length >= 8 && cleanText.length <= 75) {
      const speakerLabel = row.name || users.get(uid) || uid
      const autoFact = rememberFact(uid, `${speakerLabel}：${cleanText}`, root, {
        graph: g,
        name: speakerLabel,
        chat: chatId, scope:row.scope || conversationKey({...row,chatId}), platform:row.platform||'qq',
        kind: isGroup ? 'group' : 'private',
        source: 'auto_relation',sourceMessageIds:[String(row.messageId||`${chatId}:${ts}`)],
        ts,
        deferSave: true,
      })
      if (autoFact?.id && sceneId && g.nodes[autoFact.id]) {
        g.nodes[autoFact.id].extra.sceneId = sceneId
      }
    }

    // 情景层（scene）：将同会话 30 分钟窗口内的连续事件归并为一个有主题摘要的情景单元（保留 consolidated 状态并在新增内容时标记 dirtyAfterConsolidate）
    if (sceneId) {
      const sc = ensureNode(g, sceneId, 'scene', cleanText.slice(0, 110), false, root)
      const prevExtra = sc.extra || {}
      const epList = Array.isArray(prevExtra.episodeIds) ? prevExtra.episodeIds.slice() : []
      const isNewEp = !epList.includes(epId)
      if (isNewEp) epList.push(epId)
      const snippets = Array.isArray(prevExtra.snippets) ? prevExtra.snippets.slice() : []
      const topicSet = new Set(Array.isArray(prevExtra.topics) ? prevExtra.topics : [])
      for (const c of concepts.slice(0, 3)) topicSet.add(c)
      const topics = [...topicSet].slice(0, 6)
      const shortLine = `${row.name || users.get(uid) || '群友'}:${cleanText.slice(0, 32)}`
      if (snippets.length < 6 && !snippets.includes(shortLine)) snippets.push(shortLine)
      const topicHeader = topics.length ? `【${topics.slice(0, 3).join('/')}】` : ''
      sc.label = `${topicHeader}${snippets.join(' · ')}`.slice(0, 130) || cleanText.slice(0, 110)
      sc.w = Math.min(8, 1 + epList.length * 0.6)
      sc.hasVec = true
      getVecMap(root).set(sceneId, computeLocalEmbedding(sc.label))
      sc.extra = {
        ...prevExtra,
        chat: chatId, scope:row.scope || conversationKey({...row,chatId}), platform:row.platform||'qq',
        kind: isGroup ? 'group' : 'private',
        episodeIds: epList.slice(-12),
        snippets,
        topics,
        mood: mood !== 'neutral' ? mood : (prevExtra.mood || 'neutral'),
        ts,
        ...(prevExtra.consolidated && isNewEp ? { dirtyAfterConsolidate: true } : {}),
      }
      bumpEdge(g, ep.id, sc.id, 1.4, 'part_of')
      for (const cid of conceptIds.slice(0, 4)) bumpEdge(g, sc.id, cid, 0.9, 'scene_topic')
      for (const t of touched) bumpEdge(g, sc.id, t, 0.8, 'participant')
    }
  }

  if (!opts.deferSave) scheduleSave(root, g)
  return { concepts, episode: epId, scene: sceneId }
}

/** 显式记一条事实（工具 remember 调用；或夜间巩固/人物印象提炼生成） */
export function rememberFact(subject, fact, root, opts = {}) {
  const text = String(fact || '').trim()
  if (!text || !root) return null
  const g = opts.graph || loadGraph(root)
  const who = String(subject || '').trim()
  const combinedText = who ? `${who}：${text}` : text
  const concepts = extractConcepts(`${who} ${text}`, 6)
  const id = hashId('f', `${opts.scope || opts.chat || 'legacy'}|${who}|${text}`)
  const n = ensureNode(g, id, 'fact', text.slice(0, 140), false, root)
  n.hasVec = true
  getVecMap(root).set(id, computeLocalEmbedding(combinedText))
  n.w += 2
  n.hits += 1
  const chatStr = String(opts.chat || '')
  const inferredKind = opts.kind || (chatStr && who && chatStr !== who ? 'group' : 'private')
  const { mood, suspense } = detectMoodAndSuspense(text)
  n.extra = {
    subject: who,fullText:text,sourceMessageIds:[...new Set([...(n.extra?.sourceMessageIds||[]),...(opts.sourceMessageIds||[])])],
    chat: chatStr, scope:opts.scope || (chatStr ? conversationKey({kind:inferredKind,chatId:chatStr,platform:opts.platform}) : ''), platform:opts.platform||'qq',
    kind: inferredKind,
    mood,
    suspense,
    ts: Number(opts.ts) || Date.now(),
    source: opts.source || 'explicit',
    ...(Array.isArray(opts.derived_from) ? { derived_from: opts.derived_from } : {}),
  }
  for (const c of concepts) {
    const cn = ensureNode(g, `c:${c}`, 'concept', c, true, root)
    cn.w += 1
    bumpEdge(g, id, cn.id, 1.5, 'about')
  }
  if (who && who !== 'global' && who !== 'bot') {
    const { groups, users } = loadIdentityHints(root)
    const isGroupTarget = inferredKind === 'group' && (who===chatStr || groups.has(who)&&!users.has(who))
    if (isGroupTarget) {
      const grp = ensureNode(g, `g:${opts.platform&&opts.platform!=='qq'?opts.platform+':':''}${who}`, 'group', opts.name || groups.get(who) || `群${who}`, false, root)
      grp.w += 1
      bumpEdge(g, id, grp.id, 2, 'subject')
    } else {
      const pName = opts.name || users.get(who) || who
      const p = ensureNode(g, `p:${opts.platform&&opts.platform!=='qq'?opts.platform+':':''}${who}`, 'person', pName, false, root)
      if (pName && pName !== who) p.label = String(pName).slice(0, 60)
      p.w += 1
      bumpEdge(g, id, p.id, 2, 'subject')
    }
  }
  if (!opts.deferSave) scheduleSave(root, g)
  return { id, concepts }
}

/**
 * 夜间记忆巩固（Memory Consolidation）：
 * 将包含多条对话的活跃情景（scene）提炼为带 `derived_from` 溯源链的浓缩长期事实（fact），并温和衰减已巩固的零散 episode。
 */
export function consolidateTree(root, opts = {}) {
  if (!root) return { consolidated: 0 }
  const g = loadGraph(root)
  sanitizeGraph(g, root)
  const minIdleMs = Number(opts.minIdleMs || 0)
  const now = Date.now()
  let consolidated = 0
  for (const sc of Object.values(g.nodes)) {
    if (sc.type !== 'scene') continue
    if (sc.extra?.consolidated && !sc.extra?.dirtyAfterConsolidate) continue
    if (minIdleMs > 0 && (now - Number(sc.extra?.ts || sc.at || 0)) < minIdleMs) continue
    const epIds = Array.isArray(sc.extra?.episodeIds) ? sc.extra.episodeIds : []
    if (epIds.length < 2 && (sc.w || 1) < 2.2) continue

    // 提炼结构化浓缩摘要（不再原样复印 sc.label，且若该 scene 已有巩固 factId 则原位增量更新，确保新增如“黑屏”进入同一条 fact）
    const snippets = Array.isArray(sc.extra?.snippets) ? sc.extra.snippets : []
    const topics = Array.isArray(sc.extra?.topics) ? sc.extra.topics : extractConcepts(sc.label, 4)
    const cleanPoints = snippets
      .map((s) => String(s || '').replace(/^[^:：]+[:：]\s*/, '').trim())
      .filter(Boolean)
    const summaryBody = cleanPoints.length >= 2
      ? `${cleanPoints[0]}；后续：${cleanPoints.slice(1).join('，')}`
      : String(sc.label || '').replace(/^【[^】]+】/, '').trim()
    const topicTag = topics.length ? `[长期归纳·${topics.slice(0, 3).join('/')}] ` : '[长期归纳] '
    const distilledFact = `${topicTag}${summaryBody}`.slice(0, 140)
    const provenance = [sc.id, ...epIds]

    const existingFactId = sc.extra?.factId
    if (existingFactId && g.nodes[existingFactId]) {
      const fn = g.nodes[existingFactId]
      fn.label = distilledFact
      fn.hasVec = true
      getVecMap(root).set(existingFactId, computeLocalEmbedding(distilledFact))
      fn.derived_from = provenance
      fn.extra = { ...(fn.extra || {}), derived_from: provenance, sceneId: sc.id, ts: sc.extra?.ts || sc.at }
      for (const c of extractConcepts(distilledFact, 6)) {
        const cn = ensureNode(g, `c:${c}`, 'concept', c, true, root)
        bumpEdge(g, existingFactId, cn.id, 1.2, 'about')
      }
      sc.extra.consolidated = true
      sc.extra.dirtyAfterConsolidate = false
      for (const eid of epIds) {
        if (g.nodes[eid]) g.nodes[eid].w = Number(Math.max(0.4, (g.nodes[eid].w || 1) * 0.6).toFixed(2))
      }
      consolidated += 1
      continue
    }

    const factRes = rememberFact(sc.extra?.chat || '', distilledFact, root, {
      graph: g,
      chat: sc.extra?.chat || '',
      kind:sc.extra?.kind||'private',scope:sc.extra?.scope,platform:sc.extra?.platform,
      source: 'consolidated_scene',
      derived_from: provenance,
      ts: sc.extra?.ts || sc.at,
      deferSave: true,
    })
    if (factRes?.id) {
      const fn = g.nodes[factRes.id]
      if (fn) {
        fn.derived_from = provenance
        fn.extra = { ...(fn.extra || {}), derived_from: provenance, sceneId: sc.id }
      }
      bumpEdge(g, factRes.id, sc.id, 1.8, 'derived_from')
      sc.extra.consolidated = true
      sc.extra.dirtyAfterConsolidate = false
      sc.extra.factId = factRes.id
      sc.w = Number(Math.max(0.6, (sc.w || 1) * 0.55).toFixed(2))
      for (const eid of epIds) {
        if (g.nodes[eid]) g.nodes[eid].w = Number(Math.max(0.4, (g.nodes[eid].w || 1) * 0.6).toFixed(2))
      }
      consolidated += 1
    }
  }
  if (consolidated > 0) scheduleSave(root, g)
  return { consolidated }
}

/**
 * 从现有历史记忆文件冷启动构建/重建记忆树（支持 reset:true 幂等重建，避免重复点击累加权重）
 */
export function bootstrapTreeFromHistory(root, opts = {}) {
  if (!root) return { addedChats: 0, addedFacts: 0 }
  const isLegacyGraphArg = opts && opts.nodes && opts.edges
  const reset = !isLegacyGraphArg && opts?.reset === true

  let g = isLegacyGraphArg ? opts : loadGraph(root)
  if (reset) {
    g = emptyGraph()
    graphs.set(root, g)
    getVecMap(root).clear()
  } else if (g.bootstrapped && Object.keys(g.nodes).length > 0 && !isLegacyGraphArg) {
    return { addedChats: 0, addedFacts: 0, skipped: 'already_bootstrapped', stats: treeStats(root) }
  }
  g.bootstrapped = true

  let addedChats = 0
  let addedFacts = 0

  // 1. 回填 chat.jsonl 最近 400 条对话
  const chatFile = join(root, 'chat.jsonl')
  if (existsSync(chatFile)) {
    const rows = readJsonLines(chatFile, 400)
    for (const r of rows) {
      if (r && r.text) {
        const res = ingestChat(r, root, { graph: g, deferSave: true })
        if (res) addedChats += 1
      }
    }
  }

  // 2. 回填 people/*.md 人物与群印象为显式事实节点
  const peopleDir = join(root, 'people')
  if (existsSync(peopleDir)) {
    try {
      for (const fname of readdirSync(peopleDir)) {
        if (!fname.endsWith('.md')) continue
        const raw = readFileSync(join(peopleDir, fname), 'utf8')
        const stem = fname.replace(/\.md$/, '')
        const isGrp = stem.startsWith('group_')
        const subjectId = isGrp ? stem.slice(6) : stem
        const titleMatch = raw.match(/^#\s+([^\n（(]+)/m)
        const subjectName = titleMatch ? titleMatch[1].replace(/群聊印象[:：]\s*/, '').trim() : subjectId
        const bullets = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '))
        for (const b of bullets.slice(0, 8)) {
          const factText = b.replace(/^-\s+/, '').trim()
          if (factText.length >= 6) {
            rememberFact(subjectId, factText, root, {
              graph: g,
              name: subjectName,
              chat: subjectId,
              kind: isGrp ? 'group' : 'private',
              source: 'impression',
              deferSave: true,
            })
            addedFacts += 1
          }
        }
      }
    } catch {}
  }

  // 3. 回填 human-world.md 人间观察信笺（subject 置空，不创建假 person 节点）
  const hwFile = join(root, 'human-world.md')
  if (existsSync(hwFile)) {
    try {
      const lines = readFileSync(hwFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '))
      for (const l of lines.slice(-15)) {
        const clean = l.replace(/^-\s*(\[[^\]]+\])?\s*/, '').trim()
        if (clean.length >= 8) {
          rememberFact('', clean, root, {
            graph: g,
            chat: 'global',
            kind: 'group',
            source: 'human-world',
            deferSave: true,
          })
          addedFacts += 1
        }
      }
    } catch {}
  }

  // 4. 回填 events/*.md 事件碎片（不传假群 chat='global'，避免污染群节点）
  const eventsDir = join(root, 'events')
  if (existsSync(eventsDir)) {
    try {
      for (const fname of readdirSync(eventsDir).sort().slice(-10)) {
        if (!fname.endsWith('.md')) continue
        const lines = readFileSync(join(eventsDir, fname), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '))
        for (const l of lines.slice(-12)) {
          const clean = l.replace(/^-\s*(\d{2}:\d{2}\s*)?/, '').trim()
          if (clean.length >= 8 && computeInformationScore(clean) >= 1.1) {
            rememberFact('', clean, root, {
              graph: g,
              chat: '',
              kind: 'group',
              source: 'event_log',
              deferSave: true,
            })
            addedChats += 1
          }
        }
      }
    } catch {}
  }

  // 5. 自动净化历史异常节点并执行情景巩固
  sanitizeGraph(g, root)
  for (const n of Object.values(g.nodes)) {
    if ((n.type === 'episode' || n.type === 'fact' || n.type === 'scene' || n.type === 'concept') && n.label) {
      getNodeVec(root, n)
    }
  }

  if (addedChats > 0 || addedFacts > 0 || Object.keys(g.nodes).length > 0) {
    scheduleSave(root, g)
  }
  return { addedChats, addedFacts, stats: treeStats(root) }
}

/**
 * 启发式扩散激活召回（纯读不写盘 + 相对分数阈值过滤凑数项）
 */
export function recallFromTree(query, root, opts = {}) {
  if (!root) return []
  const g = loadGraph(root)
  const limit = Math.max(1, Number(opts.limit || 5))
  const mode = String(opts.mode || 'hybrid').trim().toLowerCase() // 'hybrid' | 'search' | 'episode' | 'profile' | 'time'
  const personName = String(opts.personName || opts.person_name || '').trim()
  const rawQuery = String(query || personName || '').trim()
  if (!rawQuery && mode !== 'time') return []

  // 时间模式：直接按时间倒序召回近期重要记忆
  if (mode === 'time' && !rawQuery) {
    return Object.values(g.nodes)
      .filter(n=>['fact','scene','episode'].includes(n.type) && visibleIn(n,opts))
      .sort((a, b) => (Number(b.extra?.ts || b.at || 0) - Number(a.extra?.ts || a.at || 0)))
      .slice(0, limit)
      .map((n) => ({
        id: n.id,
        type: n.type,
        text: n.extra?.fullText||n.label,
        score: Number((n.w || 1).toFixed(2)),
        similarity: 1,
        cue: '近期时间轴',
        mood: n.extra?.mood || 'neutral',
        source: n.type === 'fact' ? '海马体·事实' : n.type === 'scene' ? '海马体·情景' : '海马体·经历',
        when: n.extra?.ts || n.at,
        chat: n.extra?.chat || '',
      }))
  }

  const tokens = extractConcepts(rawQuery, 10)
  const queryVec = computeLocalEmbedding(rawQuery)
  const queryMoodInfo = detectMoodAndSuspense(rawQuery)
  const speakerId = String(opts.userId || '').trim()

  const activation = new Map() // nodeId -> score
  const cueTrace = new Map()   // nodeId -> string
  const groundedHits = new Map() // nodeId -> count of direct seed hits (MaiBot Grounding Factor)

  const addSeed = (id, gain, reason) => {
    if (!g.nodes[id] || gain <= 0) return
    const prev = activation.get(id) || 0
    activation.set(id, prev + gain)
    groundedHits.set(id, (groundedHits.get(id) || 0) + 1)
    if (!cueTrace.has(id) || gain >= 0.8) {
      cueTrace.set(id, reason)
    }
  }

  // 线索 1：查询或 personName 参数显式提及人物名字/QQ号时点火对应人物节点
  let targetPersonId = ''
  for (const n of Object.values(g.nodes)) {
    if (n.type !== 'person') continue
    const rawUid = n.id.slice(2)
    if (
      (personName && (n.label === personName || rawUid === personName || (n.label && n.label.includes(personName)))) ||
      (n.label && n.label.length >= 2 && rawQuery.includes(n.label))
    ) {
      targetPersonId = rawUid
      addSeed(n.id, 1.25, `人物锚点(${n.label})`)
    }
  }

  // 线索 2：概念切词精确点火
  for (const t of tokens) {
    const id = `c:${t}`
    if (g.nodes[id]) {
      addSeed(id, 1.0, `概念(${t})`)
    } else {
      for (const n of Object.values(g.nodes)) {
        if (n.type === 'concept' && n.label && (n.label.includes(t) || t.includes(n.label))) {
          addSeed(n.id, 0.78, `近义概念(${t}→${n.label})`)
        }
      }
    }
  }

  // 线索 3：128 维语义向量余弦相似度跨词面点火
  for (const n of Object.values(g.nodes)) {
    if (n.type !== 'episode' && n.type !== 'fact' && n.type !== 'scene' && n.type !== 'concept') continue
    const nVec = getNodeVec(root, n)
    if (!nVec) continue
    const rs=remoteSimilarity(root,rawQuery,n.id,n.label)
    const sim=embeddingConfig().enabled?Math.max(cosineSimilarity(queryVec,nVec),rs??0):0
    const threshold = n.type === 'concept' ? 0.38 : 0.25
    if (sim >= threshold) {
      const resonance = explainSemanticResonance(rawQuery, n.label)
      const reasonTag = resonance.length
        ? `语义联想[${resonance.join(',')}]`
        : `向量相似(${Math.round(sim * 100)}%)`
      const boost = n.type === 'concept' ? sim * 1.1 : sim * 1.5
      addSeed(n.id, boost, reasonTag)
    }
  }

  if (!activation.size) return []

  // 构建邻接表并执行 2 跳启发式扩散传播
  const adjacency = new Map()
  for (const e of Object.values(g.edges)) {
    if (!adjacency.has(e.a)) adjacency.set(e.a, [])
    if (!adjacency.has(e.b)) adjacency.set(e.b, [])
    adjacency.get(e.a).push(e)
    adjacency.get(e.b).push(e)
  }

  let frontier = [...activation.keys()]
  for (let hop = 0; hop < 2; hop++) {
    const decay = hop === 0 ? 0.62 : 0.34
    const next = []
    for (const id of frontier) {
      const base = activation.get(id) || 0
      const baseCue = cueTrace.get(id) || g.nodes[id]?.label || id
      for (const e of adjacency.get(id) || []) {
        const other = e.a === id ? e.b : e.a
        const otherNode = g.nodes[other]
        if (!otherNode) continue
        const gain = base * decay * Math.min(2.2, (e.w || 1) / 2)
        if (gain <= 0.05) continue
        const cur = activation.get(other) || 0
        activation.set(other, cur + gain)
        if (!cueTrace.has(other)) {
          const hopLabel = otherNode.type === 'concept' || otherNode.type === 'person'
            ? `${baseCue} → ${otherNode.label}`
            : baseCue
          cueTrace.set(other, hopLabel)
        }
        next.push(other)
      }
    }
    frontier = [...new Set(next)]
    if (!frontier.length) break
  }

  const chatFilter = String(opts.chatId || '')
  const now = Date.now()
  const out = []

  for (const [id, act] of activation) {
    const n = g.nodes[id]
    if (!n || n.type === 'concept' || n.type === 'person' || n.type === 'group') continue
    if (mode === 'search' && n.type === 'episode') continue
    if (mode === 'episode' && n.type === 'fact') continue
    if ((opts.chatId || opts.scope || opts.kind) && !visibleIn(n,opts)) continue
    if (targetPersonId && mode === 'profile' && n.extra?.uid !== targetPersonId && n.extra?.subject !== targetPersonId && !(n.label || '').includes(personName)) continue
    if (act < 0.30) continue

    const nVec = getNodeVec(root, n)
    const rs=remoteSimilarity(root,rawQuery,n.id,n.label)
    const sim=embeddingConfig().enabled?Math.max(nVec?cosineSimilarity(queryVec,nVec):0,rs??0):0
    const retention = nodeRetentionStrength(n, now)

    // MaiBot Sparse BM25 风格词面精确重合分 + 多种子 Grounding 校准
    let bm25Score = 0
    let matchedTokenCount = 0
    const lowerLabel = String(n.label || '').toLowerCase()
    for (const tk of tokens) {
      if (lowerLabel.includes(tk)) {
        matchedTokenCount += 1
        bm25Score += 0.45 * Math.min(2, tk.length / 2)
      }
    }
    const groundingMultiplier = matchedTokenCount >= 2 ? 1.32 : 1.0

    let heuristicBonus = bm25Score
    const cues=[cueTrace.get(id)||'关联激活',...(rs!==null?['远端语义匹配']:[])]
    if (matchedTokenCount >= 2) cues.push(`双实体锚定(${matchedTokenCount}词)`)
    if (speakerId && (n.extra?.uid === speakerId || n.extra?.subject === speakerId)) {
      heuristicBonus += 0.35
      cues.push('当前对话人往事')
    }
    if (targetPersonId && (n.extra?.uid === targetPersonId || n.extra?.subject === targetPersonId)) {
      heuristicBonus += 0.65
      cues.push('目标人物画像')
    }
    if (queryMoodInfo.mood !== 'neutral' && n.extra?.mood === queryMoodInfo.mood && sim >= 0.15) {
      heuristicBonus += 0.35
      cues.push(`情绪共鸣(${queryMoodInfo.mood})`)
    }
    if (n.extra?.suspense && (sim >= 0.2 || queryMoodInfo.suspense)) {
      heuristicBonus += 0.3
      cues.push('未完约定')
    }

    const rawScore = (act * 2.1 + sim * 2.0 + heuristicBonus) * groundingMultiplier + Math.min(3.5, retention) * 0.45
    out.push({
      id,
      type: n.type,
      text: n.extra?.fullText||n.label,
      score: Number(rawScore.toFixed(2)),
      similarity: Number(sim.toFixed(2)),
      cue: cues.join(' · '),
      mood: n.extra?.mood || 'neutral',
      source: n.type === 'fact'
        ? '联想记忆树·事实'
        : n.type === 'scene'
          ? '联想记忆树·情景'
          : '联想记忆树·往事',
      when: n.extra?.ts || n.at,
      chat: n.extra?.chat || '',
    })
  }

  out.sort((a, b) => b.score - a.score)

  // 同源去重（P2-1）：同一 30 分钟情景段（scene）派生出的浓缩 fact、原始 scene、子 episode 及 auto_relation 事实，只保留得分最高的 1 条，绝不让一段对话拆成 5 条碎片占满召回位
  const seenOrigin = new Set()
  const deduped = []
  for (const it of out) {
    const node = g.nodes[it.id]
    if (!node) continue
    let originKey = ''
    if (node.type === 'scene') {
      originKey = node.id
    } else if (node.extra?.sceneId) {
      originKey = node.extra.sceneId
    } else if (Array.isArray(node.derived_from)) {
      originKey = node.derived_from.find((x) => String(x).startsWith('s:')) || ''
    } else if (Array.isArray(node.extra?.derived_from)) {
      originKey = node.extra.derived_from.find((x) => String(x).startsWith('s:')) || ''
    }
    if (!originKey && node.extra?.chat && node.extra?.ts && (node.type === 'episode' || node.extra?.source === 'auto_relation')) {
      const slot = Math.floor(Number(node.extra.ts) / SCENE_WINDOW_MS)
      originKey = `s:${node.extra.chat}:${slot}`
    }
    if (originKey) {
      if (seenOrigin.has(originKey)) continue
      seenOrigin.add(originKey)
    }
    deduped.push(it)
  }

  // 相对分数阈值截断（低于头名 42% 的弱关联凑数项直接丢弃，保障 Prompt 纯净）
  const topScore = deduped[0]?.score || 0
  const relevant = deduped.filter((it, idx) => idx === 0 || it.score >= topScore * 0.42)
  const picked = relevant.slice(0, limit)

  // 仅在内存中累计复习次数 hits（不触发 scheduleSave 全树写盘）
  for (const it of picked) {
    const n = g.nodes[it.id]
    if (n) n.hits = (n.hits || 0) + 1
  }
  return picked
}

export const heuristicRecall = recallFromTree

export function conversationEpisodes(root, kind) {
  return Object.values(loadGraph(root).nodes).filter(node => node.type === 'episode' &&
    node.extra?.role === 'user' && (!kind || node.extra.kind === kind)).map(({extra}) => ({
      role:extra.role, kind:extra.kind, platform:extra.platform, scope:extra.scope, chat:extra.chat,
      id:extra.uid, name:extra.name, text:extra.fullText, ts:extra.ts, messageId:extra.sourceMessageIds?.[0],
    }))
}

export const groupMemoryEpisodes = root => conversationEpisodes(root, 'group')

/** 供 WebUI 展示整张图（截断到可视规模） */
export function getTreeSnapshot(root, opts = {}) {
  const g = loadGraph(root)
  const nodes = Object.values(g.nodes)
  const limit = Math.max(10, Number(opts.limit || 160))
  const now = Date.now()
  let top = nodes
    .slice()
    .sort((a, b) => nodeRetentionStrength(b, now) - nodeRetentionStrength(a, now))
    .slice(0, limit)
  if (opts.focused) {
    const center=Object.hasOwn(g.nodes,opts.focus)?g.nodes[opts.focus]:null
    const type=String(opts.type||'all')
    const query=String(opts.query||'').trim().toLowerCase()
    const eligible=nodes.filter(n=>type==='all'||n.type===type).sort((a,b)=>nodeRetentionStrength(b,now)-nodeRetentionStrength(a,now))
    if (center) {
      const neighbors=Object.values(g.edges).filter(e=>e.a===center.id||e.b===center.id).sort((a,b)=>b.w-a.w)
        .map(e=>g.nodes[e.a===center.id?e.b:e.a]).filter(Boolean)
      const byId=new Map([[center.id,center],...neighbors.map(n=>[n.id,n])])
      top=[...byId.values()].slice(0,12)
    } else if (query) {
      top=eligible.filter(n=>`${n.label||''} ${n.extra?.fullText||''} ${n.id}`.toLowerCase().includes(query)).slice(0,12)
    } else if (type==='all') {
      top=[...eligible.filter(n=>n.type==='person').slice(0,5),...eligible.filter(n=>n.type==='group').slice(0,2),
        ...eligible.filter(n=>n.type==='concept').slice(0,5)]
      if (!top.length) top=eligible.slice(0,12)
    } else top=eligible.slice(0,12)
  }
  const keep = new Set(top.map((n) => n.id))
  const counts = { person: 0, group: 0, concept: 0, episode: 0, scene: 0, fact: 0 }
  let embeddedCount = 0
  for (const n of nodes) {
    counts[n.type] = (counts[n.type] || 0) + 1
    if (n.hasVec) embeddedCount += 1
  }
  return {
    updatedAt: g.updatedAt,
    total: nodes.length,
    embeddedCount,
    counts,
    nodes: top.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      weight: Number(n.w.toFixed(1)),
      hits: n.hits,
      mood: n.extra?.mood || '',
      hasVec: Boolean(n.hasVec),
      at: n.at, extra:n.extra || {},
    })),
    edges: Object.values(g.edges)
      .filter((e) => keep.has(e.a) && keep.has(e.b))
      .sort((a, b) => b.w - a.w)
      .slice(0, Math.max(40, limit * 2))
      .map((e) => ({ a: e.a, b: e.b, w: Number(e.w.toFixed(1)), kind: e.kind })),
  }
}

export function forgetNode(root, id) {
  const g = loadGraph(root)
  if (!g.nodes[id]) return false
  delete g.nodes[id]
  getVecMap(root).delete(id)
  for (const [k, e] of Object.entries(g.edges)) {
    if (e.a === id || e.b === id) delete g.edges[k]
  }
  scheduleSave(root, g)
  return true
}

/**
 * MaiBot 风格的海马体记忆主动维护接口（供 Agent 工具 remember / maintain_memory 调用）：
 * 支持 action = 'remember' (新增) | 'update' (修改替换旧记忆) | 'reinforce' (强化权重) | 'forget' (按关键词或ID遗忘删除)
 */
export function maintainMemoryTree(root, params = {}) {
  if (!root) return { ok: false, error: 'memoryRoot 未就绪' }
  const action = String(params.action || 'remember').trim().toLowerCase()
  const target = String(params.target || params.old_fact || '').trim()
  const subject = String(params.subject || '').trim()
  const fact = String(params.fact || params.text || '').trim()
  const g = loadGraph(root)
  const vmap = getVecMap(root)

  if (action === 'forget') {
    const keyword = target || fact || subject
    if (!keyword) return { ok: false, error: '请提供要遗忘的记忆关键词或节点 ID' }
    if (g.nodes[keyword]) {
      if(!visibleIn(g.nodes[keyword],params)) return {ok:false,error:'没有可修改的可见记忆'}
      const label = g.nodes[keyword].label
      forgetNode(root, keyword)
      return { ok: true, removed: 1, message: `已从海马体记忆树遗忘节点 [${keyword}]：${label}` }
    }
    const candidates = []
    for (const [id, n] of Object.entries(g.nodes)) {
      if(!visibleIn(n,params))continue
      if (n.type === 'person' || n.type === 'group' || n.type === 'concept') continue
      if ((n.label || '').includes(keyword)) {
        candidates.push({ id, label: n.label })
      }
    }
    if (candidates.length > 3 && !params.confirm) {
      return {
        ok: false,
        needConfirm: true,
        matched: candidates.length,
        preview: candidates.slice(0, 5).map((c) => `[${c.id}] ${c.label}`),
        error: `关键词「${keyword}」匹配到 ${candidates.length} 条独立记忆（超过 3 条安全上限），为防批量误删请提供更精确的句子或指定节点 ID（如 ${candidates.slice(0, 2).map((c) => c.id).join(' / ')}），或显式传 confirm:true`,
      }
    }
    let removed = 0
    const matchedLabels = []
    for (const c of candidates) {
      matchedLabels.push(c.label)
      delete g.nodes[c.id]
      vmap.delete(c.id)
      removed += 1
    }
    if (removed > 0) {
      const alive = new Set(Object.keys(g.nodes))
      for (const [k, e] of Object.entries(g.edges)) {
        if (!alive.has(e.a) || !alive.has(e.b)) delete g.edges[k]
      }
      scheduleSave(root, g)
    }
    return {
      ok: true,
      removed,
      message: removed > 0 ? `已遗忘 ${removed} 条包含「${keyword}」的记忆（${matchedLabels.slice(0, 2).join('；')}）` : `未找到包含「${keyword}」的记忆节点`,
    }
  }

  if (action === 'reinforce') {
    const keyword = target || fact || subject
    if (!keyword) return { ok: false, error: '请提供要强化的记忆关键词' }
    let count = 0
    for (const n of Object.values(g.nodes)) {
      if (visibleIn(n,params) && (n.id === keyword || (n.label && n.label.includes(keyword)))) {
        n.w = Number(((n.w || 1) + 3).toFixed(2))
        n.hits = (n.hits || 0) + 2
        n.at = Date.now()
        count += 1
      }
    }
    if (count > 0) scheduleSave(root, g)
    return {ok:count>0,reinforced:count,error:count?undefined:'未找到可强化的可见记忆',message:count>0?`已强化 ${count} 条关于「${keyword}」的记忆权重`:'未找到可强化的可见记忆'}
  }

  if (action === 'update' && target) {
    const removed=maintainMemoryTree(root,{...params,action:'forget',target})
    if(!removed.ok || !removed.removed)return {ok:false,error:removed.error || '未找到要替换的可见旧记忆'}
  }

  if (!fact) return { ok: false, error: '事实内容为空' }
  const r = rememberFact(subject, fact, root, {
    chat: params.chatId || '', scope:params.scope, platform:params.platform,
    kind: params.kind || 'private',
    name: params.name || '',
    source: action === 'update' ? 'updated_fact' : 'explicit',sourceMessageIds:params.sourceMessageIds||[],
  })
  return r ? { ok: true, id: r.id, message: `${action === 'update' ? '已修正记忆' : '已记入海马体记忆树'}（${r.id}）：${fact}` } : { ok: false, error: '写入失败' }
}

/** 删除某会话时同步清理记忆树中关联到该会话的往事、情景与事实节点 */
export function forgetChatNodes(root, chatId) {
  const cid = String(chatId || '').trim()
  if (!root || !cid) return 0
  const g = loadGraph(root)
  const vmap = getVecMap(root)
  let removed = 0
  for (const [id, n] of Object.entries(g.nodes)) {
    if (cid.includes(':') ? n.extra?.scope===cid : String(n.extra?.chat||'')===cid || id===`p:${cid}` || id===`g:${cid}`) {
      delete g.nodes[id]
      vmap.delete(id)
      removed += 1
    }
  }
  if (removed > 0) {
    const alive = new Set(Object.keys(g.nodes))
    for (const [k, e] of Object.entries(g.edges)) {
      if (!alive.has(e.a) || !alive.has(e.b)) delete g.edges[k]
    }
    scheduleSave(root, g)
  }
  return removed
}

export function treeStats(root) {
  const g = loadGraph(root)
  const nodes = Object.values(g.nodes)
  return {
    nodes: nodes.length,
    edges: Object.keys(g.edges).length,
    people: nodes.filter((n) => n.type === 'person').length,
    concepts: nodes.filter((n) => n.type === 'concept').length,
    episodes: nodes.filter((n) => n.type === 'episode').length,
    scenes: nodes.filter((n) => n.type === 'scene').length,
    facts: nodes.filter((n) => n.type === 'fact').length,
    embedded: nodes.filter((n) => Boolean(n.hasVec)).length,
    updatedAt: g.updatedAt,
  }
}

/** 测试用：清空内存态，强制下次从磁盘重载 */
export function resetTreeCache(root) {
  if (root) {
    graphs.delete(root)
    vecStores.delete(root)
  } else {
    graphs.clear()
    vecStores.clear()
  }
}

/** 把启发式召回结果（含联想线索链）渲染进 prompt */
export function formatTreeRecallForPrompt(items = []) {
  if (!Array.isArray(items) || !items.length) return ''
  const lines = items.map((it, i) => {
    const when = it.when ? new Date(Number(it.when)).toISOString().slice(5, 10) : ''
    const cueStr = it.cue ? ` | 启发线索: ${it.cue}` : ''
    return `  ${i + 1}. [${it.source}${when ? ' · ' + when : ''}${cueStr}] ${String(it.text || '').replace(/\s+/g, ' ')}`
  })
  return [
    '### 与当前话题相关的记忆线索',
    '这些线索可能是摘要。明确追问时简短回答，平时只在直接有帮助时提一次。已经说过的事不用再带回话题。日期和细节以记录为准。',
    ...lines,
  ].join('\n')
}
