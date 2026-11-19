#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve as _resolvePath } from 'node:path'
// MuMu 安卓模拟器 / Android ADB 远程控制与真玩手机执行器（/workspace/tools/phone-agent.mjs · v2.8）
//
// v2.8 核心升级：
// 1. 全程持久化详细日志：每一次连接探测、ADB 握手、前台包名检查、UI 树解析、滑动/点击动作与报错堆栈，全部实时写入 /workspace/logs/phone-adb.log 与 bridge.log，再也不会“找不到玩手机日志”！
// 2. 新增 `play` / `surf` 复合真玩手机模式（如 `play:bilibili` / `play:tieba` / `play`）：
//    自动完成「连接模拟器 → 启动目标 App（若指定）→ 刷一屏/点进感兴趣内容 → 提取画面文字元素 → 截屏回传」，让肥鱼真正在模拟器里冲浪看内容！
// 3. 扩充 SAFE_PACKAGES 白名单（涵盖 MuMu 桌面、系统 UI、设置、常见娱乐 App），消除在桌面点击图标时的误拦截。

import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { readSettings } from './settings-reader.mjs'
import net from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const WORKSPACE = process.env.WORKDIR || '/workspace'
const OUT_DIR = process.env.PHONE_OUT_DIR || join(WORKSPACE, 'out')
const LOG_DIR = process.env.LOG_DIR || join(WORKSPACE, 'logs')
const MAX_SCREENSHOTS = 20

export function writePhoneLog(level, msg) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const line = `${new Date().toISOString()} [PHONE:${level.toUpperCase()}] ${msg}\n`
    appendFileSync(join(LOG_DIR, 'phone-adb.log'), line, 'utf8')
    appendFileSync(join(LOG_DIR, 'bridge.log'), line, 'utf8')
  } catch {}
}

export const SAFE_PACKAGES = [
  'tv.danmaku.bili',
  'com.bilibili.app.in',
  'com.ss.android.ugc.aweme',
  'com.xingin.xhs',
  'com.baidu.tieba',
  'com.zhihu.android',
  'com.sina.weibo',
  'com.taptap',
  'com.hypergryph.arknights',
  'com.hypergryph.skland',
  'com.miHoYo.Yuanshen',
  'com.miHoYo.hkrpg',
  'com.miHoYo.Nap',
  'com.android.browser',
  'com.android.chrome',
  'mark.via',
  // 模拟器默认桌面 Launcher 与系统界面允许点击图标启动应用
  'com.android.launcher',
  'com.android.launcher3',
  'com.mumu.launcher',
  'com.netease.mumu.cloner',
  'com.netease.nemu.android.launcher',
  'com.android.systemui',
  'com.google.android.apps.nexuslauncher',
]

function resolveEndpoint() {
  const s = readSettings()
  let ep = String(process.env.PLUGIN_PHONE_ENDPOINT || s.pluginPhoneEndpoint || '').trim()
  if (!ep) return ''
  ep = ep.replace(/^adb:\/\//i, '').trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ep)) {
    ep = `${ep}:16384`
  }
  return ep
}

const APP_PACKAGES = {
  bilibili: 'tv.danmaku.bili',
  'b站': 'tv.danmaku.bili',
  '哔哩哔哩': 'tv.danmaku.bili',
  douyin: 'com.ss.android.ugc.aweme',
  '抖音': 'com.ss.android.ugc.aweme',
  xiaohongshu: 'com.xingin.xhs',
  '小红书': 'com.xingin.xhs',
  qq: 'com.tencent.mobileqq',
  wechat: 'com.tencent.mm',
  '微信': 'com.tencent.mm',
  tieba: 'com.baidu.tieba',
  '贴吧': 'com.baidu.tieba',
  zhihu: 'com.zhihu.android',
  '知乎': 'com.zhihu.android',
  weibo: 'com.sina.weibo',
  '微博': 'com.sina.weibo',
  taptap: 'com.taptap',
  arknights: 'com.hypergryph.arknights',
  '明日方舟': 'com.hypergryph.arknights',
  skland: 'com.hypergryph.skland',
  '森空岛': 'com.hypergryph.skland',
  genshin: 'com.miHoYo.Yuanshen',
  '原神': 'com.miHoYo.Yuanshen',
  starrail: 'com.miHoYo.hkrpg',
  '崩铁': 'com.miHoYo.hkrpg',
  '星穹铁道': 'com.miHoYo.hkrpg',
  browser: 'com.android.browser',
  '浏览器': 'com.android.browser',
}

