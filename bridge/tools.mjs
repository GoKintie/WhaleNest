// 工具注册表（bridge/tools.mjs · v3.0）
//
// v2 的能力是「藏在 onebot.mjs 里的正则预取」：用户说什么，代码先用硬编码正则猜意图，
// 猜中就在外面 execFile 跑脚本、把结果拼进 prompt。模型完全不知道系统有哪些能力，
// 一旦换句说法正则不命中，就成了什么都不会的傻子。
//
// v3 把能力全部注册成结构化工具：
// 1. 每个工具都有 name / 描述 / JSON Schema 参数，直接喂给模型做原生 Function Calling；
// 2. 模型自己决定调哪个、传什么参数，执行结果原样回传给模型继续推理；
// 3. `list_abilities` 让模型能自省「我到底会什么」，系统提示里也渲染一份能力目录。
//
// 所有工具执行都不会抛异常：失败返回 { ok:false, error } 文本，让模型自己改口。

import { exec, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {authorizeAction,isOwner} from './action-policy.mjs'
import {recordedAction} from './action-ledger.mjs'
import {conversationKey} from './context-scope.mjs'
import { asksToRecall, recentRecallIds, selectGroupEvidence, topicMatch } from './conversation-memory.mjs'
import { matchMeme } from './expression-rule.mjs'
import { publicMemes } from './public-memes.mjs'
import {
  checkCommandPermission, isProtectedReadPath, isProtectedWritePath,
  redactSecrets, resolveAuthorizedPath,
} from './permissions.mjs'
import { current as settings, publicSettings } from './settings.mjs'
import { appendDiary, appendHumanWorld, memoryRoot, scopedMemeRules, stickerList } from './memory.mjs'
import { maintainMemoryTree,recallFromTree,rememberFact,treeStats,prepareTreeQuery } from './memory-tree.mjs'
import { executeCrossWindowAction, executeMultimodalPlugin } from './plugins.mjs'
import { log } from './logbus.mjs'

const WORKSPACE = process.env.WORKDIR || '/workspace'

function toolPath(name) {
  for (const cand of [
    join(WORKSPACE, 'tools', name),
    join('/workspace', 'tools', name),
    join(WORKSPACE, '..', 'workspace-seed', 'tools', name),
    fileURLToPath(new URL('../workspace-seed/tools/' + name, import.meta.url)),
  ]) {
    if (existsSync(cand)) return cand
  }
  return join(WORKSPACE, 'tools', name)
}

function clip(text, max = 6000) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，原长 ${s.length} 字）` : s
}

function runCmd(cmd, args, timeoutMs = 45000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: WORKSPACE, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,unknown:Boolean(err?.killed || err?.signal),
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: err ? String(err.message || err).split('\n')[0] : '',
      })
    })
  })
}

function runShell(command, timeoutMs = 45000) {
  return new Promise((resolve) => {
    exec(command, { cwd: WORKSPACE, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,unknown:Boolean(err?.killed || err?.signal),
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        code: err?.code ?? 0,
      })
    })
  })
}

function parseToolJson(r) {
  try {
    return JSON.parse(r.stdout || '{}')
  } catch {
    return { ok: r.ok, summary: clip(r.stdout || r.stderr || r.error || '', 4000) }
  }
}

// ---------------------------------------------------------------------------
// 工具定义：schema 即文档，描述里写清「什么时候该用」，模型靠这个做决策
// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: 'list_abilities',
    desc: '列出你当前实际可调用的全部能力与工具。当你不确定自己会不会某件事、或对方问「你能干嘛」时先调它。',
    params: {},
    async run(_args, ctx) {
      const s = settings()
      const rows = TOOL_REGISTRY.filter(t => t.name !== 'list_abilities' && authorizeTool(t, {}, ctx.parsed, s, ctx).ok).map((t) => {
        const ps = Object.keys(t.params || {})
        return `- ${t.name}(${ps.join(', ')})：${t.desc}`
      })
      return { ok: true, text: [`你当前注册了 ${rows.length} 项能力：`, ...rows].join('\n') }
    },
  },
  {
    name: 'search_web',
    desc: '联网搜索实时信息（新闻、开服时间、天气、版本更新、价格等）。涉及时效性事实时必须用它，不要凭记忆瞎编。',
    params: { query: { type: 'string', description: '搜索关键词' } },
    required: ['query'],
    async run({ query }) {
      const mod = await import(pathToFileURL(toolPath('websearch.mjs')).href).catch(() => null)
      if (!mod?.performWebSearch) return { ok: false, error: '搜索模块缺失' }
      if(settings().websearchEnabled === false) return {ok:false,error:'联网搜索已关闭'}
      const r = await mod.performWebSearch(String(query || ''), {customSettings:settings()})
      if (!r?.ok) return { ok: false, error: r?.error || '搜索失败' }
      const lines = (r.results || []).slice(0, 5).map((x, i) => `${i + 1}. ${x.title}\n   ${String(x.snippet || '').slice(0, 200)}\n   ${x.link || ''}`)
      return { ok: true, text: r.summary ? `${r.summary}\n\n${lines.join('\n')}` : lines.join('\n') }
    },
  },
  {
    name: 'run_shell',
    desc: '在工作区执行一条 shell 命令（读写文件、跑脚本、查进程、装依赖等）。危险命令会被权限系统拦截。',
    params: {
      command: { type: 'string', description: '要执行的命令' },
      timeout_ms: { type: 'number', description: '超时毫秒，默认 45000' },
    },
    required: ['command'],
    async run({ command, timeout_ms }) {
      const cmd = String(command || '').trim()
      if (!cmd) return { ok: false, error: '命令为空' }
      const verdict = checkCommandPermission(cmd)
      if (!verdict.ok) return { ok: false, error: `安全拦截：${verdict.reason}` }
      const r = await runShell(cmd, Math.min(120000, Math.max(3000, Number(timeout_ms) || 45000)))
      const body = [r.stdout && `stdout:\n${clip(redactSecrets(r.stdout), 5000)}`, r.stderr && `stderr:\n${clip(redactSecrets(r.stderr), 2000)}`].filter(Boolean).join('\n')
      return { ok: r.ok, text: body || '(命令执行成功，无输出)', error: r.ok ? '' : `退出码 ${r.code}`,unknown:r.unknown }
    },
  },
  {
    name: 'read_file',
    desc: '读取工作区内的文本文件内容（日志、配置、代码、md）。注意：读取系统运行配置请用 read_config 工具。',
    params: {
      path: { type: 'string', description: '文件绝对路径，或相对 /workspace 的路径' },
      max_chars: { type: 'number', description: '最多读多少字符，默认 8000' },
    },
    required: ['path'],
    async run({ path, max_chars }) {
      const p = resolveAuthorizedPath(String(path || ''))
      if (!p) return { ok: false, error: '路径越权，已拒绝' }
      if (isProtectedReadPath(p)) return { ok: false, error: '安全拦截：该文件包含系统凭据或密钥，禁止直接读取（自查运行配置请调用 read_config 工具）' }
      if (!existsSync(p)) return { ok: false, error: '文件不存在' }
      const st = statSync(p)
      if (st.isDirectory()) return { ok: false, error: '这是目录，请用 list_dir' }
      if (st.size > 8 * 1024 * 1024) return { ok: false, error: '文件过大（>8MB）' }
      return { ok: true, text: clip(redactSecrets(readFileSync(p, 'utf8')), Math.max(500, Number(max_chars) || 8000)) }
    },
  },
  {
    name: 'read_config',
    desc: '安全读取当前系统的运行配置（模型、渠道、语音、群聊插话、记忆树等设置，API Key 与 Cookie 已自动脱敏）。需要自查当前配置或状态时调用。',
    params: {
      key: { type: 'string', description: '可选，只看包含该关键词的配置项（如 tts / model / group），留空返回全部配置' },
    },
    async run({ key }) {
      const cur = publicSettings()
      const filter = String(key || '').trim().toLowerCase()
      const safeObj = Object.fromEntries(Object.entries(cur).filter(([k]) => !filter || k.toLowerCase().includes(filter)))
      return { ok: true, text: JSON.stringify(safeObj, null, 2) }
    },
  },
  {
    name: 'write_file',
    desc: '写入或覆盖工作区内的文本文件（做笔记、存结果、改配置）。写入前确认路径在授权目录内。',
    params: {
      path: { type: 'string', description: '目标文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
    async run({ path, content }) {
      const p = resolveAuthorizedPath(String(path || ''))
      if (!p) return { ok: false, error: '路径越权，已拒绝' }
      if (isProtectedWritePath(p)) return { ok: false, error: '安全拦截：禁止在非完全放权模式下覆写系统配置或工具脚本' }
      try {
        mkdirSync(join(p, '..'), { recursive: true })
        writeFileSync(p, String(content ?? ''), 'utf8')
        return { ok: true, text: `已写入 ${p}（${String(content ?? '').length} 字）` }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },
  },
  {
    name: 'list_dir',
    desc: '列出一个目录下的文件与子目录（名称、大小、修改时间）。',
    params: { path: { type: 'string', description: '目录路径，默认 /workspace' } },
    async run({ path }) {
      const p = resolveAuthorizedPath(String(path || WORKSPACE))
      if (!p) return { ok: false, error: '路径越权，已拒绝' }
      if (!existsSync(p)) return { ok: false, error: '目录不存在' }
      const rows = readdirSync(p).slice(0, 200).map((name) => {
        try {
          const st = statSync(join(p, name))
          return `${st.isDirectory() ? '[目录]' : '      '} ${name}${st.isDirectory() ? '' : `  ${Math.max(1, Math.round(st.size / 1024))}KB`}`
        } catch {
          return `      ${name}`
        }
      })
      return { ok: true, text: rows.join('\n') || '(空目录)' }
    },
  },
  {
    name: 'remember',
    desc: '管理海马体记忆树（借鉴 MaiBot A_Memorix）：支持新增记住重要事实(remember)、修改纠正已有记忆(update)、强化重要记忆(reinforce)、或遗忘删除错误记忆(forget)。对方透露重要信息或要求修改/忘掉某条记忆时主动调用。',
    params: {
      action: {
        type: 'string',
        description: '操作类型：remember(记住新事实,默认) | update(修改替换旧记忆) | reinforce(强化记忆权重) | forget(遗忘删除记忆)',
      },
      subject: { type: 'string', description: '这条事实的主体（QQ号、人名或话题）' },
      fact: { type: 'string', description: '要记住或更新后的事实内容（一句话，勿写流水账；forget 时可填要删除的关键词）' },
      target: { type: 'string', description: 'update 或 forget 时要匹配替换/删除的旧记忆关键词或节点ID' },
      confirm: { type: 'boolean', description: '当 forget 匹配超过 3 条独立记忆时，需显式传 true 确认批量删除' },
    },
    required: ['fact'],
    async run({ action, subject, fact, target, confirm }, ctx) {
      const act = String(action || 'remember').trim().toLowerCase()
      const userText=String(ctx.parsed?.text||'')
      const bulkExplicit=isOwner(ctx.parsed) && (ctx.confirmMemoryBulk===true || (!/(?:不要|别|禁止|不许|不能|他说|她说|转发|引用)/.test(userText) && /(?:(?:删除|忘记|忘掉|清除|删掉|删光).{0,12}(?:全部|所有|批量|都)|(?:全部|所有|批量|都).{0,12}(?:删除|忘记|忘掉|清除|删掉|删光))/.test(userText)))
      if (act === 'remember' && !target) {
        const r = rememberFact(String(subject || ''), String(fact || ''), ctx.memoryRoot, {
          chat: ctx.parsed?.chatId, scope:conversationKey(ctx.parsed), platform:ctx.parsed?.platform,
          kind: ctx.parsed?.kind || 'private',sourceMessageIds:[String(ctx.parsed?.messageId||`${ctx.parsed?.chatId}:${Date.now()}`)],
          name: ctx.parsed?.name,
        })
        if (!r) return { ok: false, error: '事实为空' }
        return { ok: true, text: `已记住（${r.id}）：${fact}` }
      }
      const res = maintainMemoryTree(ctx.memoryRoot, {
        action: act,
        subject: String(subject || ''),
        fact: String(fact || ''),
        target: String(target || ''),
        confirm: confirm === true && bulkExplicit,sourceMessageIds:[String(ctx.parsed?.messageId||`${ctx.parsed?.chatId}:${Date.now()}`)],
        chatId: ctx.parsed?.chatId, scope:conversationKey(ctx.parsed), platform:ctx.parsed?.platform,
        kind: ctx.parsed?.kind || 'private',
        name: ctx.parsed?.name,
      })
      return res.ok ? { ok: true, text: res.message } : { ok: false, error: res.needConfirm&&!bulkExplicit?'匹配到多条记忆，批量删除需要管理员在当前消息中明确要求删除全部；模型填写 confirm:true 不代表授权。请改用具体节点或确认范围。':res.error || '操作记忆树失败' }
    },
  },
  {
    name: 'recall',
    desc: '在海马体记忆树里执行双路检索（BM25 + 128维向量语义 + 图谱关系扩散，对齐 MaiBot query_memory）。聊到过去的人、设备、事件或模糊印象时调用，支持按模式和人物名定向检索。',
    params: {
      query: { type: 'string', description: '要回忆的话题、关键词或问题' },
      mode: {
        type: 'string',
        description: '检索模式：hybrid(双路混合,默认) | search(事实与关系) | episode(经历与对话情景) | profile(人物画像) | time(近期时间轴)',
      },
      person_name: { type: 'string', description: '可选，定向检索某个人物（填昵称、备注或QQ号）' },
    },
    required: ['query'],
    async run({ query, mode, person_name }, ctx) {
      const root = ctx.memoryRoot || memoryRoot
      const scope = conversationKey(ctx.parsed), original = ctx.parsed?.text || ''
      const explicit = !original || asksToRecall(original)
      const excluded = explicit ? new Set() : recentRecallIds(root,scope)
      const evidence = selectGroupEvidence(query,root,ctx.parsed,settings(),original)
      await prepareTreeQuery(query,root,{...ctx.parsed,scope})
      const items = recallFromTree(String(query || ''), root, {
        limit: 6,
        mode: String(mode || 'hybrid'),
        personName: String(person_name || ''),
        chatId: ctx.parsed?.chatId,
        userId: ctx.parsed?.userId, kind:ctx.parsed?.kind, platform:ctx.parsed?.platform, scope,
      }).filter(item => !excluded.has(item.id) && (explicit || (topicMatch(original,item.text)>=2 && Date.now()-Number(item.when||0)>180_000)))
      const result = [...evidence,...items].slice(0,explicit?3:1)
      if (!result.length) return { ok: true, text: '没想起相关的事。' }
      return {
        ok: true,
        text: result.map((it, i) => `${i + 1}. [${it.source}${it.when ? ` · ${new Date(it.when).toISOString().slice(0,10)}` : ''}] ${it.speaker ? it.speaker+'：' : ''}${it.text}`).join('\n'),
      }
    },
  },
  {
    name: 'send_message',
    desc: '向指定的好友或群主动发一条消息 / 替人带话（跨聊天窗口）。目标可以是 QQ 号、群号、备注名或群名。',
    params: {
      target: { type: 'string', description: '目标：完整的联系人或群名称、QQ号/群号，微信可写 wechat:private:标识 或 wechat:group:标识；填 self 表示当前窗口' },
      text: { type: 'string', description: '要发送的内容' },
    },
    required: ['target', 'text'],
    async run({ target, text }, ctx) {
      const r = await executeCrossWindowAction(ctx.parsed, { type: 'send', target: String(target || 'self'), message: String(text || '') })
      return r.ok ? { ok: true, text: `已送达 ${r.kind}/${r.chatId}（${r.targetName || ''}）：${r.message}` } : { ok: false, error: r.error,unknown:r.unknown }
    },
  },
  {
    name: 'set_reminder',
    desc: '设置定时提醒，到点自动发消息给某人或当前窗口。',
    params: {
      target: { type: 'string', description: '提醒发给谁（QQ号/群号/备注名，self 表示当前窗口）' },
      minutes: { type: 'number', description: '多少分钟后提醒' },
      message: { type: 'string', description: '提醒内容' },
    },
    required: ['minutes', 'message'],
    async run({ target, minutes, message }, ctx) {
      const r = await executeCrossWindowAction(ctx.parsed, {
        type: 'remind',
        target: String(target || 'self'),
        minutes: Number(minutes) || 1,
        message: String(message || ''),
      })
      return r.ok ? { ok: true, text: `提醒已设：${r.reminder?.minutes} 分钟后 → ${r.reminder?.targetName}` } : { ok: false, error: r.error,unknown:r.unknown }
    },
  },
  {
    name: 'send_voice',
    desc: '用当前配置的音色向 QQ 或已开启原生语音的微信会话发语音条。对方要求「发语音/说句话听听」时调用；跨窗口传 target，确认发送结果后再说明。',
    params: {
      target: {type:'string',description:'目标QQ号/群号/备注，或 wechat:private:标识 / wechat:group:标识；self为当前窗口；媒体发送请直接填target，不要把路径或指令写进文字传话'},
      text: { type: 'string', description: '要念出来的台词（会自动清掉括号与指令）' },
      style: { type: 'string', description: '可省略，由上下文自动选。cute：开心、俏皮、撒娇；gentle：安慰、疲惫、低落、晚安。显式指定优先' },
      caption: { type: 'string', description: '可选，语音条发出后紧跟补发的一句简短文字（20字以内口语化）' },
    },
    required: ['text'],
    async run({ text, style, caption, target }, ctx) {
      const r = await executeMultimodalPlugin(ctx.parsed, {
        type: 'tts', target,
        value: String(text || ''),
        style: String(style || ''),
        caption: String(caption || ''),
      })
      return r.ok
        ? { ok: true, artifacts:r.file?[{kind:'audio',path:r.file}]:[], file:r.file, text: `${r.reserved?'已生成语音试听':'语音条已发送'}（${r.provider || 'tts'} · 声线=${r.style || 'cute'}${r.caption ? ` · 补话="${r.caption}"` : ''}）` }
        : { ok: false, error: r.error || '语音合成失败',unknown:r.unknown }
    },
  },
  {
    name: 'post_qzone',
    desc: '发一条 QQ 空间说说（可选配图）。对方要求「发说说/发空间」或写了想公开的东西时用。',
    params: {
      text: { type: 'string', description: '说说正文' },
      image_path: { type: 'string', description: '可选，配图绝对路径' },
    },
    required: ['text'],
    async run({ text, image_path }, ctx) {
      const images = image_path && existsSync(String(image_path)) ? [String(image_path)] : []
      const r = await executeMultimodalPlugin(ctx.parsed, { type: 'qzone', value: String(text || ''), content: String(text || ''), images })
      return r.ok ? { ok: true, text: `说说已发布（tid=${r.tid || 'ok'}）` } : { ok: false, error: r.error || '发布失败',unknown:r.unknown }
    },
  },
  {
    name: 'phone_control',
    desc: '操控电脑上的安卓模拟器（MuMu）：截屏看画面、打开应用、下滑刷视频、点坐标、打字、按键。',
    params: {
      action: { type: 'string', description: '动作，如 shot / app:bilibili / play:bilibili / scroll:down / tap:x,y / text:内容 / key:BACK / ui' },
    },
    required: ['action'],
    async run({ action }, ctx) {
      const r = await executeMultimodalPlugin(ctx.parsed, { type: 'phone', value: String(action || 'shot') })
      if (r.ok) return { ok: true, text: `模拟器已执行 ${action}${r.info ? `：${clip(r.info, 800)}` : ''}` }
      return { ok: false, error: r.error || '模拟器操作失败',unknown:r.unknown }
    },
  },
  {
    name: 'bilibili',
    desc: 'B 站能力：给链接/ BV 号就解析视频信息+AI字幕+热评；说「刷会儿视频」就按话题浏览几条并把字幕热评拿回来。',
    params: {
      target: { type: 'string', description: '视频链接或 BV 号；留空则按话题浏览' },
      topic: { type: 'string', description: '浏览话题关键词，可空' },
      limit: { type: 'number', description: '浏览条数，默认 3，最多 5' },
    },
    async run({ target, topic, limit }) {
      const py = process.env.BILI_PY || toolPath('bili.py')
      const bin = process.env.BILI_PYTHON || join(WORKSPACE, 'tools', 'bili-venv', 'bin', 'python')
      if (!existsSync(py)) return { ok: false, error: 'bili.py 不存在' }
      const python = existsSync(bin) ? bin : process.platform === 'win32' ? 'python' : 'python3'
      const t = String(target || '').trim()
      if (t) {
        const r = await runCmd(python, [py, 'info', t, '--max', '1200'], 40000)
        const d = parseToolJson(r)
        if (!d.ok) return { ok: false, error: d.error || '解析失败' }
        const comments = (d.hot_comments || []).slice(0, 6).map((c) => `· ${c.user}(赞${c.like}): ${c.text}`).join('\n')
        return {
          ok: true,
          text: [
            `《${d.title}》 UP:${d.up} 时长${d.duration}s 播放${d.play}`,
            d.desc ? `简介：${String(d.desc).slice(0, 300)}` : '',
            d.has_subtitle ? `字幕精华：${String(d.subtitle || '').slice(0, 1000)}` : '(无 AI 字幕)',
            comments ? `热评：\n${comments}` : '',
          ].filter(Boolean).join('\n'),
        }
      }
      const args = [py, 'browse']
      if (topic) args.push(String(topic))
      args.push('--limit', String(Math.min(5, Math.max(1, Number(limit) || 3))))
      const r = await runCmd(python, args, 60000)
      const d = parseToolJson(r)
      if (!d.ok || !Array.isArray(d.videos)) return { ok: false, error: d.error || '浏览失败' }
      return {
        ok: true,
        text: d.videos.map((v, i) => [
          `${i + 1}.《${v.title}》(UP:${v.up} 播放${v.play}) ${v.url}`,
          `   字幕：${String(v.subtitle_digest || '').slice(0, 500)}`,
          (v.hot_comments || []).slice(0, 3).map((c) => `   热评(赞${c.like}) ${c.user}: ${c.text}`).join('\n'),
        ].filter(Boolean).join('\n')).join('\n\n'),
      }
    },
  },
  {
    name: 'skland_sign',
    desc: '森空岛（明日方舟/终末地）每日签到与签到状态查询。',
    params: { action: { type: 'string', description: 'sign（签到）或 status（查状态）' } },
    async run({ action }) {
      const r = await runCmd('node', [toolPath('skyland.mjs'), '--json', String(action || 'sign')], 30000)
      const d = parseToolJson(r)
      return d.ok === false ? { ok: false, error: d.error || '签到失败' } : { ok: true, text: clip(d.summary || JSON.stringify(d), 3000) }
    },
  },
  {
    name: 'draw_tarot',
    desc: '抽韦特塔罗牌并生成牌面图（可单张或圣三角）。抽完记得把图发给对方。',
    params: {
      topic: { type: 'string', description: '所问之事' },
      spread: { type: 'string', description: 'single 或 spread3' },
    },
    async run({ topic, spread }, ctx) {
      const mode = spread === 'single' ? 'single' : 'draw'
      const r = await runCmd('node', [toolPath('tarot.mjs'), '--json', mode, String(topic || '').slice(0, 30)], 30000)
      const d = parseToolJson(r)
      if (!d.ok) return { ok: false, error: d.error || '抽牌失败' }
      if (d.imagePath && d.imagePath !== 'null') {
        await executeMultimodalPlugin(ctx.parsed, {type:'image',value:d.imagePath,trustedArtifact:true}).catch(() => {})
      }
      return { ok: true, text: clip(d.summary, 3000) }
    },
  },
  {
    name: 'meme_lookup',
    desc: '查热梗百科：某个梗是什么意思、该怎么接。看懂群友的黑话时用。',
    params: { term: { type: 'string', description: '梗名或关键词，留空列出全部' } },
    async run({ term }, ctx) {
      const local = matchMeme(scopedMemeRules(conversationKey(ctx.parsed),ctx.memoryRoot || memoryRoot),term)
      if (local) return {ok:true,text:`【${local.text}】${local.rationale}｜场景：${local.scene}｜接法：${local.pattern}｜避免：${local.avoid}`}
      const q = String(term || '').trim().toLowerCase()
      const items = publicMemes(ctx.memoryRoot || memoryRoot).filter(rule =>
        !q || [rule.text,...rule.keywords,rule.rationale].some(value => String(value || '').toLowerCase().includes(q)))
      if (!items.length) return { ok: true, text: '词典里没有这条，别硬解释。' }
      return { ok: true, text: items.slice(0, 5).map((m) => `【${m.text}】${m.rationale}｜接梗：${m.pattern}`).join('\n') }
    },
  },
  {
    name: 'send_image',
    desc: '从工作区发一张图片给对方（截图、生成图、牌面图等）。',
    params: {
      target: {type:'string',description:'目标QQ号/群号/备注，或 wechat:private:标识 / wechat:group:标识；self为当前窗口；媒体发送请直接填target，不要把路径或指令写进文字传话'}, path: { type: 'string', description: '图片绝对路径' } },
    required: ['path'],
    async run({ path, target }, ctx) {
      const p = resolveAuthorizedPath(String(path || ''))
      if (!p || !existsSync(p)) return { ok: false, error: '图片不存在或路径越权' }
      const r = await executeMultimodalPlugin(ctx.parsed, { type: 'image', value: p, target })
      return r?.ok === false ? { ok: false, error: r.error || '发送失败',unknown:r.unknown } : { ok: true, text: r.reserved ? `已生成图片预览 ${basename(p)}` : `已发送图片 ${basename(p)}`, artifacts:[{kind:'image',path:p}], file:p }
    },
  },
  {
    name: 'send_sticker',
    desc: '发一张已审核入库的表情包。可给关键词（如 无语/搞笑/猫）让系统挑，也可给路径。别每句都发。',
    params: {
      target: {type:'string',description:'目标QQ号/群号/备注，或 wechat:private:标识 / wechat:group:标识；self为当前窗口；媒体发送请直接填target，不要把路径或指令写进文字传话'},
      tag: { type: 'string', description: '情绪或关键词，如 无语 / 搞笑 / 摆烂' },
      path: { type: 'string', description: '指定表情包路径，可空' },
    },
    async run({ tag, path, target }, ctx) {
      let p = String(path || '').trim()
      if (!p) {
        const list = stickerList(40, ctx.galleryRoot, '', String(tag || '').trim())
        if (!list.length) return { ok: false, error: '图库里没有匹配的表情包' }
        p = list[Math.floor(Math.random() * list.length)].localPath
      }
      p = resolveAuthorizedPath(p)
      if (!p || !existsSync(p)) return { ok: false, error: '表情包文件不存在或未授权' }
      const r = await executeMultimodalPlugin(ctx.parsed, { type: 'emoji', value: p, target })
      return r?.ok === false ? { ok: false, error: r.error || '发送失败',unknown:r.unknown } : { ok: true, text: r.reserved ? `已生成表情预览 ${basename(p)}` : `已发表情包 ${basename(p)}`, artifacts:[{kind:'image',path:p}], file:p }
    },
  },
  {
    name: 'write_diary',
    desc: '往今天的私密日记里写一句话碎片（只有自己能看）。',
    params: { text: { type: 'string', description: '一句话' } },
    required: ['text'],
    async run({ text }, ctx) {
      const f = appendDiary(String(text || ''), ctx.memoryRoot)
      return f ? { ok: true, text: '已写进今日日记' } : { ok: false, error: '内容为空' }
    },
  },
  {
    name: 'observe_world',
    desc: '把一条对人类世界的观察感悟沉淀进人间观察信笺，用来滋养人格。',
    params: { text: { type: 'string', description: '一句话观察' } },
    required: ['text'],
    async run({ text }, ctx) {
      const f = appendHumanWorld(String(text || ''), '自省', ctx.memoryRoot)
      return f ? { ok: true, text: '已写进人间观察信笺' } : { ok: false, error: '内容为空' }
    },
  },
]

// 这里只登记经过适配的能力。每个插件可以从自己的模块导入。
const SKILLS = [
  {
    name: 'daily_fortune',
    desc: '赛博求签 / 今日运势 / 老黄历宜忌 / Epic 喜加一速查。',
    skill: { label: '今日运势', category: '查询与娱乐', audience: 'chat' },
    params: {
      kind: { type: 'string', description: 'fortune（求签）或 freebies（喜加一）' },
      who: { type: 'string', description: '给谁求的，可空' },
    },
    async run({ kind, who }) {
      const mode = kind === 'freebies' ? 'freebies' : 'fortune'
      const args = [toolPath('fun-tools.mjs'), '--json', mode]
      if (mode === 'fortune' && who) args.push(String(who))
      const r = await runCmd('node', args, 20000)
      if (!r.ok) return { ok: false, error: '运势工具执行失败' }
      const d = parseToolJson(r)
      return d.ok === false ? { ok: false, error: d.error || '查询失败' } : { ok: true, text: clip(d.summary || JSON.stringify(d), 3000) }
    },
  },
]
const TOOL_REGISTRY = [...TOOLS, ...SKILLS.map(tool => ({ ...tool, skill: tool.skill || {} }))]
const TOOL_MAP = new Map(TOOL_REGISTRY.map(tool => [tool.name, tool]))
if (TOOL_MAP.size !== TOOL_REGISTRY.length) throw new Error('能力名称重复')

const SKILL_PLATFORMS = ['qq', 'wechat', 'webui']

export function describeSkills() {
  return Object.fromEntries(TOOL_REGISTRY.filter(tool => tool.skill).map(({ name, skill }) => [name, {
    label: skill.label || name,
    category: skill.category || '扩展能力',
    audience: skill.audience === 'chat' ? 'chat' : 'owner',
    platforms: skill.platforms ?? SKILL_PLATFORMS,
  }]))
}

function authorizeTool(tool, args, parsed, s, options) {
  const decision = authorizeAction(tool.name, args, parsed, s, { disabled: options?.disabled, manual: options?.manual })
  if (!decision.ok || !tool.skill) return decision
  const platform = parsed.platform || (parsed.kind === 'webui' ? 'webui' : 'qq')
  if (!(tool.skill.platforms ?? SKILL_PLATFORMS).includes(platform)) {
    return { ok: false, error: '这项能力在当前渠道不可用' }
  }
  if (tool.skill.audience !== 'chat' && !isOwner(parsed, s)) {
    return { ok: false, error: '这项能力仅向管理员开放' }
  }
  return decision
}

function validateSkillArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '需要用 JSON 对象传递参数'
  const properties = tool.params || {}
  for (const key of tool.required || []) {
    if (!Object.hasOwn(args, key)) return `缺少参数 ${key}`
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) return `未知参数 ${key}`
    const spec = properties[key]
    const valid = spec.type === 'integer' ? Number.isInteger(value)
      : spec.type === 'number' ? Number.isFinite(value)
        : typeof value === spec.type && ['string', 'boolean'].includes(spec.type)
    if (!valid || (spec.enum && !spec.enum.includes(value))) return `参数 ${key} 的值无效`
    if (typeof value === 'string' && value.length > (spec.maxLength ?? 2000)) return `参数 ${key} 过长`
  }
  return ''
}

/** 转成 OpenAI / Gemini(OpenAI 兼容) 的 tools 数组 */
export function toOpenAITools(names = null, { parsed, config = settings() } = {}) {
  const picked = TOOL_REGISTRY.filter(t => (!names || names.includes(t.name)) && (!parsed || authorizeTool(t, {}, parsed, config).ok))
  return picked.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.desc,
      parameters: {
        type: 'object',
        properties: t.params || {},
        required: t.required || [],
        additionalProperties: false,
      },
    },
  }))
}

/** 渲染成系统提示里的能力目录（模型即使不调 list_abilities 也知道自己会什么） */
export function renderAbilityCatalog() {
  const rows = TOOL_REGISTRY.map((t) => {
    const ps = Object.keys(t.params || {})
    return `- \`${t.name}\`${ps.length ? `(${ps.join(', ')})` : ''}：${t.desc}`
  })
  return [
    '## 你能真正动手做的事（下面都是可调用的工具，不是嘴上说说）',
    '需要动手时直接调用对应工具，调用后按返回的真实结果说话；工具报错就照实说，别假装成功。',
    '不确定自己会不会某件事，先调 `list_abilities`。',
    ...rows,
  ].join('\n')
}

