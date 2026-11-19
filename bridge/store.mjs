// 统一存储层（bridge/store.mjs · v3.0）
//
// 解决 v2 的老毛病：chat.jsonl / settings / 图库索引每次读写都整文件同步扫盘，
// 聊到几千条之后每次 appendChat 都要 readFileSync 一遍全量再 split，直接卡死 Event Loop。
//
// 本层做三件事：
// 1. JSON 文件：stat 指纹（mtimeMs+size）命中即走内存，未变化绝不重复解析；
// 2. JSONL 流水：常驻内存环形缓冲，append 为 O(1) 追加，不再整文件回读；
// 3. 落盘：写临时文件 + rename 原子替换，防半截文件；批量延迟合并写，防抖刷盘。
//
// 注意：外部进程（测试脚本、手工编辑）改了文件时指纹会变，这边会自动重载，行为与直读一致。

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'

const jsonCache = new Map() // path -> { mtimeMs, size, data }
const flushTimers = new Map() // path -> timer
const lineCache = new Map() // path -> { mtimeMs, size, rows }

function fingerprint(path) {
  try {
    const st = statSync(path)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

function tail(list, limit) {
  const n = Math.max(0, Number(limit) || 0)
  if (!n || list.length <= n) return list.slice()
  return list.slice(-n)
}

/** 读取 JSON 文件；命中指纹或待刷盘脏缓存直接返回缓存对象 */
export function readJson(path, fallback = null) {
  const hit = jsonCache.get(path)
  if (hit && (hit.dirty || flushTimers.has(path))) return hit.data
  const fp = fingerprint(path)
  if (hit && fp && hit.mtimeMs === fp.mtimeMs && hit.size === fp.size) return hit.data
  if (!fp) {
    // 文件不存在且无待写脏数据：清缓存，返回兜底值
    jsonCache.delete(path)
    return fallback
  }
  let data = fallback
  try {
    const raw = readFileSync(path, 'utf8')
    data = raw.trim() ? JSON.parse(raw) : fallback
  } catch {
    data = fallback
  }
  jsonCache.set(path, { ...fp, data, dirty: false })
  return data
}

/** 立即原子落盘 */
export function writeJsonNow(path, data) {
  if (flushTimers.has(path)) {
    clearTimeout(flushTimers.get(path))
    flushTimers.delete(path)
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
    const fp = fingerprint(path)
    if (fp) jsonCache.set(path, { ...fp, data, dirty: false })
  } catch (error) {
    jsonCache.set(path,{mtimeMs:-1,size:-1,data,dirty:true})
    throw new Error(`持久化失败 ${path}: ${error.message}`,{cause:error})
  }
  return data
}

/** 延迟合并落盘（同一路径 delay 内多次写只落一次，期间 readJson 始终读到最新内存态） */
export function writeJsonSoon(path, data, delay = 500) {
  jsonCache.set(path, { mtimeMs: -1, size: -1, data, dirty: true })
  if (flushTimers.has(path)) return data
  const t = setTimeout(() => {
    flushTimers.delete(path)
    const cur = jsonCache.get(path)
    if (cur) { try {writeJsonNow(path,cur.data)} catch(e) {process.stderr.write(e.message+'\n');writeJsonSoon(path,cur.data,5000)} }
  }, Math.max(0, delay))
  t.unref?.()
  flushTimers.set(path, t)
  return data
}

/** 同步冲刷全部待写文件（容器重启、测试结束、SIGTERM 时调用） */
export function flushAll() {
  for(const [path,cur] of jsonCache)if(cur.dirty && !flushTimers.has(path))writeJsonNow(path,cur.data)
  for (const [path, timer] of [...flushTimers.entries()]) {
    clearTimeout(timer)
    flushTimers.delete(path)
    const cur = jsonCache.get(path)
    if (cur) writeJsonNow(path, cur.data)
  }
  return true
}

export function invalidate(path) {
  if (flushTimers.has(path)) {
    clearTimeout(flushTimers.get(path))
    flushTimers.delete(path)
  }
  jsonCache.delete(path)
  lineCache.delete(path)
}

/** 读 JSONL 尾部若干行（内部整文件只解析一次，之后走内存） */
export function readJsonLines(path, limit = 80) {
  const fp = fingerprint(path)
  if (!fp) return []
  const hit = lineCache.get(path)
  if (hit && hit.mtimeMs === fp.mtimeMs && hit.size === fp.size) return tail(hit.rows, limit)

  const rows = []
  try {
    const raw = readFileSync(path, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line) continue
      try { rows.push(JSON.parse(line)) } catch {}
    }
  } catch {}
  lineCache.set(path, { ...fp, rows })
  return tail(rows, limit)
}

/** 追加一行 JSONL，O(1)，不整文件回读 */
export function appendJsonLine(path, row) {
  const hit = lineCache.get(path)
  const fpBefore = hit ? fingerprint(path) : null
  const cacheValidBefore = Boolean(hit && fpBefore && hit.mtimeMs === fpBefore.mtimeMs && hit.size === fpBefore.size)
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf8')
  } catch (e) { throw new Error(`聊天流水写入失败 ${path}: ${e.message}`,{cause:e}) }
  if (cacheValidBefore && hit) {
    hit.rows.push(row)
    if (hit.rows.length > 6000) hit.rows.splice(0, hit.rows.length - 4000)
    const fp = fingerprint(path)
    if (fp) { hit.mtimeMs = fp.mtimeMs; hit.size = fp.size } else lineCache.delete(path)
  } else if (hit) {
    // 追加前文件已被外部改写或切分，失效缓存，下次读取时自动从磁盘重载
    lineCache.delete(path)
  }
  return row
}

/** 统计 JSONL 行数 / 体积（滚动切分判定用） */
export function fileSize(path) {
  try { return statSync(path).size } catch { return 0 }
}

export function fileExists(path) {
  return existsSync(path)
}
