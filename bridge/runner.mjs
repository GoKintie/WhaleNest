import {imageBufferForVision} from './image-input.mjs'
import {canSendResource} from './resource-policy.mjs'
import {scheduled} from './task-scheduler.mjs'
import {conversationKey} from './context-scope.mjs'
import {createHash} from 'node:crypto'
// 统一 Agent 执行器（bridge/runner.mjs · v3.0）
//
// v2 的问题：DeepSeek 走 `dsh` 子进程、Gemini 走进程内 fetch，两套完全不同的会话机制——
// 子进程那套把 sessionId 存文件，Gemini 那套存内存 Map，一重启 Gemini 的上下文就没了，
// 切模型等于换了个失忆的人。
//
// v3 统一成一个引擎：
// 1. 两个渠道（DeepSeek 官方 API / Gemini OpenAI 兼容口）走同一套 Chat Completions + 原生 Function Calling；
// 2. 会话历史统一持久化到 workspace/sessions-agent.json（按 chatId 存 user/assistant/tool 全量消息），
//    换模型、重启容器都接着聊；
// 3. 工具由 tools.mjs 的注册表统一提供，模型自己决定调什么，执行结果原样回灌继续推理；
// 4. 没配任何 API Key 时回落到老的 `dsh` 子进程，保证存量部署不会突然哑掉。

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { log, push } from './logbus.mjs'
import { current } from './settings.mjs'
import { checkCommandPermission } from './permissions.mjs'
import { canRunShell } from './action-policy.mjs'
import { readJson, writeJsonSoon, writeJsonNow } from './store.mjs'
import { executeTool, renderAbilityCatalog, toOpenAITools, toolResultToText } from './tools.mjs'

export const cfg = {
  bin: process.env.DSH_BIN || 'dsh',
  args: (process.env.DSH_ARGS || '--profile headless').split(/\s+/).filter(Boolean),
  workdir: process.env.WORKDIR || '/workspace',
  maxOut: 400000,
}

const WORKSPACE = process.env.WORKDIR || '/workspace'
const SESSIONS_FILE = process.env.AGENT_SESSIONS_FILE || join(WORKSPACE, 'sessions-agent.json')
const MAX_HISTORY = 40

export function isSafeShellCommand(command, customSettings = null) {
  return checkCommandPermission(command, customSettings)
}

// ---------------------------------------------------------------------------
// 渠道解析
// ---------------------------------------------------------------------------

export const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek / OpenAI兼容',
    defaultBase: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat (V3)', vision: false, note: '通用对话，快' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)', vision: false, note: '深度思考推理，支持工具链' },
      { id: 'deepseek-ai/DeepSeek-V3', name: 'SiliconFlow · DeepSeek-V3', vision: false, note: '硅基流动/第三方兼容' },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'SiliconFlow · DeepSeek-R1', vision: false, note: '硅基流动/第三方推理' },
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    defaultBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.8-flash',
    models: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', vision: true, note: '便宜、活人感强' },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', vision: true, note: '更强，贵' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', vision: true, note: '老牌旗舰' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', vision: true, note: '高性价比多模态' },
    ],
  },
}

export function isReasonerModel(modelId = '') {
  return /(?:reasoner|deepseek-r1|\br1\b|qwq|o1\b|o3\b)/i.test(String(modelId || ''))
}

export function isVisionCapableModel(provId = '', modelId = '', customSettings = null) {
  if (customSettings?.llmVision === true) return true
  if (provId === 'gemini') return true
  return /(?:gemini|vl\b|vision|gpt-4o|claude-3|pixtral|qvq|omni)/i.test(String(modelId || ''))
}

/**
 * 当前生效的渠道。
 * 语义（v3.1）：
 * 1. 显式选了哪个就用哪个，缺凭据才回落；`auto` 按「模型名特征 → 有没有 Key」自动挑。
 * 2. DeepSeek / OpenAI 兼容渠道不再死锁 `model.startsWith('deepseek')`：
 *    支持 `deepseek-reasoner`、硅基流动 `deepseek-ai/DeepSeek-R1`、`Qwen/...` 等任意自定义模型 ID；
 *    `deepseek-flash` 是有效的官方模型 ID，直接保留。
 */
