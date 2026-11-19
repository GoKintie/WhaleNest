// 图库管理员与表情包人工审核中心（bridge/organize.mjs · v2.6）
//
// 核心机制：
// 1. 全局 SHA1 内容去重：无论图片是从 inbox 批量整理、群聊自动捕获、还是手动添加，只要 gallery/ 下已有相同 SHA1 的图片，绝不重复入库。
// 2. 物理尺寸与特征双重校验（isLikelyStickerBuffer）：任何分辨率过大（如 >560px 截图/照片）、长宽比极端（手机长截图/宽屏截图）或体积过大的普通图片，哪怕模型误判为 sticker，也自动降级归入「截图」或「照片」，绝不混进表情包！
// 3. 表情包入库前手动审核队列（gallery/待审核 + pending_stickers.json）：
//    当 stickerRequireReview !== false（默认开启）时，所有候选表情包一律先存进 `gallery/待审核/`，不在聊天中自动发送；
//    用户在 WebUI「学习与审核」页点「通过入库」后才正式移入 `gallery/表情包/` 并写入 `_index.md`！
// 4. 已入库表情包一键巡检（auditExistingStickers）：可随时扫描 `gallery/表情包/`，把之前混进去的大尺寸分享图/长截图一键揪出来移至 `gallery/待审核/` 或 `gallery/杂图/`。

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { current as settings } from './settings.mjs'
import { isVisionCapableModel, resolveProvider, runTask } from './runner.mjs'
import { classifyImageWithVision, isVisionPluginActive } from './vision.mjs'
import { inspectImageBuffer, isLikelyStickerBuffer } from './onebot-lib.mjs'
import { log, push } from './logbus.mjs'

const WORKSPACE = process.env.WORKDIR || '/workspace'
const INBOX = process.env.INBOX_DIR || join(WORKSPACE, 'inbox')
const GALLERY = process.env.GALLERY_DIR || join(WORKSPACE, 'gallery')
const STATE = process.env.ORGANIZE_STATE || join(WORKSPACE, 'organize-state.json')
const INDEX = join(GALLERY, 'index.jsonl')

const CATS = {
  sticker: '表情包',
  pending_sticker: '待审核',
  screenshot: '截图',
  photo: '照片',
  document: '文档',
  misc: '杂图',
}
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|bmp)$/i

