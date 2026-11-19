// 工作区放权控制与动态外部插件扩展接口（bridge/permissions.mjs · v2.7）
//
// 满足管理员逐步放权需求：
// 1. 三档权限级别（permissionLevel）：
//    - 'standard'（默认标准模式）：可读写 /workspace 及 allowedPaths 中显式授权的目录，拦截高危删库/停容器命令
//    - 'elevated'（扩展放权模式）：允许跨目录访问 allowedPaths（如挂载的宿主机目录 /mnt/nas、/opt/plugins），允许安装 npm/pip 插件依赖
//    - 'unrestricted'（完全放权模式）：向肥鱼开放容器内全部文件读写与命令执行权限（仅保留防误删根目录 / 的底线保护）
// 2. 动态插件发现与挂载接口（/workspace/plugins/ 与 /workspace/tools/）：
//    - 支持扫描 .mjs / .py / .sh 脚本头部的 @plugin-name / @plugin-trigger / @plugin-desc 注释或 *.plugin.json 清单
//    - 支持通过 WebUI 或指令动态注册/安装新插件脚本，自动注入肥鱼的工具说明书

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { current as settings, settingsPath } from './settings.mjs'
import { settingsKeyPath } from './settings-secrets.mjs'
import { log } from './logbus.mjs'

const WORKSPACE = process.env.WORKDIR || '/workspace'
export const PLUGINS_DIR = process.env.PLUGINS_DIR || join(WORKSPACE, 'plugins')
export const TOOLS_DIR = join(WORKSPACE, 'tools')

export const PERMISSION_LEVELS = [
  {
    id: 'standard',
    name: '标准工作区模式（默认推荐）',
    desc: '可自由读写 /workspace 及额外授权目录，内置安全护栏拦截删库与高危系统命令',
  },
  {
    id: 'elevated',
    name: '扩展放权模式（进阶折腾）',
    desc: '允许跨目录读写所有授权挂载路径，允许自主执行 npm/pip 安装插件依赖与管理外部脚本',
  },
  {
    id: 'unrestricted',
    name: '完全放权模式（开发者最高权限）',
    desc: '放开容器内全部路径读写与任意 Shell 工具调用（仅保留防 rm -rf / 删根保护）',
  },
]

// 绝对底线：任何权限下都严禁格式化磁盘、关机或直接 rm -rf / 根目录
const FATAL_ROOT_CMD_RE = /(?:^|[;&|`\s])(?:rm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+\/(?:\s|$|\*)|mkfs|dd\s+if=|shutdown|reboot|poweroff|init\s+0|:(){)/i

// 标准/扩展模式下的高危拦截（防删容器、防删 /workspace 根与核心子目录、防改全局权限）
const STANDARD_GUARD_CMD_RE = /(?:^|[;&|`\s])(?:docker\s+(?:rm|stop|kill|system\s+prune)|chmod\s+-R\s+777\s+\/(?:\s|$)|rm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(?:\/workspace\/?(?:\s|$|\*|[;&|])|\/workspace\/(?:memory|gallery|tools|plugins|settings\.json)\b|\.\.?(?:\/|$|\s|\*)|\*)|rmdir\s+\/workspace\b|find\s+\/workspace\b[^\n;&|]*-delete\b)/i