export function resolveProvider(customSettings = null) {
  const s = customSettings || current()
  const provider = String(s.llmProvider || 'auto').toLowerCase()
  const rawModel = String(s.model || '').trim()
  // 保留用户选择的真实模型 ID。
  const model = rawModel
  const geminiKey = String(s.geminiApiKey || process.env.GEMINI_API_KEY || '').trim()
  const deepseekKey = String(s.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '').trim()

  const pickGeminiModel = () => {
    const gm = String(s.geminiModel || '').trim()
    if (model && /^gemini-/i.test(model)) return model
    if (gm) return gm
    if (model && provider === 'gemini') return model
    return PROVIDERS.gemini.defaultModel
  }

  const pickDeepseekModel = () => {
    const configuredDm=String(s.deepseekModel||'').trim()
    const dm=configuredDm
    // 若用户在设置里专门改了 deepseekModel 且 s.model 还是默认 deepseek-chat，优先尊重 deepseekModel
    if (dm && (!model || (model === 'deepseek-chat' && dm !== 'deepseek-chat'))) return dm
    if (model && !/^gemini-/i.test(model)) return model
    if (dm) return dm
    return PROVIDERS.deepseek.defaultModel
  }

  const geminiChannel = () => ({
    id: 'gemini',
    label: 'Gemini',
    key: geminiKey,
    baseUrl: String(s.geminiBaseUrl || PROVIDERS.gemini.defaultBase).trim().replace(/\/+$/, ''),
    model: pickGeminiModel(),
    proxy: String(s.geminiProxy || s.apiProxy || '').trim(),
    effort: String(s.geminiReasoningEffort || 'none').trim(),
  })
  const deepseekChannel = () => ({
    id: 'deepseek',
    label: 'DeepSeek',
    key: deepseekKey,
    baseUrl: String(s.deepseekBaseUrl || PROVIDERS.deepseek.defaultBase).trim().replace(/\/+$/, ''),
    model: pickDeepseekModel(),
    proxy: String(s.apiProxy || '').trim(),
    effort: '',
  })
  const dshChannel = () => ({ id: 'dsh', label: 'DSH', key: '', baseUrl: '', model: rawModel || 'deepseek-chat', proxy: '', effort: '' })

  if (s.modelCatalog?.roles?.main?.model === model && model) {
    if (provider === 'gemini' && geminiKey) return {...geminiChannel(), model}
    if (provider === 'deepseek' && deepseekKey) return {...deepseekChannel(), model}
  }

  if (provider === 'gemini') return geminiKey ? geminiChannel() : dshChannel()
  if (provider === 'deepseek') return deepseekKey ? deepseekChannel() : dshChannel()
  if (provider === 'dsh') return dshChannel()

  // auto / 未设置 / 旧值
  if (/^gemini-/i.test(model) && geminiKey) return geminiChannel()
  if (deepseekKey) return deepseekChannel()
  if (geminiKey) return geminiChannel()
  return dshChannel()
}

export function isGeminiActive(customSettings = null) {
  return resolveProvider(customSettings).id === 'gemini'
}

// ---------------------------------------------------------------------------
// 会话持久化（按 chatId，跨渠道共享，换模型不丢）
// ---------------------------------------------------------------------------

const sessions = new Map()
let loaded = false

export function repairInterruptedHistory(messages=[]) {
  const repaired=[]
  for(let i=0;i<messages.length;i++){
    const m=messages[i]
    if(m?.role==='tool')continue
    repaired.push(m)
    if(m?.role==='assistant' && m.tool_calls?.length){
      const receipts=[]
      while(messages[i+1]?.role==='tool')receipts.push(messages[++i])
      for(const call of m.tool_calls){
        const result=receipts.find(x=>x.tool_call_id===call.id)
        repaired.push(result||{role:'tool',tool_call_id:call.id,name:call.function?.name,content:'进程中断：此操作结果不明，先核对实际状态，禁止自动重复执行。'})
      }
      if(i===messages.length-1)repaired.push({role:'assistant',content:'上一轮在工具执行期间中断。已记录的结果继续有效，结果不明的操作须先核对，不得自动重发。'})
    }
  }
  return repaired
}

function loadAll() {
  if (loaded) return
  loaded = true
  const data = readJson(SESSIONS_FILE, {})
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (/^(tmp-|gem-)/.test(k)) continue
      if (v && Array.isArray(v.messages)) {
        v.messages=repairInterruptedHistory(v.messages)
        if(v.activeRun){v.failedRun={...v.activeRun,error:'进程中断，操作回执可能不完整'};delete v.activeRun}
        sessions.set(k,v)
      }
    }
  }
}