function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8') || '{}') } catch { return {} }
}
function saveState(s) {
  try { writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8') } catch {}
}
let state = loadState()
if (!state.processed) state.processed = {}

export function sha1OfFile(filePath) {
  try {
    const buf = readFileSync(filePath)
    if (!buf.length) return ''
    return createHash('sha1').update(buf).digest('hex')
  } catch {
    return ''
  }
}

/**
 * 构建当前图库所有图片的内容 SHA1 映射表（sha1 -> 绝对路径，含 待审核 与 表情包 等所有子目录）
 */
export function buildGalleryHashIndex(customGallery = GALLERY) {
  const map = new Map()
  for (const f of walk(customGallery)) {
    const h = sha1OfFile(f.path)
    if (h && !map.has(h)) map.set(h, f.path)
  }
  return map
}

// ---------- 表情包待审核队列（gallery/待审核/ + pending_stickers.json）----------

function pendingMetaFile(customGallery = GALLERY) {
  mkdirSync(customGallery, { recursive: true })
  return join(customGallery, 'pending_stickers.json')
}

export function loadPendingStickers(customGallery = GALLERY) {
  const f = pendingMetaFile(customGallery)
  let list = []
  try {
    if (existsSync(f)) {
      const parsed = JSON.parse(readFileSync(f, 'utf8') || '[]')
      if (Array.isArray(parsed)) list = parsed
    }
  } catch {}
  // 同步检查 gallery/待审核/ 目录下的物理文件，防止遗漏
  const pendingDir = join(customGallery, '待审核')
  if (existsSync(pendingDir)) {
    const knownFiles = new Set(list.map((it) => basename(String(it.file || it.path || ''))))
    for (const fname of readdirSync(pendingDir)) {
      if (!IMAGE_EXT.test(fname)) continue
      if (!knownFiles.has(fname)) {
        const full = join(pendingDir, fname)
        let st
        try { st = statSync(full) } catch { continue }
        const h = sha1OfFile(full).slice(0, 16)
        list.push({
          id: `stk_${h || Date.now()}`,
          file: fname,
          path: `/workspace/gallery/待审核/${fname}`,
          localPath: full,
          sha1: h,
          name: fname.replace(/\.[a-z0-9]+$/i, ''),
          tags: ['待审核'],
          source: 'scan',
          from: '',
          chat: '',
          size: st.size,
          ts: st.mtimeMs || Date.now(),
        })
      }
    }
  }
  // 过滤掉物理文件已不存在的条目，并执行 30 天超期自动转杂图 + 200 条上限保护（P1-3）
  const MAX_PENDING_STICKERS = 200
  const PENDING_TTL_MS = 30 * 24 * 3600 * 1000
  const now = Date.now()
  const valid = []
  for (const it of list) {
    const lp = join(customGallery, '待审核', basename(String(it.file || it.path || '')))
    if (!existsSync(lp)) continue
    if (it.ts && now - Number(it.ts) > PENDING_TTL_MS) {
      try {
        const miscDir = join(customGallery, '杂图')
        mkdirSync(miscDir, { recursive: true })
        copyFileSync(lp, join(miscDir, basename(lp)))
        unlinkSync(lp)
      } catch {}
      continue
    }
    valid.push(it)
  }
  valid.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  if (valid.length > MAX_PENDING_STICKERS) {
    for (const overflow of valid.slice(MAX_PENDING_STICKERS)) {
      const lp = join(customGallery, '待审核', basename(String(overflow.file || overflow.path || '')))
      try {
        const miscDir = join(customGallery, '杂图')
        mkdirSync(miscDir, { recursive: true })
        if (existsSync(lp)) {
          copyFileSync(lp, join(miscDir, basename(lp)))
          unlinkSync(lp)
        }
      } catch {}
    }
    return valid.slice(0, MAX_PENDING_STICKERS)
  }
  return valid
}

export function savePendingStickers(list, customGallery = GALLERY) {
  try {
    writeFileSync(pendingMetaFile(customGallery), JSON.stringify(list, null, 2), 'utf8')
  } catch {}
}

/**
 * 将候选表情包加入「待审核队列」（gallery/待审核/），等待管理员在 WebUI 手动点击通过后才真正入库
 */
export function enqueuePendingSticker({ srcPath, sha1, name = '', tags = [], reason = '', source = 'organize', from = '', chat = '', customGallery = GALLERY } = {}) {
  if (!srcPath || !existsSync(srcPath)) return null
  const pendingDir = join(customGallery, '待审核')
  mkdirSync(pendingDir, { recursive: true })
  const h = (sha1 || sha1OfFile(srcPath)).slice(0, 16)
  const ext = (extname(srcPath) || '.jpg').toLowerCase()
  const fname = `cand-${h}${ext}`
  const dest = join(pendingDir, fname)

  if (!existsSync(dest)) {
    copyFileSync(srcPath, dest)
  }

  let dims = { width: 0, height: 0, bytes: 0, format: '' }
  try {
    const buf = readFileSync(dest)
    dims = inspectImageBuffer(buf) || dims
  } catch {}

  const list = loadPendingStickers(customGallery)
  let item = list.find((x) => x.sha1 === h || x.file === fname)
  if (!item) {
    const tsNow = Date.now()
    item = {
      id: `stk_${h}`,
      file: fname,
      fileName: fname,
      path: `/workspace/gallery/待审核/${fname}`,
      relPath: `待审核/${fname}`,
      localPath: dest,
      sha1: h,
      name: name || `候选表情_${h.slice(0, 6)}`,
      tags: Array.isArray(tags) && tags.length ? tags : ['群聊学习'],
      reason: reason || `群聊候选表情 (${dims.width || '?'}×${dims.height || '?'}, ${dims.format || ext.replace('.', '')})`,
      source,
      from: String(from || ''),
      chat: String(chat || ''),
      sourceGroup: String(chat || ''),
      width: dims.width || 0,
      height: dims.height || 0,
      format: dims.format || ext.replace('.', ''),
      size: dims.bytes || 0,
      ts: tsNow,
      time: new Date(tsNow).toISOString().slice(0, 16).replace('T', ' '),
    }
    list.unshift(item)
    savePendingStickers(list, customGallery)
  }
  return item
}

/**
 * 在 WebUI 审核候选表情包：
 * - action === 'approve'：移入 gallery/表情包/，写入 index.jsonl 并重建 _index.md
 * - action === 'reject_to_misc'：移入 gallery/杂图/（保留图片但不当表情包发）
 * - action === 'delete' / 'reject'：直接删除该候选图
 */
export function reviewPendingSticker({ action, id, ids, name, desc, tags, customGallery } = {}, fallbackGallery = GALLERY) {
  const effGal = customGallery || fallbackGallery || GALLERY
  const list = loadPendingStickers(effGal)
  const targetIds = new Set(Array.isArray(ids) ? ids.map(String) : (id ? [String(id)] : []))
  if (action === 'approve_all') {
    for (const it of list) targetIds.add(String(it.id))
  } else if (action === 'reject_all') {
    for (const it of list) targetIds.add(String(it.id))
  }

  const stickerDir = join(effGal, '表情包')
  let lastApprovedTo = ''
  const miscDir = join(effGal, '杂图')
  const idxFile = join(effGal, 'index.jsonl')
  mkdirSync(stickerDir, { recursive: true })

  let approvedCount = 0
  let rejectedCount = 0
  const remaining = []

  for (const item of list) {
    const matched = targetIds.has(String(item.id)) || targetIds.has(String(item.file)) || targetIds.has(String(item.sha1))
    if (!matched) {
      remaining.push(item)
      continue
    }
    const srcFile = join(effGal, '待审核', basename(String(item.file || item.path || '')))
    if (!existsSync(srcFile)) continue

    if (action === 'approve' || action === 'approve_all') {
      const ext = extname(srcFile) || '.jpg'
      const destName = basename(srcFile).replace(/^cand-/, 'sticker-')
      const dest = join(stickerDir, destName)
      try {
        copyFileSync(srcFile, dest)
        unlinkSync(srcFile)
        lastApprovedTo = dest
      } catch {
        continue
      }
      const finalName = ((name || desc) && targetIds.size === 1) ? String(name || desc).trim() : (item.name || destName.replace(ext, ''))
      const finalTags = (Array.isArray(tags) && tags.length && targetIds.size === 1)
        ? tags
        : (typeof tags === 'string' && tags.trim() && targetIds.size === 1)
          ? tags.split(/[,，/\s]+/).map((s) => s.trim()).filter(Boolean)
          : (item.tags || ['搞笑'])
      const containerDest = `/workspace/gallery/表情包/${destName}`
      const row = {
        at: Date.now(),
        from: item.path,
        to: containerDest,
        sha1: item.sha1,
        category: 'sticker',
        name: finalName,
        tags: finalTags,
        reason: item.reason || '人工审核通过入库',
        reviewed: true,
      }
      try {
        writeFileSync(idxFile, `${JSON.stringify(row)}\n`, { flag: 'a' })
      } catch {}
      approvedCount += 1
    } else if (action === 'reject_to_misc' || action === 'move_misc') {
      mkdirSync(miscDir, { recursive: true })
      const dest = join(miscDir, basename(srcFile))
      try {
        copyFileSync(srcFile, dest)
        unlinkSync(srcFile)
      } catch {}
      rejectedCount += 1
    } else {
      // reject / delete
      try { unlinkSync(srcFile) } catch {}
      rejectedCount += 1
    }
  }

  savePendingStickers(remaining, effGal)
  if (approvedCount > 0) {
    try { rebuildStickerIndex(effGal) } catch {}
  }
  return {
    ok: true,
    approvedCount,
    rejectedCount,
    to: lastApprovedTo,
    pending: remaining,
    items: remaining,
    activeStickerCount: countActiveStickers(effGal),
  }
}

export function countActiveStickers(customGallery = GALLERY) {
  const d = join(customGallery, '表情包')
  if (!existsSync(d)) return 0
  try {
    return readdirSync(d).filter((f) => IMAGE_EXT.test(f)).length
  } catch {
    return 0
  }
}

/**
 * 扫描现有 `gallery/表情包/` 目录，把不符合表情包物理规格的普通分享大图/长截图移入 `gallery/待审核/` 或 `gallery/杂图/`
 */
export function auditExistingStickers({ moveTo = '待审核', customGallery = GALLERY } = {}) {
  const stickerDir = join(customGallery, '表情包')
  if (!existsSync(stickerDir)) return { scanned: 0, demoted: 0, items: [] }
  const targetDir = join(customGallery, moveTo)
  mkdirSync(targetDir, { recursive: true })

  const files = readdirSync(stickerDir).filter((f) => IMAGE_EXT.test(f))
  const demotedItems = []

  for (const fname of files) {
    const full = join(stickerDir, fname)
    let buf
    try { buf = readFileSync(full) } catch { continue }
    const check = isLikelyStickerBuffer(buf, { subType: 0 })
    if (!check.ok) {
      if (moveTo === '待审核') {
        const item = enqueuePendingSticker({
          srcPath: full,
          name: fname.replace(/\.[a-z0-9]+$/i, ''),
          tags: ['疑似普通图片'],
          reason: `巡检发现疑似普通图片 (${check.reason}${check.info?.width ? ` ${check.info.width}x${check.info.height}` : ''})`,
          source: 'audit',
          customGallery,
        })
        if (item) {
          try { unlinkSync(full) } catch {}
          demotedItems.push({ file: fname, reason: check.reason, width: check.info?.width, height: check.info?.height })
        }
      } else {
        const dest = join(targetDir, fname)
        try {
          renameSync(full, dest)
          demotedItems.push({ file: fname, reason: check.reason, width: check.info?.width, height: check.info?.height })
        } catch {}
      }
    }
  }

  if (demotedItems.length > 0) {
    try { rebuildStickerIndex(customGallery) } catch {}
    log('info', `[表情包巡检] 已从 gallery/表情包 移出 ${demotedItems.length} 张疑似普通分享图/截图 → gallery/${moveTo}`)
  }

  return {
    scanned: files.length,
    checked: files.length,
    demoted: demotedItems.length,
    demotedCount: demotedItems.length,
    items: demotedItems,
  }
}

/**
 * 扫描并清理图库中的重复图片（保留语义命名优先、时间最早的一张，删除 -2/-3/stolen 重复副本）
 */
export function dedupeGallery(customGallery = GALLERY) {
  if (!existsSync(customGallery)) return { removed: 0, kept: 0, paths: [], droppedIndex: 0 }
  const allFiles = walk(customGallery)
  const scoreFile = (p) => {
    const n = basename(p)
    let score = 0
    if (/^cand-/i.test(n)) score += 12
    if (/^stolen-/i.test(n)) score += 10
    if (/-\d+\.[a-z0-9]+$/i.test(n)) score += 5
    return score
  }
  allFiles.sort((a, b) => scoreFile(a.path) - scoreFile(b.path) || a.mtime - b.mtime)

  const seenHash = new Map()
  const removedPaths = []
  const removedList = []

  for (const f of allFiles) {
    const h = sha1OfFile(f.path)
    if (!h) continue
    if (seenHash.has(h)) {
      const kept = seenHash.get(h)
      try {
        removedList.push({ path: f.path, keep: kept, sha1: h })
        unlinkSync(f.path)
        removedPaths.push(f.path)
      } catch {}
    } else {
      seenHash.set(h, f.path)
    }
  }

  if (removedList.length > 0) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      writeFileSync(join(customGallery, `_dedupe.${stamp}.json`), JSON.stringify(removedList, null, 2), 'utf8')
    } catch {}
  }

  // 同步清理 index.jsonl 中已不存在的死链条目（兼容 /workspace/gallery/... 容器路径与自定义路径）
  let droppedIndex = 0
  const idxFile = join(customGallery, 'index.jsonl')
  if (existsSync(idxFile)) {
    try {
      const lines = readFileSync(idxFile, 'utf8').split('\n').filter(Boolean)
      const cleanLines = []
      const seenTo = new Set()
      for (const line of lines) {
        try {
          const o = JSON.parse(line)
          const resolvedTo = o.to && String(o.to).startsWith('/workspace/gallery/')
            ? join(customGallery, String(o.to).slice('/workspace/gallery/'.length))
            : o.to
          if (o.to && !existsSync(o.to) && !existsSync(resolvedTo)) {
            droppedIndex += 1
            continue
          }
          if (o.to) {
            if (seenTo.has(o.to)) {
              droppedIndex += 1
              continue
            }
            seenTo.add(o.to)
          }
          cleanLines.push(JSON.stringify(o))
        } catch {
          cleanLines.push(line)
        }
      }
      writeFileSync(idxFile, cleanLines.join('\n') + (cleanLines.length ? '\n' : ''), 'utf8')
    } catch {}
  }

  try { rebuildStickerIndex(customGallery) } catch {}
  if (removedPaths.length && customGallery === GALLERY) {
    log('info', `[图库去重] 已清理 ${removedPaths.length} 张重复图片，同步剔除索引 ${droppedIndex} 条，当前保留唯一素材 ${seenHash.size} 张`)
  }
  return {
    removed: removedPaths.length,
    kept: seenHash.size,
    droppedIndex,
    paths: removedPaths,
  }
}