// 数据外传拦截（拦 POST/上传/裸 socket，以及带命令替换 $() 或反引号的查询参数 GET 外传）
const EXFIL_CMD_RE = /(?:curl[^\n|;&]*(?:-X\s*POST|--data|--json|-F\s|-d\s*@|--upload-file|-T\s)|wget[^\n|;&]*(?:--post-data|--post-file)|(?:curl|wget)[^\n|;&]*\?[^\n|;&]*(?:\$\(|`)|(?:^|[;&|\s])(?:nc|ncat|socat)\s)/i

// Shell 写保护：拦截重定向、tee、sed -i、cp/mv/rm 等覆写或删除受保护凭据文件及 /workspace/tools/、/workspace/plugins/ 脚本（支持跨行匹配 heredoc）
const PROTECTED_SHELL_WRITE_RE = /(?:(?:>|>>|\btee\b|\bsed\s+-[a-zA-Z]*i|\bcp\b|\bmv\b|\brm\b|\bchmod\b|\bchown\b|\btruncate\b|\bdd\b)[\s\S]*(?:settings\.json|bili_credential\.json|skyland_config\.json|cordis\.patch\.yml|\.env\b|\/workspace\/(?:tools|plugins)\/)|(?:settings\.json|bili_credential\.json|skyland_config\.json|cordis\.patch\.yml|\.env\b)[\s\S]*(?:>|>>|\btee\b))/i

// Shell 读凭据保护：拦截 cat/head/tail/grep/sed/awk/jq/base64/xxd/python/node/curl 等读取受保护凭据内容（支持跨行匹配 heredoc，放行单行 ls / find -name / stat 等纯列目录命令）
const PROTECTED_SHELL_READ_RE = /(?:(?:\b(?:cat|tac|head|tail|less|more|nl|od|xxd|hexdump|strings|base64|grep|egrep|fgrep|rg|awk|gawk|sed|cut|sort|uniq|jq|python3?|node|sh|bash|dash|zsh|source|curl|wget|xargs)\b|<)[\s\S]*(?:settings\.json|bili_credential\.json|skyland_config\.json|cordis\.patch\.yml|(?:^|[\/\s"'])\.env\b)|\bfind\b[\s\S]*(?:settings\.json|bili_credential\.json|skyland_config\.json|cordis\.patch\.yml|\.env)[\s\S]*-(?:exec|execdir|ok|delete)\b)/i

/**
 * 检查目标路径是否为受保护的敏感凭据文件（非 unrestricted 模式下禁止模型通过 read_file 读取泄露 Key）
 */
export function isProtectedReadPath(resolvedPath, customSettings = null) {
  const s = customSettings || settings()
  if (s.permissionLevel === 'unrestricted') return false
  const norm = String(resolvedPath || '').replace(/\\/g, '/')
  const base = basename(norm).toLowerCase()
  const masterFile = resolve(settingsKeyPath(settingsPath)).replace(/\\/g,'/')
  if (
    norm === masterFile || norm.includes('/.whalenest-secrets/') || base === '.whalenest-secrets' || base === 'settings-master.key' ||
    base === 'settings.json' ||
    base === 'bili_credential.json' ||
    base === 'skyland_config.json' ||
    base === 'cordis.patch.yml' ||
    (base==='.web-token' || /^\.env(?:[.-]|$)/.test(base))
  ) {
    return true
  }
  return false
}

/**
 * 对工具输出文本中的 API Key / Cookie / Token 进行自动掩码脱敏，防止意外打印到群聊
 */
export function redactSecrets(text = '') {
  return String(text || '')
    .replace(/\b(sk-[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]{8,}\b/g, '$1***[REDACTED]')
    .replace(/\b(AIza[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]{12,}\b/g, '$1***[REDACTED]')
    .replace(/\b(AQ\.[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]{10,}\b/g, '$1***[REDACTED]')
    .replace(/(p_skey|skey|SESSDATA|bili_jct)=([^;\s"'&]{4})[^;\s"'&]+/gi, '$1=$2***[REDACTED]')
    .replace(/("(?:deepseekApiKey|geminiApiKey|ttsApiKey|pluginVisionApiKey|websearchApiKey|embeddingApiKey|qzoneCookie|skylandToken)"\s*:\s*")([^"]{3})[^"]*(")/gi, '$1$2***[REDACTED]$3')
}

/**
 * 检查目标路径是否为受保护的核心配置或可执行插件脚本（非 unrestricted 模式下禁止模型通过 write_file 篡改自提权）
 */
export function isProtectedWritePath(resolvedPath, customSettings = null) {
  const s = customSettings || settings()
  if (s.permissionLevel === 'unrestricted') return false
  const norm = String(resolvedPath || '').replace(/\\/g, '/')
  const ws = resolve(WORKSPACE).replace(/\\/g, '/').replace(/\/$/, '')
  if (
    norm === `${ws}/settings.json` ||
    norm === `${ws}/sessions.json` ||
    norm === `${ws}/sessions-agent.json` ||
    isProtectedReadPath(resolvedPath, s)
  ) {
    return true
  }
  if (
    (norm.startsWith(`${ws}/tools/`) || norm.startsWith(`${ws}/plugins/`)) &&
    /\.(?:mjs|cjs|js|py|sh|plugin\.json)$/i.test(norm)
  ) {
    return true
  }
  return false
}

// 包管理安装命令识别
const PKG_INSTALL_CMD_RE = /(?:^|[;&|`\s])(?:npm\s+(?:i|install)|pnpm\s+(?:add|i|install)|yarn\s+add|pip3?\s+install|apt(?:-get)?\s+install|apk\s+add)\b/i

/**
 * 获取当前生效的可访问根目录列表（始终包含 WORKSPACE）
 */
export function getAuthorizedRoots(customSettings = null) {
  const s = customSettings || settings()
  const rawList = Array.isArray(s.allowedPaths)
    ? s.allowedPaths
    : String(s.allowedPaths || '').split(',').map((x) => x.trim()).filter(Boolean)
  const roots = new Set([resolve(WORKSPACE)])
  for (const p of rawList) {
    if (p) roots.add(resolve(p))
  }
  return [...roots]
}

/**
 * 校验并解析目标文件路径是否在放权允许的目录范围内
 */
function canonicalPath(input){
  let probe=resolve(input),tail=[]
  while(!existsSync(probe)){const parent=resolve(probe,'..');if(parent===probe)break;tail.unshift(basename(probe));probe=parent}
  try{return resolve(realpathSync(probe),...tail)}catch{return resolve(input)}
}
export function resolveAuthorizedPath(inputPath, customSettings = null) {
  const s = customSettings || settings()
  const raw = String(inputPath || '').trim()
  if (!raw) return resolve(WORKSPACE)

  let target = raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)
    ? resolve(normalize(raw))
    : resolve(WORKSPACE, normalize(raw).replace(/^([/\\])+/, ''))

  target=canonicalPath(target)
  if (s.permissionLevel === 'unrestricted') {
    return target
  }

  const roots=getAuthorizedRoots(s).map(canonicalPath)
  for (const r of roots) {
    if (target === r || target.startsWith(r + sep)) {
      return target
    }
  }
  return null
}