function persist() {
  const obj = {}
  for (const [k, v] of sessions) {
    if (/^(tmp-|gem-)/.test(k)) continue
    obj[k] = v
  }
  writeJsonSoon(SESSIONS_FILE, obj, 700)
}

export function getAgentSession(sessionId) {
  if (!sessionId) return null
  loadAll()
  return sessions.get(String(sessionId)) || null
}

export function resetAgentSession(sessionId) {
  loadAll()
  sessions.delete(String(sessionId))
  persist()
}

export function listAgentSessions() {
  loadAll()
  return [...sessions.entries()].map(([id, v]) => ({
    id,
    turns: v.turns || 0,
    provider: v.provider || '',
    model: v.model || '',
    updatedAt: v.updatedAt || 0,
  }))
}

/**
 * 只保留最近 N 条：
 * 1. 截断后开头若不是 user（如孤立 tool 或上一轮残留的 assistant），一律剥除，确保首条非 system 恒为 user；
 * 2. 末尾若停留在未闭合的 tool 或带 tool_calls 的 assistant（如工具步数超限中止），回退剥除，防止把会话锁死在 HTTP 400。
 */
export function trimHistory(messages) {
  let list = messages.slice(-MAX_HISTORY)
  while (list.length && list[0].role !== 'user') {
    list = list.slice(1)
  }
  let strippedUnclosedToolChain = false
  while (
    list.length &&
    (list[list.length - 1].role === 'tool' ||
      (list[list.length - 1].role === 'assistant' && list[list.length - 1].tool_calls))
  ) {
    list = list.slice(0, -1)
    strippedUnclosedToolChain = true
  }
  if (strippedUnclosedToolChain && list.length && list[list.length - 1].role === 'user') {
    list = list.slice(0, -1)
  }
  return list
}

/**
 * 针对 deepseek-reasoner / R1 等推理模型的跨轮次历史净化：
 * 官方协议规定跨轮次历史不能含 reasoning_content，也不能含缺少 reasoning_content 的旧轮次 tool_calls，
 * 且 user / assistant 必须严格交替。
 */
export function sanitizeHistoryForReasoner(historyMsgs = []) {
  const out = []
  for (const m of historyMsgs) {
    if (!m || m.role === 'tool') continue
    if (m.role === 'assistant' && m.tool_calls && !String(m.content || '').trim()) continue
    const clean = { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }
    if (!clean.content.trim()) continue
    if (out.length && out[out.length - 1].role === clean.role) {
      out[out.length - 1].content += `\n${clean.content}`
    } else {
      out.push(clean)
    }
  }
  while (out.length && out[0].role !== 'user') out.shift()
  while (out.length && out[out.length - 1].role !== 'assistant') out.pop()
  return out
}

// ---------- 本地图片 Base64 注入（支持 Gemini 与任意视觉兼容模型，默认上限提升至 6 张以覆盖整批图库整理）----------
const IMAGE_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
}

export async function extractLocalImageAttachments(promptText, maxImages = 6, parsed={}) {
  const found = []
  const escapedRoot=WORKSPACE.replace(/\\/g,'/').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  const re=new RegExp(escapedRoot+"/(?:inbox|gallery|out)/[^\\s，。；、)）\"'`]+\\.(?:png|jpe?g|gif|webp)",'gi')
  let m
  while ((m = re.exec(String(promptText || ''))) !== null) {
    const p = m[0].replace(/[.,;:]+$/, '')
    if (!found.includes(p) && existsSync(p) && canSendResource(p,parsed)) {
      found.push(p)
      if (found.length >= maxImages) break
    }
  }
  const dataUrls = []
  for (const p of found) {
    try {
      const img=await imageBufferForVision(p,{maxBytes:4*1024*1024})
      if(img)dataUrls.push(`data:${img.mime};base64,${img.buffer.toString('base64')}`)
    } catch {}
  }
  return dataUrls
}

/** 追加一条消息到会话（供 onebot 把用户消息/回复同步进统一历史） */
export function appendAgentMessage(sessionId, message) {
  if (!sessionId) return null
  loadAll()
  const key = String(sessionId)
  const rec = sessions.get(key) || { messages: [], turns: 0, updatedAt: 0 }
  rec.messages = trimHistory([...rec.messages, message])
  rec.updatedAt = Date.now()
  sessions.set(key, rec)
  persist()
  return rec
}

// ---------------------------------------------------------------------------
// HTTP 层（带代理支持）
// ---------------------------------------------------------------------------

let proxyAgent = null
let proxyAgentUrl = ''
let undiciFetch = null