export function organizerStatus() {
  const pending = scan().length
  const pendingReview = loadPendingStickers(GALLERY).length
  const s = settings()
  return {
    enabled: s.autoOrganize !== false,
    stickerRequireReview: s.stickerRequireReview !== false,
    visionPlugin: isVisionPluginActive(s),
    pending,
    pendingReview,
    doneToday: state.day === today() ? state.count || 0 : 0,
    lastAt: state.lastAt || null,
    lastError: state.lastError || null,
    categories: Object.values(CATS),
  }
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else if (IMAGE_EXT.test(name)) out.push({ path: full, size: st.size, mtime: st.mtimeMs })
  }
  return out
}

/** 还没整理过的图片 */
export function scan() {
  return walk(INBOX).filter((f) => {
    const rec = state.processed[f.path]
    if (!rec) return true          // 没见过
    if (rec.dest || rec.deduped) return false // 已经归档过或已按 SHA1 去重跳过
    return (rec.retry || 0) < 3    // 只重试失败过的（最多 3 次）
  })
}

function uniqueDest(cat, srcName) {
  const dir = join(GALLERY, cat)
  mkdirSync(dir, { recursive: true })
  const ext = extname(srcName)
  const stem = basename(srcName, ext)
  let dest = join(dir, srcName)
  let i = 2
  while (existsSync(dest)) {
    dest = join(dir, `${stem}-${i}${ext}`)
    i += 1
  }
  return dest
}