/**
 * 校验 Shell 命令是否符合当前放权级别
 */
// This detects obvious mistakes; OS isolation is required for arbitrary programs.
export function checkCommandPermission(command, customSettings = null) {
  const s = customSettings || settings()
  const c = String(command || '').trim()
  if (!c) return { ok: false, reason: '空命令' }

  if (FATAL_ROOT_CMD_RE.test(c)) {
    return { ok: false, reason: '命中底线安全保护（禁止删根分区/关机/格式化）' }
  }

  const level = s.permissionLevel || 'standard'
  if (level === 'unrestricted') {
    return { ok: true, level }
  }

  if (STANDARD_GUARD_CMD_RE.test(c)) {
    return { ok: false, reason: '命中高危系统/工作区/记忆库删除拦截规则' }
  }

  const credentialPath = /\.whalenest-secrets|settings-master\.key/i.test(c) ||
    (process.env.SETTINGS_KEY_FILE && c.includes(process.env.SETTINGS_KEY_FILE))
  if (PROTECTED_SHELL_WRITE_RE.test(c) || credentialPath) {
    return { ok: false, reason: '安全拦截：禁止在 Shell 中覆写、移动或删除系统配置文件及工具脚本' }
  }

  if (PROTECTED_SHELL_READ_RE.test(c)) {
    return { ok: false, reason: '安全拦截：禁止在 Shell 中直接读取系统凭据或密钥文件内容（自查配置请调用 read_config 工具）' }
  }

  if (EXFIL_CMD_RE.test(c)) {
    return { ok: false, reason: '命中数据外传拦截规则（POST/上传/裸 socket/命令替换外传）' }
  }

  if (level === 'standard' && !s.allowPackageInstall && PKG_INSTALL_CMD_RE.test(c)) {
    return {
      ok: false,
      reason: '当前未开启「允许安装外部依赖包」，请在 WebUI 设置 → 放权与扩展 中开启 allowPackageInstall 或切至扩展放权模式',
    }
  }

  return { ok: true, level }
}

/**
 * 解析脚本文件头部的插件元信息注释：
 * 支持：
 *   // @plugin-name: 森空岛签到
 *   // @plugin-trigger: 森空岛|方舟签到
 *   // @plugin-desc: 自动完成明日方舟森空岛每日签到
 */