async function getFetch(proxy) {
  if (!proxy) return globalThis.fetch
  try {
    if (!proxyAgent || proxyAgentUrl !== proxy) {
      const mod = await import('undici').catch(()=>import('/workspace/tools/node_modules/undici/index.js'))
      proxyAgent = new mod.ProxyAgent(proxy)
      proxyAgentUrl = proxy
      undiciFetch = mod.fetch
    }
    const dispatcher = proxyAgent
    const fetchFn = undiciFetch
    return (url, init = {}) => fetchFn(url, { ...init, dispatcher })
  } catch (e) {
    log('warn', `代理不可用（${e.message}），退回直连`)
    return globalThis.fetch
  }
}

// ---------------------------------------------------------------------------
// 统一 Agent 循环
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.task 本轮用户输入
 * @param {string} [args.systemPrompt] 系统提示（人设+记忆+能力目录）
 * @param {string} [args.sessionId] 会话 id（chatId）
 * @param {object} [args.ctx] 工具执行上下文 {parsed, memoryRoot, galleryRoot}
 * @param {boolean} [args.disableTools]
 */
export function runAgentTask(args) {
  const id=args.sessionId && args.ctx?.parsed?.kind ? conversationKey(args.ctx.parsed) : args.sessionId
  const lane=id || `ephemeral:${Date.now()}:${Math.random()}`
  return scheduled(lane,()=>runAgentInner({...args,sessionId:id}))
}
async function runAgentInner({ task, systemPrompt = '', sessionId = '', ctx = {}, opts = {} }) {
  const s = opts.customSettings || current()
  const prov = resolveProvider(s)
  if (prov.id === 'dsh') {
    if (!canRunShell(ctx.parsed, s)) return {
      ok: false, text: '', provider: 'dsh', error: 'DSH CLI 需要完全放权，仅限管理员 QQ 私聊或 Web 对话',
    }
    const result = await runDshCli([systemPrompt,'# 本轮用户输入',task].filter(Boolean).join('\n\n'),{...opts,sessionId})
    return {...result, model:prov.model, modelFailure:result.ok ? undefined : 'error'}
  }

  const fetchFn = await getFetch(prov.proxy)
  const endpoint = prov.baseUrl.endsWith('/chat/completions') ? prov.baseUrl : `${prov.baseUrl}/chat/completions`
  const isEphemeral = !sessionId || /^(tmp-|gem-)/.test(String(sessionId)) || opts.ephemeral === true
  const key = sessionId || `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  loadAll()
  const rec = isEphemeral
    ? { messages: [], turns: 0, createdAt: Date.now() }
    : (sessions.get(String(key)) || { messages: [], turns: 0, createdAt: Date.now() })
  rec.provider = prov.id
  rec.model = prov.model

  const maxSteps = Math.max(1, Number(opts.maxSteps ?? s.agentMaxSteps ?? 8))
  const timeoutMs = Math.min(300000, Math.max(20000, Number(s.timeoutMs || 180000)))
  // 后台无 sessionId 的临时任务（写日记、更新印象、静默归档、图片整理）若未显式开启工具，默认禁用工具防止后台乱调动作
  const useTools = opts.disableTools !== undefined
    ? !opts.disableTools
    : (!isEphemeral && s.agentTools !== false)
  const isReasoner = isReasonerModel(prov.model)
  const isVision = isVisionCapableModel(prov.id, prov.model, s)

  const usage = { inputTokens: 0, outputTokens: 0, total_tokens: 0 }
  const toolLog = []
  const artifacts=[]
  const taskHash=createHash('sha256').update(task).digest('hex')
  const runId=ctx.requestId || (rec.failedRun?.taskHash===taskHash?rec.failedRun.runId:`${key}:${Date.now()}:${Math.random()}`)
  rec.activeRun={taskHash,runId,at:Date.now()}
  let text = ''

  // 工具定义已通过 payload.tools (OpenAI Function Schema) 传入，不再在 systemPrompt 中重复塞入 1577 字的 renderAbilityCatalog，单步立省 ~930 token
  const sysBlock = String(systemPrompt || '').trim()

  const imageUrls = isVision ? await extractLocalImageAttachments(task, 6,ctx.parsed||{}) : []
  const userContent = imageUrls.length
    ? [{ type: 'text', text: task }, ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : task
  const baseHistory = isReasoner ? sanitizeHistoryForReasoner(rec.messages) : rec.messages
  const userMsgIndex = baseHistory.length
  const working = [...baseHistory, { role: 'user', content: userContent }]

  // 落盘前把多模态内容还原成纯文本、剥除同轮次临时 reasoning_content，且不持久化 tmp/gem 幽灵会话
  const commitHistory = (final=true) => {
    if (isEphemeral) return
    const persisted = working.map((m, i) => {
      if (i === userMsgIndex) return { role: 'user', content: task }
      if (m && m.reasoning_content !== undefined) {
        const { reasoning_content: _rc, ...rest } = m
        return rest
      }
      return m
    })
    rec.messages = final ? trimHistory(persisted) : persisted
    if(final) rec.turns=(rec.turns||0)+1
    rec.updatedAt = Date.now()
    sessions.set(String(key), rec)
    if(final)persist()
    else writeJsonNow(SESSIONS_FILE,Object.fromEntries(sessions))
  }

  const failed = (error, modelFailure) => {
    delete rec.activeRun
    rec.failedRun={taskHash,runId,error,at:Date.now()}
    // Close every advertised call, including calls never executed after an error.
    const advertised=working.filter(m=>m.tool_calls).flatMap(m=>m.tool_calls)
    for(const call of advertised)if(!working.some(m=>m.role==='tool'&&m.tool_call_id===call.id))working.push({role:'tool',tool_call_id:call.id,name:call.function?.name,content:'未执行：本轮中断'})
    working.push({role:'assistant',content:`本轮中断：${error}。已完成动作：${toolLog.filter(x=>x.ok).map(x=>x.name).join('、')||'无'}；不得将已完成动作自动重做。`})
    commitHistory()
    return {ok:false,text,sessionId:key,provider:prov.id,model:prov.model,usage,toolLog,artifacts,error,modelFailure}
  }
  for (let step = 0; step < maxSteps; step++) {
    const messages = [...(sysBlock ? [{ role: 'system', content: sysBlock }] : []), ...working]

    const baseMaxTokens = Number(s.maxReplyTokens || 1600)
    const payload = {
      model: prov.model,
      messages,
      max_tokens: isReasoner ? Math.max(4096, baseMaxTokens) : baseMaxTokens,
    }
    if (!isReasoner) {
      payload.temperature = Number(s.temperature ?? 0.78)
    }
    if (useTools) payload.tools = toOpenAITools(null, { parsed: ctx.parsed || {}, config: s })
    // Gemini 思考预算：argon/pro 不能归零
    if (prov.id === 'gemini' && prov.effort) {
      payload.reasoning_effort = /argon|pro/i.test(prov.model) ? 'low' : prov.effort
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res, data
    try {
      res = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${prov.key}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      data = await res.json().catch(() => ({}))
    } catch (e) {
      clearTimeout(timer)
      const timeout = e?.name === 'AbortError' || e?.name === 'TimeoutError'
      return failed(timeout ? `请求超时（${timeoutMs}ms）` : `网络异常：${e?.message||e}`, timeout ? 'timeout' : 'error')
    } finally {
      clearTimeout(timer)
    }

    // 有的渠道或推理模型不支持 tools：第一次就报工具相关错误时，关掉工具重跑
    if (!res.ok && useTools && step === 0 && /tool|function|reasoning_content|not support/i.test(JSON.stringify(data))) {
      log('warn', `${prov.label} (${prov.model}) 不支持工具调用，本次降级为纯对话`)
      return runAgentInner({ task, systemPrompt, sessionId:key, ctx, opts:{...opts,disableTools:true} })
    }
    if (!res.ok) {
      const errMsg = data?.error?.message || data?.message || `HTTP ${res.status}`
      return failed(`${prov.label} 报错：${errMsg}`, 'error')
    }

    if (data?.usage) {
      const inTok = Number(data.usage.prompt_tokens || data.usage.input_tokens || 0)
      const outTok = Number(data.usage.completion_tokens || data.usage.output_tokens || 0)
      usage.inputTokens += inTok
      usage.outputTokens += outTok
      usage.total_tokens += inTok + outTok
      push('status', { phase: 'step_end', step: step + 1, usage, tag: opts.tag })
    }

    const msg = data?.choices?.[0]?.message
    if(!msg)return failed('返回格式为空', 'error')

    if (msg.reasoning_content) {
      push('thinking', { text: String(msg.reasoning_content).trim().slice(0, 1000), tag: opts.tag })
    }

    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    if(calls.length && !useTools)return failed('模型返回了未授权的工具调用，已拒绝执行')
    if(calls.length>12)return failed('单步工具调用数量超出限制')
    if (!calls.length) {
      text = String(msg.content || '').trim()
      break
    }

    // 同轮次内保留 msg.reasoning_content（DeepSeek R1 调工具时必传，否则下一步报 400 Missing reasoning_content）
    const assistantTurnMsg = {
      role: 'assistant',
      content: msg.content || '',
      tool_calls: calls,
    }
    if (msg.reasoning_content !== undefined) {
      assistantTurnMsg.reasoning_content = msg.reasoning_content || ''
    }
    working.push(assistantTurnMsg)
    commitHistory(false)

    for (const tc of calls) {
      const name = tc?.function?.name || ''
      let args = {}
      try {
        args = JSON.parse(tc?.function?.arguments || '{}')
      } catch { args = null }
      push('thinking', { text: `调用工具 ${name}(${JSON.stringify(args).slice(0, 160)})`, tag: opts.tag })
      const r = args === null ? { ok: false, error: '工具参数格式无效' } : await executeTool(name,args,{...ctx,runId,disabled:!useTools})
      toolLog.push({name,args,ok:r.ok,error:r.error,artifacts:r.artifacts||[]})
      for(const a of r.artifacts||[])if(!artifacts.some(x=>x.path===a.path))artifacts.push(a)
      working.push({ role: 'tool', tool_call_id: tc.id, name, content: toolResultToText(r) })
      commitHistory(false)
      push('thinking', { text: `工具 ${name} → ${r.ok ? 'OK' : 'FAIL'}${r.ok ? '' : `：${r.error}`}`, tag: opts.tag })
    }

    if (step === maxSteps - 1) {
      return failed(`工具调用超过 ${maxSteps} 步仍未收敛`)
    }
  }

  working.push({ role:'assistant',content:text })
  delete rec.activeRun
  delete rec.failedRun
  commitHistory()

  return {
    ok: Boolean(text),
    text,
    sessionId: key,
    provider: prov.id,
    model: prov.model,
    usage,
    toolLog, artifacts,
    error: text ? undefined : '模型返回空内容',
    modelFailure: text ? undefined : 'error',
  }
}

// ---------------------------------------------------------------------------
// 兼容旧接口
// ---------------------------------------------------------------------------

/** Gemini 专用入口（保留给 WebUI 连通性测试与老调用点） */
export async function runGeminiTask(task, opts = {}) {
  const s = current()
  // v3.0.1：merged 真的传下去了（v3.0.0 算了却没用，等于自定义 Key/模型全被忽略）
  const merged = {
    ...s,
    llmProvider: 'gemini',
    geminiApiKey: String(opts.apiKey ?? s.geminiApiKey ?? ''),
    geminiBaseUrl: String(opts.baseUrl ?? s.geminiBaseUrl ?? ''),
    model: String(opts.model ?? (String(s.model || '').startsWith('gemini-') ? s.model : 'gemini-3.8-flash')),
  }
  return runAgentTask({
    task,
    systemPrompt: typeof opts.systemPrompt === 'string' ? opts.systemPrompt : '',
    sessionId: opts.sessionId && String(opts.sessionId).startsWith('gem-') ? opts.sessionId : `gem-${Date.now()}`,
    ctx: opts.ctx || {},
    opts: {
      disableTools: opts.disableTools,
      tag: opts.tag,
      maxSteps: opts.maxSteps || 1,
      customSettings: merged,
    },
  })
}

export async function testGeminiConnection(customSettings = null, opts = {}) {
  const s = { ...current(), ...(customSettings || {}) }
  if (!String(s.geminiApiKey || '').trim()) return { ok: false, text: '', error: '未填 Gemini API Key' }
  const base = String(s.geminiBaseUrl || PROVIDERS.gemini.defaultBase).replace(/\/+$/, '')
  const model = String(s.geminiModel || s.model || PROVIDERS.gemini.defaultModel)
  const fetchFn = await getFetch(String(s.geminiProxy || s.apiProxy || '').trim())
  try {
    const res = await fetchFn(base.endsWith('/chat/completions') ? base : `${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${String(s.geminiApiKey).trim()}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '用一句话打个招呼' }],
        max_tokens: 60,
      }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, text: '', error: data?.error?.message || `HTTP ${res.status}` }
    return { ok: true, text: String(data?.choices?.[0]?.message?.content || '').trim(), model }
  } catch (e) {
    return { ok: false, text: '', error: e?.message || String(e) }
  }
}