function buildPrompt(files) {
  const list = files.map((f, i) => {
    const dimHint = f.dimInfo?.width ? ` (分辨率 ${f.dimInfo.width}x${f.dimInfo.height}, ${Math.round((f.dimInfo.bytes || 0) / 1024)}KB)` : ''
    return `${i + 1}. ${f.path}${dimHint}`
  }).join('\n')
  return [
    '你要整理收到的图片。下面这些是本地文件，用你的读图能力逐个看：',
    list,
    '',
    '【极其重要：严格区分“表情包(sticker)”与“普通图片(screenshot/photo)”！】',
    '- sticker：必须是真正的聊天表情包、Q版二次元表情、方形/近似方形带字梗图（通常尺寸较小、主体是夸张表情或搞笑配字）。',
    '- screenshot：凡是手机长截图、电脑屏幕截图、网页截图、聊天记录截图、报错日志截图、软件界面、B站/游戏界面截图，一律判为 screenshot！绝不能判成 sticker！',
    '- photo：凡是真实人物照片、风景照、随手拍的物品/美食/电脑硬件照片、高清插画壁纸，一律判为 photo！绝不能判成 sticker！',
    '- document：文档、表格、证件、票据、书页的拍摄或扫描',
    '- misc：其他杂图（图标、素材、二维码、无明显主题）',
    '',
    '只输出一个 JSON 数组，不要任何解释、不要 markdown 代码块：',
    '[{"i":1,"category":"sticker","name":"短标题(不超过8个字)","tags":["无语","猫"],"reason":"一句话"}]',
    '',
    'name 用这张图里能看见的内容写，不要写"图片1"。',
    'tags 只对 sticker 填，1~3 个词：情绪（开心/无语/嘲讽/委屈/吃惊/摆烂）+ 主体（猫/狗/动漫/文字梗），其它类别留空数组。',
  ].join('\n')
}

