import { readFile, statfs } from 'node:fs/promises'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

function cpuTimes(cores) {
  let idle = 0
  let busy = 0
  for (const {times} of cores) {
    idle += times.idle
    busy += times.user + times.nice + times.sys + times.irq
  }
  return {idle, busy}
}

async function sampleCpu() {
  const cores = os.cpus()
  const first = cpuTimes(cores)
  await delay(300)
  const later = os.cpus()
  const second = cpuTimes(later)
  const busy = second.busy - first.busy
  const idle = second.idle - first.idle
  return {
    model: cores[0]?.model?.trim() || '',
    cores: cores.length,
    percent: cores.length === later.length && busy >= 0 && idle >= 0 && busy + idle > 0
      ? Math.round(100 * busy / (busy + idle)) : null,
  }
}

async function hostMemory() {
  const total = os.totalmem()
  // Linux MemAvailable accounts for memory the kernel can reclaim from caches.
  const meminfo = os.platform() === 'linux' ? await readFile('/proc/meminfo', 'utf8').catch(() => '') : ''
  const availableKb = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1]
  const available = availableKb ? Number(availableKb) * 1024 : os.freemem()
  const used = Math.min(total, Math.max(0, total - available))
  return {used, total, percent: total > 0 ? Math.round(100 * used / total) : null}
}

let snapshot
let sampling

export async function dashboardHost(workspace) {
  if (snapshot && Date.now() - snapshot.sampledAt < 5000) return snapshot
  if (!sampling) {
    sampling = Promise.all([sampleCpu(), hostMemory(), statfs(workspace).catch(() => null)])
      .then(([cpu, memory, disk]) => {
        snapshot = {
          sampledAt: Date.now(),
          system: {platform: os.type(), release: os.release(), arch: os.arch()},
          cpu, memory,
          storage: disk?.blocks > 0 ? {
            total: disk.blocks * disk.bsize,
            available: disk.bavail * disk.bsize,
          } : null,
        }
        return snapshot
      }).finally(() => { sampling = null })
  }
  return sampling
}

const quoteCategories = { literature: ['d', 'i'], anime: ['a', 'b'] }
const fallbackQuotes = {
  literature: [
    ['海内存知己，天涯若比邻。', '送杜少府之任蜀州', '王勃'],
    ['山重水复疑无路，柳暗花明又一村。', '游山西村', '陆游'],
    ['长风破浪会有时，直挂云帆济沧海。', '行路难·其一', '李白'],
    ['博观而约取，厚积而薄发。', '稼说送张琥', '苏轼'],
    ['往者不可谏，来者犹可追。', '论语·微子', '接舆'],
    ['既来之，则安之。', '论语·季氏', '孔子'],
  ],
  anime: [
    ['真相永远只有一个！', '名侦探柯南', '江户川柯南'],
    ['就决定是你了！', '宝可梦', '小智'],
    ['我要成为海贼王！', '航海王', '蒙奇·D·路飞'],
  ],
}
const quoteRequests = new Map()
const quoteRetryAt = new Map()

async function fetchQuote(kind) {
  const url = new URL('https://v1.hitokoto.cn/')
  const categories = quoteCategories[kind]
  for (const category of categories) url.searchParams.append('c', category)
  url.searchParams.set('max_length', '46')
  const response = await fetch(url, {signal: AbortSignal.timeout(2800), redirect: 'error'})
  if (!response.ok) return null
  const data = await response.json()
  if (!categories.includes(data.type) || typeof data.hitokoto !== 'string') return null
  const text = data.hitokoto.trim()
  if (!text || text.length > 100) return null
  return {
    kind, text, source: 'hitokoto',
    work: typeof data.from === 'string' ? data.from.trim().slice(0, 80) : '',
    author: typeof data.from_who === 'string' ? data.from_who.trim().slice(0, 80) : '',
  }
}

export async function dashboardQuote(kind) {
  kind = kind === 'anime' ? 'anime' : 'literature'
  if (!quoteRequests.has(kind) && Date.now() >= (quoteRetryAt.get(kind) || 0)) {
    const request = fetchQuote(kind).catch(() => null).then(quote => {
      quoteRetryAt.set(kind, Date.now() + (quote ? 1400 : 30_000))
      return quote
    }).finally(() => quoteRequests.delete(kind))
    quoteRequests.set(kind, request)
  }
  const remote = await quoteRequests.get(kind)
  if (remote) return remote
  const choices = fallbackQuotes[kind]
  const [text, work, author] = choices[Math.floor(Math.random() * choices.length)]
  return {kind, text, work, author, source: 'local'}
}