/** 老的 dsh 子进程通道：只在没配任何 API Key 时兜底 */
function runDshCli(task, opts = {}) {
  const s = current()
  const args = [...cfg.args, '--json']
  if (opts.sessionId && !String(opts.sessionId).startsWith('gem-')) args.push('--session-id', opts.sessionId)
  args.push(task)

  return new Promise((resolve) => {
    let done = false
    let timer = null
    let buf = ''
    let finalText = ''
    let acc = ''
    let sessionId = opts.sessionId
    let usage = null
    let err = ''

    const finish = (payload) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve({ sessionId, usage, provider: 'dsh', ...payload })
    }

    let child
    try {
      child = spawn(cfg.bin, args, { cwd: cfg.workdir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return finish({ ok: false, text: '', error: `spawn 失败：${e.message}` })
    }

    const handleEvent = (ev) => {
      if (!ev || typeof ev !== 'object') return
      if (ev.type === 'session' && ev.sessionId) {
        sessionId = ev.sessionId
        push('session', { sessionId, cwd: ev.cwd })
      } else if (ev.type === 'thinking') {
        if (ev.text) push('thinking', { text: ev.text, tag: opts.tag })
      } else if (ev.type === 'text') {
        if (ev.text) {
          acc += ev.text
          push('text', { text: ev.text, tag: opts.tag })
        }
      } else if (ev.type === 'status') {
        if (ev.usage) usage = ev.usage
        push('status', { phase: ev.phase, turn: ev.turn, step: ev.step, usage: ev.usage, tag: opts.tag })
      } else if (ev.type === 'final') {
        finalText = ev.text || ''
      } else if (ev.type === 'error') {
        push('log', { level: 'error', msg: `dsh error: ${ev.message || JSON.stringify(ev)}` })
      }
    }

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        try { handleEvent(JSON.parse(line)) } catch { push('raw', { text: line.slice(0, 2000) }) }
      }
    })

    child.stderr.on('data', (d) => {
      const chunk = d.toString('utf8')
      err = (err + chunk).slice(-8000)
      for (const line of chunk.split('\n')) {
        const t = line.trim()
        if (t.startsWith('dsh:')) push('log', { level: 'debug', msg: t.slice(0, 500) })
      }
    })

    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({ ok: false, text: acc, error: `超时（${s.timeoutMs} ms），已强杀`, stderr: err })
    }, s.timeoutMs)

    child.on('error', (e) => finish({ ok: false, text: acc, error: `无法启动 ${cfg.bin}：${e.message}` }))
    child.on('close', (code) => {
      const text = (finalText || acc || '').trim()
      if (code === 0 && text) return finish({ ok: true, text, code })
      finish({ ok: false, code, text, error: code === 0 ? 'dsh 正常退出但没有输出' : `dsh 退出码 ${code}`, stderr: err })
    })
  })
}