function parseJsonArray(text) {
  const s = String(text || '')
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a < 0 || b <= a) return null
  try {
    const arr = JSON.parse(s.slice(a, b + 1))
    return Array.isArray(arr) ? arr : null
  } catch {
    return null
  }
}

let running = false

/** 整理一批，返回 {processed, deduped, pendingReview, error} */
export async function organizeBatch(limit) {
  if (running) return { error: '上一批还在整理' }
  const s = settings()
  const batch = Math.max(1, Number(limit || s.organizeBatch || 4))
  const allPending = scan()
  if (!allPending.length) return { processed: 0, deduped: 0, message: '没有待整理的图' }

  const hashIndex = buildGalleryHashIndex(GALLERY)
  const files = []
  let dedupedCount = 0

  for (const f of allPending) {
    const h = sha1OfFile(f.path)
    if (h && hashIndex.has(h)) {
      const existingDest = hashIndex.get(h)
      state.processed[f.path] = {
        at: Date.now(),
        deduped: true,
        sha1: h.slice(0, 16),
        dest: existingDest,
      }
      dedupedCount += 1
      continue
    }
    if (h) hashIndex.set(h, f.path)
    let buf = null
    try { buf = readFileSync(f.path) } catch {}
    const stickerCheck = buf ? isLikelyStickerBuffer(buf, { subType: 0 }) : { ok: false, info: null }
    files.push({ ...f, sha1: h, stickerCheck, dimInfo: stickerCheck.info })
    if (files.length >= batch) break
  }

  if (dedupedCount > 0) {
    saveState(state)
    log('info', `[图库去重] 自动跳过 ${dedupedCount} 张与图库内容重复的 inbox 图片`)
  }

  if (!files.length) {
    return { processed: 0, deduped: dedupedCount, message: `已自动去重跳过 ${dedupedCount} 张重复图片` }
  }

  running = true
  push('organize', { phase: 'start', count: files.length })
  log('info', `整理图片 ${files.length} 张${isVisionPluginActive(s) ? '（使用外部多模态视觉插件）' : ''}…`)

  let arr = null
  try {
    if (isVisionPluginActive(s)) {
      const vResults = await Promise.all(files.map((f, idx) => classifyImageWithVision(f.path, idx + 1, s)))
      const valid = vResults.filter(Boolean)
      if (valid.length) arr = valid
    }

    if (!arr) {
      const prov = resolveProvider(s)
      const canSeeImages = prov.id === 'dsh' || isVisionCapableModel(prov.id, prov.model, s)
      if (!canSeeImages) {
        // 纯文本 API 模型（如 deepseek-chat）无法直接读取图片像素，按物理规格确定性归类，避免对着路径瞎编标签
        arr = files.map((f, idx) => {
          if (f.stickerCheck?.ok) {
            return { i: idx + 1, category: 'sticker', name: `候选表情_${(f.sha1 || '').slice(0, 6) || idx + 1}`, tags: ['待审核'], reason: '物理规格符合表情包' }
          }
          const inf = f.dimInfo || {}
          const ratio = inf.width && inf.height ? inf.width / inf.height : 1
          const cat = (ratio < 0.65 || ratio > 1.7 || inf.format === 'png') ? 'screenshot' : 'photo'
          return { i: idx + 1, category: cat, name: basename(f.path, extname(f.path)), tags: [], reason: '按物理分辨率自动归档' }
        })
      } else {
        const result = await runTask(buildPrompt(files), { tag: 'organize', disableTools: true, ephemeral: true })
        if (!result.ok) {
          state.lastError = result.error
          saveState(state)
          log('warn', `整理失败：${result.error}`)
          push('organize', { phase: 'error', error: result.error })
          return { processed: 0, deduped: dedupedCount, error: result.error }
        }
        arr = parseJsonArray(result.text)
        if (!arr) {
          state.lastError = '模型没有按 JSON 返回'
          for (const f of files) {
            const rec = state.processed[f.path] || { retry: 0 }
            rec.retry = (rec.retry || 0) + 1
            state.processed[f.path] = rec
          }
          saveState(state)
          log('warn', `整理失败：输出不是 JSON：${String(result.text).slice(0, 120)}`)
          push('organize', { phase: 'error', error: 'not-json' })
          return { processed: 0, deduped: dedupedCount, error: '模型没有按 JSON 返回' }
        }
      }
    }
  } finally {
    running = false
  }

  const latestGalleryHashes = buildGalleryHashIndex(GALLERY)
  let moved = 0
  let queuedForReview = 0

  for (const item of arr) {
    const idx = Number(item.i) - 1
    const file = files[idx]
    if (!file) continue
    const h = file.sha1 || sha1OfFile(file.path)
    if (h && latestGalleryHashes.has(h)) {
      state.processed[file.path] = { at: Date.now(), deduped: true, dest: latestGalleryHashes.get(h) }
      dedupedCount += 1
      continue
    }

    let catKey = String(item.category || 'misc').toLowerCase()
    // 物理尺寸硬拦截：如果模型判成了 sticker，但图片分辨率过大（如 >560px 截图/实拍图）或比例是手机长截图，强制修正为 screenshot 或 photo！
    if (catKey === 'sticker' && file.stickerCheck && !file.stickerCheck.ok) {
      const inf = file.dimInfo || {}
      const ratio = inf.width && inf.height ? inf.width / inf.height : 1
      catKey = (ratio < 0.65 || ratio > 1.7 || inf.format === 'png') ? 'screenshot' : 'photo'
      log('info', `[防误判拦截] ${basename(file.path)} (${inf.width || '?'}x${inf.height || '?'}) 虽被模型判为表情包，但物理规格为 ${file.stickerCheck.reason}，自动归入「${CATS[catKey]}」`)
    }

    // 凡是判定为 sticker 且开启了入库前人工审核（默认开启），一律先进 gallery/待审核/，不直接进 gallery/表情包/！
    if (catKey === 'sticker' && s.stickerRequireReview !== false) {
      const pendingItem = enqueuePendingSticker({
        srcPath: file.path,
        sha1: h,
        name: item.name || '',
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 3) : [],
        reason: item.reason || 'AI 初筛为表情包，等待人工确认入库',
        source: 'organize',
        customGallery: GALLERY,
      })
      if (pendingItem) {
        if (h) latestGalleryHashes.set(h, pendingItem.localPath)
        moved += 1
        queuedForReview += 1
        state.processed[file.path] = {
          at: Date.now(),
          category: 'pending_sticker',
          dest: pendingItem.localPath,
          sha1: h ? h.slice(0, 16) : undefined,
        }
        push('organize', { phase: 'pending_review', ...pendingItem })
      }
      continue
    }

    const cat = CATS[catKey] || CATS.misc
    const dest = uniqueDest(cat, basename(file.path))
    try {
      copyFileSync(file.path, dest)
      if (h) latestGalleryHashes.set(h, dest)
      moved += 1
      const row = {
        at: Date.now(),
        from: file.path,
        to: dest,
        sha1: h ? h.slice(0, 16) : undefined,
        category: catKey,
        name: item.name || '',
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 3) : [],
        reason: item.reason || '',
      }
      mkdirSync(GALLERY, { recursive: true })
      writeFileSync(INDEX, `${JSON.stringify(row)}\n`, { flag: 'a' })
      state.processed[file.path] = { at: Date.now(), category: catKey, dest, sha1: h ? h.slice(0, 16) : undefined }
      push('organize', { phase: 'item', ...row })
    } catch (e) {
      log('warn', `收纳失败 ${file.path}：${e.message}`)
    }
  }

  for (const f of files) {
    if (!state.processed[f.path]) {
      const rec = state.processed[f.path] || { retry: 0 }
      rec.retry = (rec.retry || 0) + 1
      state.processed[f.path] = rec
    }
  }

  if (state.day !== today()) { state.day = today(); state.count = 0 }
  state.count = (state.count || 0) + moved
  state.lastAt = Date.now()
  state.lastError = null
  saveState(state)

  try { rebuildStickerIndex() } catch (e) { log('warn', `图鉴重建失败：${e.message}`) }
  log('info', `整理完成：处理 ${moved} 张（其中 ${queuedForReview} 张候选表情包进入「待审核」队列）${dedupedCount ? `，去重跳过 ${dedupedCount} 张` : ''}`)
  push('organize', { phase: 'done', moved, queuedForReview, deduped: dedupedCount })
  return { processed: moved, queuedForReview, deduped: dedupedCount, total: files.length }
}

