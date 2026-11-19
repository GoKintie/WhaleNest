// dsh-hand · HTTP 前门（给麦麦插件用）
// 收到任务 → runner 跑一次 dsh headless → 返回最终答案

import http from 'node:http'
import { cfg, log, runTask } from './runner.mjs'
import { appendChat, buildContext, ensureLayout, memoryRoot } from './memory.mjs'
import { parseDirectives } from './reply.mjs'

const PORT = Number(process.env.PORT || 3099)
const TOKEN = process.env.BRIDGE_TOKEN || ''

let busy = false

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length })
  res.end(buf)
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, busy, bin: cfg.bin, args: cfg.args, workdir: cfg.workdir, memory: memoryRoot })
  }

  if (req.method === 'POST' && (req.url === '/task' || req.url === '/ingest')) {
    const auth = req.headers['authorization'] || ''
    if (!TOKEN || auth !== `Bearer ${TOKEN}`) return json(res, 401, { ok: false, error: 'unauthorized' })

    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 65536) return json(res, 413, { ok: false, error: 'body too large' })
    }

    let body
    try { body = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'invalid json' }) }

    // 只写记忆，不跑任务：让麦麦把聊天流水灌进来
    if (req.url === '/ingest') {
      const text = String(body.text || '').trim()
      if (!text) return json(res, 400, { ok: false, error: 'text is empty' })
      const row = appendChat({
        role: body.role || 'user',
        name: body.name || body.id || '某人',
        text: text.slice(0, 2000),
        images: Array.isArray(body.images) ? body.images.slice(0, 9) : [],
      })
      return json(res, 200, { ok: true, row })
    }

    const task = String(body.task || '').trim()
    if (!task) return json(res, 400, { ok: false, error: 'task is empty' })
    if (task.length > cfg.maxTask) return json(res, 400, { ok: false, error: `task 超过 ${cfg.maxTask} 字` })

    if (busy) return json(res, 429, { ok: false, error: '正在跑另一个任务，稍后再试' })

    busy = true
    const t0 = Date.now()
    log('task start', JSON.stringify(task.slice(0, 120)))
    let result
    try {
      const prompt = `${buildContext()}\n\n# 本次请求\n${task}`
      result = await runTask(prompt)
    } finally {
      busy = false
    }
    log('task end', `${Date.now() - t0}ms`, result.ok ? 'ok' : `fail: ${result.error}`)

    if (!result.ok) return json(res, 500, result)
    const { text, actions } = parseDirectives(result.text)
    return json(res, 200, { ok: true, text, actions, raw: result.text })
  }

  return json(res, 404, { ok: false, error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  ensureLayout()
  log(`dsh-hand listening on :${PORT}, bin=${cfg.bin} ${cfg.args.join(' ')}`)
  log(`memory root: ${memoryRoot}`)
  if (!TOKEN) log('警告：BRIDGE_TOKEN 为空，所有 /task 请求都会被 401 挡掉')
})