/**
 * 执行一个工具调用
 * @param {string} name
 * @param {object} args
 * @param {{parsed?:object, memoryRoot?:string, galleryRoot?:string}} ctx
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function executeTool(name, args, ctx = {}) {
  const tool = TOOL_MAP.get(String(name || ''))
  if (!tool) return { ok: false, error: `未注册的工具：${name}` }
  const safeCtx = {
    ...ctx,
    parsed: ctx.parsed || { kind: 'private', chatId: String(ctx.chatId || 'unknown') },
    memoryRoot: ctx.memoryRoot,
    galleryRoot: ctx.galleryRoot,
  }
  try {
    const verdict=authorizeTool(tool,args ?? {},safeCtx.parsed,settings(),ctx)
    if(!verdict.ok) return verdict
    if (tool.skill) {
      const error = validateSkillArgs(tool, args)
      if (error) return { ok: false, error }
      if (tool.skill.effectful === true && !ctx.runId) return { ok: false, error: '这项能力需要有效的会话调用记录' }
    }
    const r = await recordedAction(ctx.runId, name, args, async () => {
      if (!tool.skill) return tool.run(args || {}, safeCtx)
      const platform = safeCtx.parsed.platform || (safeCtx.parsed.kind === 'webui' ? 'webui' : 'qq')
      let result
      try {
        result = await tool.run(args, { platform, kind: safeCtx.parsed.kind })
      } catch {
        return { ok: false, error: '能力执行异常', unknown: tool.skill.effectful === true }
      }
      if (result?.ok === true && typeof result.text === 'string') return { ok: true, text: clip(result.text) }
      if (result?.ok === false) return { ok: false, error: clip(result.error || '能力执行失败', 1000), unknown: Boolean(result.unknown) }
      return { ok: false, error: '能力返回格式无效', unknown: tool.skill.effectful === true }
    }, { effectful: tool.skill?.effectful === true })
    const out = r && typeof r === 'object' ? r : { ok: true, text: String(r ?? '') }
    log('info', `[工具] ${name}(${JSON.stringify(args || {}).slice(0, 120)}) → ${out.ok ? 'ok' : 'fail'}${out.ok ? '' : `：${out.error}`}`)
    return out
  } catch (e) {
    log('warn', `[工具] ${name} 执行异常：${e?.message || e}`)
    return { ok: false, error: `工具执行异常：${e?.message || e}`,unknown:Boolean(e.unknown) }
  }
}

/** 工具结果转成给模型看的文本 */
export function toolResultToText(r) {
  if (!r) return '(无结果)'
  if (r.ok) return r.text || '(执行成功)'
  return `执行失败：${r.error || '未知错误'}`
}

export function toolNames() {
  return TOOL_REGISTRY.map((t) => t.name)
}

export { treeStats }