/** 把已审核通过的正式表情包整理成一份人可读的图鉴 */
export function rebuildStickerIndex(customGallery = GALLERY) {
  const idx = join(customGallery, 'index.jsonl')
  if (!existsSync(idx)) return null
  const byPath = new Map()
  for (const line of readFileSync(idx, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.deleted && o.path) {
      byPath.delete(String(o.path))
      continue
    }
    const resolvedTo = o.to && String(o.to).startsWith('/workspace/gallery/')
      ? join(customGallery, String(o.to).slice('/workspace/gallery/'.length))
      : o.to
    // 只收录确实位于 表情包/ 文件夹下的已通过表情包
    if (o.to && o.category === 'sticker' && (existsSync(o.to) || existsSync(resolvedTo))) {
      if (String(o.to).includes('/待审核/')) continue
      byPath.set(String(o.to), { path: o.to, name: o.name || basename(String(o.to)), tags: o.tags || [] })
    }
  }
  const items = [...byPath.values()]
  if (!items.length) return null

  const groups = new Map()
  for (const it of items) {
    const key = (it.tags && it.tags[0]) || '其它'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(it)
  }
  const lines = [
    `# 表情包图鉴（${items.length} 张）`,
    '',
    '想发的时候先看这里，挑一张合适的，用 [[emoji:路径]] 发出去；没合适的就别发。',
    '',
  ]
  for (const [tag, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`## ${tag}（${list.length}）`)
    for (const it of list) lines.push(`- ${it.name} → ${it.path}`)
    lines.push('')
  }
  const file = join(customGallery, '表情包', '_index.md')
  mkdirSync(join(customGallery, '表情包'), { recursive: true })
  writeFileSync(file, lines.join('\n'), 'utf8')
  log('info', `表情包图鉴更新：${items.length} 张`)
  return { file, count: items.length }
}

let timer = null

export function startOrganizer() {
  try { dedupeGallery() } catch (e) { log('warn', `启动图库去重异常：${e.message}`) }

  const tick = async () => {
    const s = settings()
    try {
      if (s.autoOrganize !== false && !s.paused) {
        if (state.day !== today()) { state.day = today(); state.count = 0; saveState(state) }
        const quota = Number(s.organizeDailyMax || 200)
        if ((state.count || 0) < quota) await organizeBatch(s.organizeBatch)
        else log('debug', '整理：今天配额用完了')
      }
    } catch (e) {
      log('warn', `整理异常：${e.message}`)
    }
    const wait = Math.max(1, Number(settings().organizeIntervalMin || 10))
    timer = setTimeout(tick, wait * 60_000)
  }
  timer = setTimeout(tick, 20_000)
  log('info', `图库整理排程：每 ${settings().organizeIntervalMin || 10} 分钟一批，每批 ${settings().organizeBatch || 4} 张（候选表情包需人工审核入库）`)
}

export function stopOrganizer() {
  if (timer) clearTimeout(timer)
  timer = null
}