const KEY_CODES = {
  HOME: '3',
  BACK: '4',
  CALL: '5',
  ENDCALL: '6',
  VOLUME_UP: '24',
  VOLUME_DOWN: '25',
  POWER: '26',
  CAMERA: '27',
  CLEAR: '28',
  ENTER: '66',
  DEL: '67',
  BACKSPACE: '67',
  MENU: '82',
  SEARCH: '84',
  MEDIA_PLAY_PAUSE: '85',
  PAGE_UP: '92',
  PAGE_DOWN: '93',
  ESCAPE: '111',
  APP_SWITCH: '187',
  RECENTS: '187',
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function adbAsync(ep, args = [], timeout = 15000, encoding = 'utf8') {
  const fullArgs = ep ? ['-s', ep, ...args] : args
  const { stdout, stderr } = await execFileP('adb', fullArgs, {
    timeout,
    encoding,
    maxBuffer: 25 * 1024 * 1024,
  })
  return { stdout, stderr }
}

async function checkAdbBinary() {
  try {
    const { stdout } = await adbAsync('', ['version'], 5000, 'utf8')
    return { ok: true, version: String(stdout || '').split('\n')[0] }
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return {
        ok: false,
        error: '容器内未检测到 adb 命令。请在宿主机执行: docker exec -u 0 dsh-onebot sh -c "sed -i \'s#deb.debian.org#mirrors.tuna.tsinghua.edu.cn#g\' /etc/apt/sources.list.d/debian.sources 2>/dev/null; apt-get update -qq && apt-get install -y -qq --no-install-recommends adb"',
      }
    }
    return { ok: false, error: e?.message || String(e) }
  }
}

function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    let done = false
    const finish = (ok, err) => {
      if (done) return
      done = true
      try { sock.destroy() } catch {}
      resolve({ ok, err: err || '' })
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false, 'timeout'))
    sock.once('error', (e) => finish(false, e?.code || e?.message || 'error'))
  })
}

async function adbState(ep) {
  const r = await adbAsync('', ['devices'], 8000, 'utf8').catch(() => ({ stdout: '' }))
  const line = String(r.stdout || '').split('\n').find((l) => l.trim().startsWith(ep))
  if (!line) return 'absent'
  return line.trim().split(/\s+/)[1] || 'unknown'
}

async function connectAndWait(ep, waitMs = 8000) {
  const connRes = await adbAsync('', ['connect', ep], 12000, 'utf8').catch((e) => ({ stdout: '', stderr: e.message }))
  writePhoneLog('info', `adb connect ${ep} -> stdout="${String(connRes.stdout || '').trim()}" stderr="${String(connRes.stderr || '').trim()}"`)
  const t0 = Date.now()
  let state = 'absent'
  while (Date.now() - t0 < waitMs) {
    state = await adbState(ep)
    if (state === 'device') return 'device'
    await sleep(600)
  }
  return state
}

async function ensureConnected(ep) {
  if (!ep) {
    throw new Error('未配置模拟器/手机 ADB 地址（请在 WebUI「设置与插件 → 记忆归档与插件」填写电脑局域网 IP:端口，如 192.0.2.20:16400 或 192.0.2.20:16384）')
  }
  const chk = await checkAdbBinary()
  if (!chk.ok) throw new Error(chk.error)

  const m = String(ep).match(/^(.+):(\d+)$/)
  if (!m) throw new Error(`ADB 地址格式不对：${ep}（应形如 192.0.2.20:16400）`)
  const host = m[1]
  const port = Number(m[2])

  const probe = await tcpProbe(host, port, 3000)
  writePhoneLog('info', `TCP 探测 ${host}:${port} -> ok=${probe.ok}${probe.err ? ` err=${probe.err}` : ''}`)
  if (!probe.ok) {
    throw new Error(
      `连不上 ${ep}：TCP ${probe.err}。排查建议：①确认电脑上的 MuMu 模拟器已启动；` +
      `②确认电脑端已配置 netsh portproxy 端口转发（如 16400 -> 127.0.0.1:16384）；③确认 Windows 防火墙已放行该端口。`
    )
  }

  let state = await connectAndWait(ep, 8000)
  if (state === 'device') return 'device'

  for (let round = 1; round <= 2 && state !== 'device'; round++) {
    writePhoneLog('warn', `ADB 状态为 ${state}，执行第 ${round} 次 disconnect 重连…`)
    await adbAsync('', ['disconnect', ep], 8000, 'utf8').catch(() => ({}))
    await sleep(500 * round)
    state = await connectAndWait(ep, 8000)
  }
  if (state === 'device') return 'device'

  if (state === 'unauthorized') {
    throw new Error(`${ep} 需要授权：请在模拟器屏幕弹窗中点击「允许 USB 调试」（勾选一律允许）后重试。`)
  }
  throw new Error(
    `TCP 端口已通，但 ADB 握手未就绪（状态=${state}）。请确认：①MuMu 模拟器已完全进入桌面；②模拟器设置中 ADB 调试已开启。`
  )
}