export async function testDeepseekConnection(customSettings = null) {
  const s = { ...current(), ...(customSettings || {}) }
  const key = String(s.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '').trim()
  if (!key) return { ok: false, text: '', error: '未填 DeepSeek / OpenAI 兼容 API Key' }
  const base = String(s.deepseekBaseUrl || PROVIDERS.deepseek.defaultBase).replace(/\/+$/, '')
  const rawModel = String(s.deepseekModel || s.model || PROVIDERS.deepseek.defaultModel).trim()
  const model = (!rawModel || rawModel === 'deepseek-flash' || /^gemini-/i.test(rawModel))
    ? (s.deepseekModel || PROVIDERS.deepseek.defaultModel)
    : rawModel
  const fetchFn = await getFetch(String(s.apiProxy || '').trim())
  try {
    const res = await fetchFn(base.endsWith('/chat/completions') ? base : `${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '用一句话打个招呼' }],
        max_tokens: isReasonerModel(model) ? 512 : 60,
      }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, text: '', error: data?.error?.message || `HTTP ${res.status}`, model }
    const msg = data?.choices?.[0]?.message || {}
    return {
      ok: true,
      text: String(msg.content || msg.reasoning_content || '').trim(),
      model,
    }
  } catch (e) {
    return { ok: false, text: '', error: e?.message || String(e), model }
  }
}

let discoveredModels = []

export async function fetchServiceModels({ baseUrl, apiKey, proxy }) {
  let endpoint
  try { endpoint = new URL(baseUrl) }
  catch { throw Error('服务商接口地址格式错误') }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '') + '/models'
  const fetchFn = await getFetch(proxy)
  let response
  try {
    response = await fetchFn(endpoint, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    })
  } catch (error) {
    if (error.name === 'TimeoutError') throw Error('获取模型列表超时')
    throw Error('无法连接到服务商的模型列表接口')
  }
  if (response.status === 401 || response.status === 403) throw Error('服务商拒绝访问，请检查 API Key 和权限')
  if (response.status === 404 || response.status === 405) throw Error('该接口未提供模型列表')
  if (response.status === 429) throw Error('获取模型列表遇到服务商限流，请稍后重试')
  if (!response.ok) throw Error(`获取模型列表失败（HTTP ${response.status}）`)
  const payload = await response.json().catch(() => null)
  const entries = payload?.data ?? payload?.models
  if (!Array.isArray(entries)) throw Error('服务商返回的模型列表格式不受支持')
  const ids = new Set()
  for (const entry of entries) {
    const id = String(entry?.id || entry?.name || '').trim().replace(/^models\//, '')
    if (/^[a-zA-Z0-9._:/-]{1,200}$/.test(id)) ids.add(id)
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

/** 从当前配置的 DeepSeek / OpenAI 兼容口或 Gemini 口动态探测可用模型列表 */
export async function fetchRemoteModels(customSettings = null) {
  const s = { ...current(), ...(customSettings || {}) }
  const found = []
  const seen = new Set()
  const add = (id, name, provider) => {
    const clean = String(id || '').trim().replace(/^models\//, '')
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    found.push({
      id: clean,
      name: name || clean,
      provider,
      vision: isVisionCapableModel(provider, clean, s),
    })
  }

  const dsKey = String(s.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '').trim()
  if (dsKey) {
    const base = String(s.deepseekBaseUrl || PROVIDERS.deepseek.defaultBase).replace(/\/+$/, '')
    const fetchFn = await getFetch(String(s.apiProxy || '').trim())
    try {
      const res = await fetchFn(`${base}/models`, {
        headers: { authorization: `Bearer ${dsKey}` },
        signal: AbortSignal.timeout(8000),
      })
      const data = await res.json().catch(() => ({}))
      for (const m of data?.data || data?.models || []) {
        if (m?.id) add(m.id, `${m.id}`, 'deepseek')
      }
    } catch {}
  }

  const gemKey = String(s.geminiApiKey || process.env.GEMINI_API_KEY || '').trim()
  if (gemKey) {
    const base = String(s.geminiBaseUrl || PROVIDERS.gemini.defaultBase).replace(/\/+$/, '')
    const fetchFn = await getFetch(String(s.geminiProxy || s.apiProxy || '').trim())
    try {
      const res = await fetchFn(`${base}/models`, {
        headers: { authorization: `Bearer ${gemKey}` },
        signal: AbortSignal.timeout(8000),
      })
      const data = await res.json().catch(() => ({}))
      for (const m of data?.data || data?.models || []) {
        const id = m?.id || m?.name
        if (id) add(id, `${String(id).replace(/^models\//, '')}`, 'gemini')
      }
    } catch {}
  }

  if (found.length) discoveredModels = found
  return listModels(s)
}

/** 对外主入口：渠道无关 */
let modelFailureNotifier
export function setModelFailureNotifier(notify) { modelFailureNotifier = notify }

export function runTask(task, opts = {}) {
  const systemPrompt = typeof opts.systemPrompt === 'string' ? opts.systemPrompt : ''
  const ctx = opts.ctx || {}
  const run = runAgentTask({ task, systemPrompt, sessionId: opts.sessionId, ctx, opts })
  if (!opts.notifyModelFailure) return run
  return run.then(result => {
    if (result.modelFailure && modelFailureNotifier) {
      void Promise.resolve().then(() => modelFailureNotifier(result)).catch(() => log('warn', '主模型故障通知发送失败'))
    }
    return result
  })
}

export function listModels(customSettings = null) {
  const s = customSettings || current()
  const base = [
    ...PROVIDERS.deepseek.models,
    ...PROVIDERS.gemini.models,
    ...discoveredModels,
  ]
  const seen = new Set()
  const out = []
  for (const m of base) {
    if (!m?.id || seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  for (const customId of [s?.model, s?.deepseekModel, s?.geminiModel]) {
    const cid = String(customId || '').trim()
    if (cid && !seen.has(cid)) {
      seen.add(cid)
      out.unshift({ id: cid, name: `${cid} (自定义)`, vision: isVisionCapableModel('', cid, s), note: '自定义模型' })
    }
  }
  return out
}

export { log }