function parseScriptHeaderMeta(filePath) {
  try {
    const head = readFileSync(filePath, 'utf8').slice(0, 1600)
    const pick = (key) => {
      const m = head.match(new RegExp(`@plugin-${key}\\s*[:：]\\s*(.+)`, 'i'))
      return m ? m[1].trim() : ''
    }
    const firstComment = head
      .split('\n')
      .map((l) => l.trim())
      .find((l) => (l.startsWith('//') || l.startsWith('#')) && !l.startsWith('#!'))
      ?.replace(/^(\/\/|#)\s*/, '') || ''

    return {
      name: pick('name') || basename(filePath),
      trigger: pick('trigger') || '',
      description: pick('desc') || firstComment || '自定义扩展脚本',
    }
  } catch {
    return { name: basename(filePath), trigger: '', description: '扩展脚本' }
  }
}

/**
 * 扫描 /workspace/tools 与 /workspace/plugins 下的所有固定脚本与外部插件
 */
export function scanInstalledPlugins(customWorkspace = WORKSPACE) {
  const toolsDir = join(customWorkspace, 'tools')
  const pluginsDir = join(customWorkspace, 'plugins')
  mkdirSync(toolsDir, { recursive: true })
  mkdirSync(pluginsDir, { recursive: true })

  const BUILTIN_META = {
    'skyland.mjs': {
      id: 'skyland',
      name: '森空岛每日签到 (明日方舟/终末地)',
      category: 'builtin-tool',
      command: 'node /workspace/tools/skyland.mjs sign',
      triggerHint: '问“森空岛签到 / 帮我签个到 / 今天方舟签了吗”时自动执行并回答',
      description: '基于鹰角通行证 Token / Cred 自动完成森空岛每日签到与奖励查询',
    },
    'tarot.mjs': {
      id: 'tarot',
      name: '韦特塔罗牌占卜 (78张全牌阵+绘图)',
      category: 'builtin-tool',
      command: 'node /workspace/tools/tarot.mjs draw',
      triggerHint: '问“抽张塔罗牌 / 塔罗占卜 / 算下运势”时自动抽牌、生成牌阵图并毒舌解牌',
      description: '内置完整 78 张韦特塔罗正逆位，支持单张与圣三角牌阵并自动生成 PNG 视觉卡面',
    },
    'fun-tools.mjs': {
      id: 'fun-tools',
      name: '赛博求签老黄历 & 喜加一速报',
      category: 'builtin-tool',
      command: 'node /workspace/tools/fun-tools.mjs fortune',
      triggerHint: '问“求签 / 今日运势 / 老黄历 / 喜加一”时自动调用回答',
      description: '每日固定种子赛博求签（宜/忌/幸运物）与 Epic/Steam 喜加一速报',
    },
    'bili.py': {
      id: 'bili',
      name: 'B站深度冲浪与字幕热评抓取',
      category: 'builtin-tool',
      command: '/workspace/tools/bili-venv/bin/python /workspace/tools/bili.py browse --limit 3',
      triggerHint: '发 B 站链接或说“去刷会儿视频”时自动抓取字幕与神评唠嗑',
      description: '支持 B 站热门冲浪、视频 AI 字幕提取、热评抓取与关键帧拼图',
    },
    'phone-agent.mjs': {
      id: 'phone-agent',
      name: '局域网 MuMu 安卓模拟器控制',
      category: 'builtin-tool',
      command: 'node /workspace/tools/phone-agent.mjs status',
      triggerHint: '通过 [[phone:shot]] / [[phone:app:bilibili]] 操控电脑上的安卓模拟器',
      description: '跨局域网连接电脑 MuMu 模拟器 12，支持截屏、滑动刷视频、点按与安全白名单保护',
    },
    'balance.mjs': {
      id: 'balance',
      name: 'DeepSeek 账户余额查询',
      category: 'builtin-tool',
      command: 'node /workspace/tools/balance.mjs',
      triggerHint: '问“还剩多少额度 / 还有多少钱”时查询',
      description: '只读查询当前 DeepSeek API Key 剩余赠送与充值额度',
    },
    'memewiki.mjs': {
      id: 'memewiki',
      name: '大肥鱼热梗百科词典 (astrbot_plugin_memewiki)',
      category: 'builtin-tool',
      command: 'node /workspace/tools/memewiki.mjs list',
      triggerHint: '聊天命中热梗自动注入释义与接梗示范，也可手动查询或新增词条',
      description: '内置大肥鱼/偷吃token/事已至此先吃饭吧/何意味/大祥老师等社区热梗百科',
    },
    'tts.mjs': {
      id: 'tts',
      name: '肥鱼多引擎语音合成 (feiyu_voice)',
      category: 'builtin-tool',
      command: 'node /workspace/tools/tts.mjs --json "哼，才不是大肥鱼呢"',
      triggerHint: '通过 [[tts:台词]] 或对她说“发条语音/说句话听听”触发',
      description: '支持百炼复刻、硅基流动 CosyVoice、微软 Edge 免Key傲娇少女音与离线声波保底',
    },
    'websearch.mjs': {
      id: 'websearch',
      name: 'Anysearch 实时联网搜索 (多源免Key/聚合)',
      category: 'builtin-tool',
      command: 'node /workspace/tools/websearch.mjs "关键词"',
      triggerHint: '问“搜一下/查查/最新的/什么时候开服/天气”或指令 [[search:关键词]] 时自动检索实时互联网并回答',
      description: '支持 DuckDuckGo、Bing、聚合搜索 API 与离线测试保底，带时间衰减与中文摘要提炼',
    },
    'qzone.mjs': {
      id: 'qzone',
      name: 'QQ 空间说说发布器 (onebot-qzone)',
      category: 'builtin-tool',
      command: 'node /workspace/tools/qzone.mjs history --json',
      triggerHint: '通过 [[qzone:说说内容]] 或对她说“发条说说/发个QQ空间”触发',
      description: '自动通过 NapCat get_cookies 获取 p_skey 计算 g_tk 发布图文说说并归档历史',
    },
  }

  const items = []

  // 1. 扫描 tools 目录下的固定功能脚本
  if (existsSync(toolsDir)) {
    for (const fname of readdirSync(toolsDir).sort()) {
      if (fname === 'skyland.py' || fname === 'tts.sh' || fname === 'adb-probe.sh' || fname === 'install-adb.sh') continue // 辅助脚本与主脚本合并展示
      const full = join(toolsDir, fname)
      let st
      try { st = statSync(full) } catch { continue }
      if (!st.isFile()) continue
      const ext = extname(fname).toLowerCase()
      if (!['.mjs', '.js', '.py', '.sh'].includes(ext)) continue
      const preset = BUILTIN_META[fname]
      const meta = parseScriptHeaderMeta(full)
      items.push({
        id: preset?.id || `tool_${fname.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        fileName: fname,
        path: `/workspace/tools/${fname}`,
        localPath: full,
        name: preset?.name || meta.name,
        category: preset ? '固定功能脚本 (tools)' : '自定义工具脚本 (tools)',
        command: preset?.command || (ext === '.py' ? `python3 /workspace/tools/${fname}` : ext === '.sh' ? `sh /workspace/tools/${fname}` : `node /workspace/tools/${fname}`),
        triggerHint: preset?.triggerHint || meta.trigger || '可在对话或 bash 中按需调用',
        description: preset?.description || meta.description,
        size: st.size,
        mtime: st.mtimeMs,
        removable: !preset,
      })
    }
  }

  // 2. 扫描 plugins 目录下的动态扩展插件（受 allowCustomPlugins 开关控制）
  if (settings().allowCustomPlugins !== false && existsSync(pluginsDir)) {
    for (const fname of readdirSync(pluginsDir).sort()) {
      const full = join(pluginsDir, fname)
      let st
      try { st = statSync(full) } catch { continue }
      if (!st.isFile()) continue
      const ext = extname(fname).toLowerCase()
      if (fname.endsWith('.plugin.json')) {
        try {
          const manifest = JSON.parse(readFileSync(full, 'utf8') || '{}')
          items.push({
            id: manifest.id || `plg_${fname.replace('.plugin.json', '')}`,
            fileName: fname,
            path: `/workspace/plugins/${fname}`,
            localPath: full,
            name: manifest.name || fname,
            category: '外部扩展插件 (plugins)',
            command: manifest.command || '',
            triggerHint: manifest.trigger || '按清单触发',
            description: manifest.description || '外部 JSON 清单插件',
            size: st.size,
            mtime: st.mtimeMs,
            removable: true,
          })
        } catch {}
        continue
      }
      if (!['.mjs', '.js', '.py', '.sh'].includes(ext)) continue
      const meta = parseScriptHeaderMeta(full)
      const runner = ext === '.py' ? 'python3' : ext === '.sh' ? 'sh' : 'node'
      items.push({
        id: `plg_${fname.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        fileName: fname,
        path: `/workspace/plugins/${fname}`,
        localPath: full,
        name: meta.name,
        category: '外部扩展插件 (plugins)',
        command: `${runner} /workspace/plugins/${fname}`,
        triggerHint: meta.trigger || '可在对话中直接让肥鱼调用',
        description: meta.description,
        size: st.size,
        mtime: st.mtimeMs,
        removable: true,
      })
    }
  }

  return items
}

/**
 * 安装或保存一个新的自定义插件脚本到 /workspace/plugins/
 */
export function saveCustomPluginScript({ fileName, name, trigger, description, code }, customWorkspace = WORKSPACE) {
  if (settings().allowCustomPlugins === false) {
    return { ok: false, error: '当前已关闭「启用 /workspace/plugins 动态外部插件扫描」(allowCustomPlugins=false)' }
  }
  const cleanFile = String(fileName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '')
  if (!cleanFile || !/\.(mjs|js|py|sh)$/i.test(cleanFile)) {
    return { ok: false, error: '插件文件名需以 .mjs / .js / .py / .sh 结尾' }
  }
  const pluginsDir = join(customWorkspace, 'plugins')
  mkdirSync(pluginsDir, { recursive: true })
  const dest = join(pluginsDir, cleanFile)
  const isPyOrSh = /\.(py|sh)$/i.test(cleanFile)
  const cmt = isPyOrSh ? '#' : '//'
  const rawCode = String(code || '').trim()
  const hasHeader = /@plugin-name/i.test(rawCode)
  const header = hasHeader ? '' : [
    `${cmt} @plugin-name: ${name || cleanFile}`,
    trigger ? `${cmt} @plugin-trigger: ${trigger}` : '',
    description ? `${cmt} @plugin-desc: ${description}` : '',
    '',
  ].filter((x) => x !== '').join('\n') + '\n'

  writeFileSync(dest, header + rawCode + '\n', { encoding: 'utf8', mode: 0o755 })
  log('info', `[插件扩展] 已安装自定义插件脚本：/workspace/plugins/${cleanFile}`)
  return { ok: true, path: `/workspace/plugins/${cleanFile}`, plugins: scanInstalledPlugins(customWorkspace) }
}

/**
 * 删除 /workspace/plugins/ 下的自定义插件脚本
 */
export function removeCustomPluginScript(fileName, customWorkspace = WORKSPACE) {
  const cleanFile = basename(String(fileName || '').trim())
  const target = join(customWorkspace, 'plugins', cleanFile)
  if (!existsSync(target)) return { ok: false, error: '插件文件不存在' }
  unlinkSync(target)
  log('info', `[插件扩展] 已移除自定义插件脚本：${cleanFile}`)
  return { ok: true, plugins: scanInstalledPlugins(customWorkspace) }
}

/**
 * 执行指定工具或扩展脚本（供 WebUI 一键测试或对话预取调用）
 */
export function runToolScript(scriptRelPath, args = [], timeoutMs = 35000, customWorkspace = WORKSPACE) {
  return new Promise((resolve) => {
    // v2.9.1 安全修复：越权路径直接拒绝。
    // 旧版在这里 `|| join(...)` 回落，等于把 resolveAuthorizedPath 的拦截又绕过去了
    // （tools/../../tmp/x.sh 会被拼成 /tmp/x.sh 然后执行）。
    const authorized = resolveAuthorizedPath(scriptRelPath)
    if (!authorized) {
      return resolve({ ok: false, error: `路径越权，已拒绝执行：${scriptRelPath}` })
    }
    const full = authorized
    if (!existsSync(full)) {
      return resolve({ ok: false, error: `脚本不存在：${scriptRelPath}` })
    }
    const ext = extname(full).toLowerCase()
    const bin = ext === '.py' ? 'python3' : ext === '.sh' ? 'sh' : 'node'
    execFile(bin, [full, ...args], { timeout: timeoutMs, cwd: customWorkspace, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          ok: false,
          error: err.message,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
        })
      }
      resolve({
        ok: true,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      })
    })
  })
}