async function getScreenSize(ep) {
  try {
    const { stdout } = await adbAsync(ep, ['shell', 'wm', 'size'], 6000)
    const m = String(stdout || '').match(/(\d+)x(\d+)/)
    if (m) return { width: Number(m[1]), height: Number(m[2]) }
  } catch {}
  return { width: 1080, height: 1920 }
}

async function getCurrentPackage(ep) {
  try {
    const { stdout } = await adbAsync(ep, ['shell', 'dumpsys', 'window'], 6000)
    const lines = String(stdout || '').split('\n')
    for (const line of lines) {
      if (line.includes('mCurrentFocus') || line.includes('mFocusedApp')) {
        const m = line.match(/([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\//)
        if (m) return m[1]
      }
    }
  } catch {}
  return ''
}

async function assertSafeForeground(ep, settingsObj = {}) {
  if (settingsObj.pluginPhoneAllowAllApps === true) return
  const pkg = await getCurrentPackage(ep)
  if (!pkg) return
  const allowed = new Set([...SAFE_PACKAGES, ...(Array.isArray(settingsObj.pluginPhoneSafePackages) ? settingsObj.pluginPhoneSafePackages : [])])
  if (!allowed.has(pkg)) {
    writePhoneLog('warn', `安全护栏拦截前台包名: ${pkg} (若需放行全部应用可在 WebUI 勾选“允许控制所有应用”)`)
    throw new Error(`安全拦截：当前前台应用 (${pkg}) 不在允许操控白名单 SAFE_PACKAGES 内（可在 WebUI 勾选「允许控制所有应用」解除限制）`)
  }
}

export function pruneOldScreenshots(outDir = OUT_DIR, maxKeep = MAX_SCREENSHOTS) {
  if (!existsSync(outDir)) return 0
  const shots = readdirSync(outDir)
    .filter((n) => /^phone-.*\.png$/.test(n))
    .sort()
  let removed = 0
  for (const old of shots.slice(0, Math.max(0, shots.length - maxKeep))) {
    try {
      unlinkSync(join(outDir, old))
      removed += 1
    } catch {}
  }
  return removed
}

async function takeScreenshot(ep) {
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `phone-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`)
  try {
    const { stdout } = await adbAsync(ep, ['exec-out', 'screencap', '-p'], 15000, 'buffer')
    if (stdout && stdout.length > 100 && stdout[0] === 0x89 && stdout[1] === 0x50) {
      writeFileSync(outPath, stdout)
      pruneOldScreenshots(OUT_DIR, MAX_SCREENSHOTS)
      writePhoneLog('info', `截屏成功 (${stdout.length} bytes) -> ${outPath}`)
      return outPath
    }
  } catch (e) {
    writePhoneLog('warn', `exec-out screencap 失败，切换 sdcard pull 备用通道: ${e.message}`)
  }

  await adbAsync(ep, ['shell', 'screencap', '-p', '/sdcard/__dsh_screen.png'], 10000)
  await adbAsync(ep, ['pull', '/sdcard/__dsh_screen.png', outPath], 10000)
  if (existsSync(outPath)) {
    pruneOldScreenshots(OUT_DIR, MAX_SCREENSHOTS)
    writePhoneLog('info', `备用通道截屏成功 -> ${outPath}`)
    return outPath
  }
  throw new Error('截屏失败：未能从模拟器获取有效 PNG 数据')
}

async function dumpUiElements(ep) {
  await adbAsync(ep, ['shell', 'rm', '-f', '/sdcard/__dsh_ui.xml'], 5000).catch(() => {})
  await adbAsync(ep, ['shell', 'uiautomator', 'dump', '/sdcard/__dsh_ui.xml'], 12000).catch(() => {})
  const { stdout } = await adbAsync(ep, ['exec-out', 'cat', '/sdcard/__dsh_ui.xml'], 10000).catch(() => ({ stdout: '' }))
  const xml = String(stdout || '')
  if (!xml.includes('<node')) return []

  const items = []
  const nodeRe = /<node\b([^>]+?)\/?>/g
  let m
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1]
    const textMatch = attrs.match(/\btext="([^"]*)"/)
    const descMatch = attrs.match(/\bcontent-desc="([^"]*)"/)
    const boundsMatch = attrs.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    const clickableMatch = attrs.match(/\bclickable="true"/)
    if (!boundsMatch) continue
    const label = (textMatch?.[1] || descMatch?.[1] || '').trim()
    if (!label && !clickableMatch) continue
    const x1 = Number(boundsMatch[1]), y1 = Number(boundsMatch[2])
    const x2 = Number(boundsMatch[3]), y2 = Number(boundsMatch[4])
    if (x2 <= x1 || y2 <= y1) continue
    const cx = Math.round((x1 + x2) / 2)
    const cy = Math.round((y1 + y2) / 2)
    if (label) {
      items.push({ label: label.slice(0, 32), x: cx, y: cy, bounds: `[${x1},${y1}][${x2},${y2}]` })
    }
  }
  const seen = new Set()
  return items.filter((it) => {
    const k = `${it.label}@${Math.round(it.x / 20)},${Math.round(it.y / 20)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).slice(0, 60)
}

async function main() {
  const rawArg = process.argv.slice(2).join(' ').trim() || 'shot'
  if (rawArg === '--self-check') {
    console.log('phone-agent self-check ok')
    return
  }
  const s = readSettings()
  const ep = resolveEndpoint()
  writePhoneLog('info', `收到玩手机指令: "${rawArg}" | 目标地址: "${ep || '未配置'}"`)

  try {
    const connMsg = await ensureConnected(ep)
    const size = await getScreenSize(ep)

    const [cmdRaw, ...rest] = rawArg.split(':')
    const cmd = cmdRaw.trim().toLowerCase()
    const param = rest.join(':').trim()

    if (cmd === 'status' || cmd === 'connect' || cmd === 'test') {
      const shot = await takeScreenshot(ep)
      const pkg = await getCurrentPackage(ep)
      const ui = (await dumpUiElements(ep)).slice(0, 20)
      const msg = `已连接模拟器 ${ep} (${size.width}x${size.height}${pkg ? `, 当前应用=${pkg}` : ''}) · ${connMsg}`
      writePhoneLog('info', `${msg} | UI元素数=${ui.length}`)
      console.log(msg)
      if (ui.length) {
        console.log(`当前屏幕文字/按钮: ${ui.map((u) => `[${u.label} (${u.x},${u.y})]`).join(' ')}`)
      }
      console.log(shot)
      return
    }

    // 新增：复合自主玩手机模式 (play / surf)
    if (cmd === 'play' || cmd === 'surf' || cmd === 'browse') {
      const appKey = param.toLowerCase().trim()
      const targetPkg = APP_PACKAGES[appKey] || ''
      const stepsLog = []
      if (targetPkg) {
        if (!SAFE_PACKAGES.includes(targetPkg) && s.pluginPhoneAllowAllApps !== true) {
          throw new Error(`安全拦截：应用包名 ${targetPkg} 不在 SAFE_PACKAGES 白名单中`)
        }
        await adbAsync(ep, ['shell', 'monkey', '-p', targetPkg, '-c', 'android.intent.category.LAUNCHER', '1'], 10000)
        stepsLog.push(`启动应用 ${param}(${targetPkg})`)
        await sleep(2500)
      }
      await assertSafeForeground(ep, s)
      const cx = Math.round(size.width / 2)
      const y1 = Math.round(size.height * 0.74)
      const y2 = Math.round(size.height * 0.28)
      await adbAsync(ep, ['shell', 'input', 'swipe', String(cx), String(y1), String(cx), String(y2), '380'], 8000).catch(() => {})
      stepsLog.push(`下滑刷新屏幕内容 (${cx},${y1})->(${cx},${y2})`)
      await sleep(1400)
      const pkg = await getCurrentPackage(ep)
      const ui = (await dumpUiElements(ep)).slice(0, 24)
      const shot = await takeScreenshot(ep)
      const summary = `已在模拟器(${ep})执行玩手机动作 [${stepsLog.join(' → ')}]，当前前台=${pkg || '桌面'}`
      writePhoneLog('info', `${summary} | 提取到屏幕文字: ${ui.map((u) => u.label).join(' / ')}`)
      console.log(summary)
      if (ui.length) {
        console.log(`屏幕上看到的内容与可点坐标: ${ui.map((u) => `"${u.label}"(tap:${u.x},${u.y})`).join(' | ')}`)
      }
      console.log(shot)
      return
    }

    if (cmd === 'shot' || cmd === 'screen' || cmd === 'screenshot') {
      const shot = await takeScreenshot(ep)
      console.log(shot)
      return
    }

    if (cmd === 'ui' || cmd === 'dump') {
      const ui = await dumpUiElements(ep)
      const shot = await takeScreenshot(ep)
      writePhoneLog('info', `导出 UI 树成功: 共 ${ui.length} 个可交互元素`)
      console.log(`屏幕尺寸: ${size.width}x${size.height}`)
      console.log(`可点击文字与中心坐标 (共 ${ui.length} 个):`)
      console.log(ui.map((u) => `- "${u.label}" → tap:${u.x},${u.y}`).join('\n'))
      console.log(shot)
      return
    }

    if (cmd === 'app' || cmd === 'open' || cmd === 'launch') {
      const key = param.toLowerCase()
      const pkg = APP_PACKAGES[key] || param
      if (!pkg) throw new Error('未指定应用名或包名')
      if (!SAFE_PACKAGES.includes(pkg) && s.pluginPhoneAllowAllApps !== true) {
        throw new Error(`安全拦截：应用包名 ${pkg} 不在 SAFE_PACKAGES 白名单中`)
      }
      await adbAsync(ep, ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], 10000)
      await sleep(2400)
      const ui = (await dumpUiElements(ep)).slice(0, 18)
      const shot = await takeScreenshot(ep)
      writePhoneLog('info', `已启动应用 ${param} (${pkg}) | 屏幕元素=${ui.length}`)
      console.log(`已启动应用 ${param} (${pkg})`)
      if (ui.length) console.log(`当前屏幕可见内容: ${ui.map((u) => `"${u.label}"(tap:${u.x},${u.y})`).join(' ')}`)
      console.log(shot)
      return
    }

    if (cmd === 'tap' || cmd === 'click') {
      await assertSafeForeground(ep, s)
      const parts = param.split(/[,，\s]+/).map(Number).filter(Number.isFinite)
      if (parts.length < 2) throw new Error(`点击坐标格式错误: ${param}，应为 tap:x,y`)
      await adbAsync(ep, ['shell', 'input', 'tap', String(Math.round(parts[0])), String(Math.round(parts[1]))], 8000)
      await sleep(1200)
      const shot = await takeScreenshot(ep)
      writePhoneLog('info', `已点击坐标 (${parts[0]}, ${parts[1]})`)
      console.log(`已点击 (${parts[0]}, ${parts[1]})`)
      console.log(shot)
      return
    }

    if (cmd === 'swipe' || cmd === 'scroll') {
      await assertSafeForeground(ep, s)
      const pLower = param.toLowerCase()
      let x1, y1, x2, y2, dur = 350
      const cx = Math.round(size.width / 2)
      const cy = Math.round(size.height / 2)
      if (pLower === 'down' || pLower === 'next' || pLower === 'up_swipe') {
        x1 = cx; y1 = Math.round(size.height * 0.76); x2 = cx; y2 = Math.round(size.height * 0.24)
      } else if (pLower === 'up' || pLower === 'prev') {
        x1 = cx; y1 = Math.round(size.height * 0.24); x2 = cx; y2 = Math.round(size.height * 0.76)
      } else if (pLower === 'left') {
        x1 = Math.round(size.width * 0.82); y1 = cy; x2 = Math.round(size.width * 0.18); y2 = cy
      } else if (pLower === 'right') {
        x1 = Math.round(size.width * 0.18); y1 = cy; x2 = Math.round(size.width * 0.82); y2 = cy
      } else {
        const nums = param.split(/[,，\s]+/).map(Number).filter(Number.isFinite)
        if (nums.length < 4) throw new Error(`滑动参数错误: ${param}，支持 scroll:down / scroll:up 或 swipe:x1,y1,x2,y2,ms`)
        ;[x1, y1, x2, y2] = nums
        if (nums[4]) dur = nums[4]
      }
      await adbAsync(ep, ['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(dur)], 8000)
      await sleep(1200)
      const ui = (await dumpUiElements(ep)).slice(0, 15)
      const shot = await takeScreenshot(ep)
      writePhoneLog('info', `已滑动 (${x1},${y1}) -> (${x2},${y2}) | 屏幕元素=${ui.length}`)
      console.log(`已滑动 (${x1},${y1}) → (${x2},${y2})`)
      if (ui.length) console.log(`滑动后屏幕内容: ${ui.map((u) => `"${u.label}"`).join(' | ')}`)
      console.log(shot)
      return
    }

    if (cmd === 'text' || cmd === 'input') {
      await assertSafeForeground(ep, s)
      if (!param) throw new Error('输入文字为空')
      if (/^[\x20-\x7e]+$/.test(param)) {
        const escaped = param.replace(/ /g, '%s').replace(/['"\\`$&|;<>()]/g, '\\$&')
        await adbAsync(ep, ['shell', 'input', 'text', escaped], 8000)
      } else {
        await adbAsync(ep, ['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_TEXT', '--es', 'msg', param], 8000).catch(() => {})
        await adbAsync(ep, ['shell', 'cmd', 'clipboard', 'set-text', param], 5000).catch(() => {})
        await adbAsync(ep, ['shell', 'input', 'keyevent', '279'], 5000).catch(() => {})
      }
      await sleep(1000)
      const shot = await takeScreenshot(ep)
      writePhoneLog('info', `已输入文字: "${param}"`)
      console.log(`已输入文本: ${param}`)
      console.log(shot)
      return
    }

    if (cmd === 'key' || cmd === 'press') {
      const kUpper = param.toUpperCase()
      const code = KEY_CODES[kUpper] || param
      await adbAsync(ep, ['shell', 'input', 'keyevent', String(code)], 6000)
      await sleep(900)
      const shot = await takeScreenshot(ep)
      writePhoneLog('info', `已按键: ${param} (${code})`)
      console.log(`已按键: ${param} (${code})`)
      console.log(shot)
      return
    }

    if (cmd === 'back' || cmd === 'home' || cmd === 'enter') {
      const code = KEY_CODES[cmd.toUpperCase()]
      await adbAsync(ep, ['shell', 'input', 'keyevent', code], 6000)
      await sleep(900)
      const shot = await takeScreenshot(ep)
      writePhoneLog('info', `已执行系统键: ${cmd}`)
      console.log(`已按键: ${cmd}`)
      console.log(shot)
      return
    }

    if (cmd === 'shell') {
      if (s.pluginPhoneAllowShell !== true) {
        throw new Error('安全拦截：原始 shell 子命令默认禁用（如需启用请在 settings.json 设置 pluginPhoneAllowShell: true）')
      }
      const { stdout } = await adbAsync(ep, ['shell', ...param.split(/\s+/)], 12000)
      await sleep(1000)
      const shot = await takeScreenshot(ep)
      if (stdout) console.log(String(stdout).trim())
      console.log(shot)
      return
    }

    if (APP_PACKAGES[cmd]) {
      const targetPkg = APP_PACKAGES[cmd]
      if (!SAFE_PACKAGES.includes(targetPkg) && s.pluginPhoneAllowAllApps !== true) {
        throw new Error(`安全拦截：应用包名 ${targetPkg} 不在 SAFE_PACKAGES 白名单中`)
      }
      await adbAsync(ep, ['shell', 'monkey', '-p', targetPkg, '-c', 'android.intent.category.LAUNCHER', '1'], 10000)
      await sleep(2200)
    }
    const shot = await takeScreenshot(ep)
    console.log(shot)
  } catch (e) {
    const errMsg = e?.message || String(e)
    writePhoneLog('error', `指令 "${rawArg}" 执行失败: ${errMsg}`)
    console.error(`[phone-agent 错误] ${errMsg}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(_resolvePath(process.argv[1])).href) {
  void main()
}
