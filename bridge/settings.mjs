// 可在 WebUI 里改的运行参数（落盘 workspace/settings.json，改完立即生效 · v2.8）

import { join } from 'node:path'
import {isSecretKey, readSettingsDocument, writeSettingsDocument} from './settings-secrets.mjs'
import {migrateWechatSelection} from './channel-contacts.mjs'

const workspaceRoot = process.env.WORKDIR || '/workspace'
export const settingsPath = process.env.SETTINGS_FILE || join(workspaceRoot, 'settings.json')

export const SECRET_MASK = '********'

export function publicSettings(input = null) {
  const out = JSON.parse(JSON.stringify(input || current()))
  const redacted = []
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return
    for (const key of Object.keys(obj)) {
      const value = obj[key]
      if (isSecretKey(key) && String(value ?? '').trim()) {
        obj[key] = SECRET_MASK
        redacted.push(key)
      } else if (value && typeof value === 'object') walk(value)
    }
  }
  walk(out)
  if (redacted.length) out.redactedSecrets = redacted
  return out
}

export function sanitizeSettingsPatch(patch = {}, clearSecrets = []) {
  const out = patch && typeof patch === 'object' ? { ...patch } : {}
  const clear = new Set((Array.isArray(clearSecrets) ? clearSecrets : []).map(String).filter(isSecretKey))
  delete out.clearSecrets
  delete out.redactedSecrets
  for (const key of Object.keys(out)) {
    if (!isSecretKey(key)) continue
    if (clear.has(key)) { out[key] = ''; continue }
    const value = String(out[key] ?? '')
    if (!value || value === SECRET_MASK) delete out[key]
  }
  for (const key of clear) out[key] = ''
  return out
}

const DEFAULTS = {
  ownerUsers: (process.env.OWNER_USERS || '').split(',').map(x=>x.trim()).filter(Boolean),
  memoryIdentityLinks: [],
  allowAnyone: process.env.ALLOW_ANYONE === 'true',
  speakingStyle: 'natural', personalityText: '', replyStyleText: '', responseExamples: '',
  groupFollowUpEnabled: true, groupFollowUpMs: 150000, groupFollowUpMaxTurns: 4,
  debounceTypingGapMs: 4500, debounceGroupMs: 6500, debounceMediaMs: 7000,
  wechatEnabled: false, wechatMode: 'onebot', wechatWsUrl: 'ws://wechat-linux:3001',
  wechatToken: '', allowWechatUsers: [], allowWechatGroups: [],
  ttsVoiceCute: '', ttsVoiceGentle: '', ttsCloudModel: '',
  allowLegacyDirectives: true,

  model: process.env.DSH_MODEL || 'deepseek-flash',
  modelFailureNotifyQQ: '',
  // auto = 按模型前缀与已配 Key 自动挑渠道；显式写 dsh/deepseek/gemini 则严格按它走
  llmProvider: process.env.LLM_PROVIDER || 'auto', // 'auto' | 'deepseek' | 'gemini' | 'dsh'
  // v3：DeepSeek 官方 API 渠道（与 Gemini 共用同一套 Agent 循环与会话历史）
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiBaseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  // none=彻底关思考（省钱、不截断）；low/medium/high=给对应预算
  geminiReasoningEffort: process.env.GEMINI_REASONING_EFFORT || 'none',
  // 出海代理（容器内 Node 不认 HTTPS_PROXY，走 undici ProxyAgent）；留空=直连
  geminiProxy: process.env.GEMINI_PROXY || '',
  apiProxy: process.env.API_PROXY || '',
  // v3：Agent 循环参数
  agentTools: (process.env.AGENT_TOOLS || 'true') !== 'false',
  agentMaxSteps: Number(process.env.AGENT_MAX_STEPS || 8),
  temperature: Number(process.env.TEMPERATURE || 0.78),
  maxReplyTokens: Number(process.env.MAX_REPLY_TOKENS || 1600),
  botName: process.env.BOT_NAME || '小鲸鱼',
  // v2.8 升级：默认切为 feiyu_tone（大肥鱼·傲娇松弛群友版 [dsh-fish-tone 融合]，三分傲娇嘴硬+七分松弛随和，不再用力过猛乱喷）
  personaPreset: process.env.PERSONA_PRESET || 'feiyu_tone', // 'feiyu_tone' | 'game_bro' | 'bili_humanism' | 'mowan' | 'tieba'
  paused: false,
  debounceMs: Number(process.env.DEBOUNCE_MS || 4500),
  debounceMaxWaitMs: Number(process.env.DEBOUNCE_MAX_MS || 32000),
  debounceSmart: true,
  followUpWindowMs: Number(process.env.FOLLOW_UP_WINDOW_MS || 25000),
  ackDelayMs: Number(process.env.ACK_DELAY_MS || 45000),
  ackOnlyTask: true,
  ackText: process.env.ACK_TEXT || '收到，我在弄了，稍等。',
  replyChunk: Number(process.env.REPLY_CHUNK || 75),
  casualMaxChars: Number(process.env.CASUAL_MAX_CHARS || 55),
  chunkGapMs: Number(process.env.CHUNK_GAP_MS || 750),
  timeoutMs: Number(process.env.TIMEOUT_MS || 300000),
  contextMessages: Number(process.env.CONTEXT_MESSAGES || 80),
  contextChars: Number(process.env.CONTEXT_CHARS || 36000),
  atOnly: (process.env.AT_ONLY || 'true') !== 'false',
  recordSilent: true,
  allowUsers: (process.env.ALLOW_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
  allowGroups: (process.env.ALLOW_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean),
  autoAllowNewFriends: (process.env.AUTO_ALLOW_NEW_FRIENDS || 'false') === 'true',
  learnGroups: (process.env.LEARN_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean),
  learnAllGroups: (process.env.LEARN_ALL_GROUPS || 'false') === 'true',
  styleLearnEnabled: (process.env.STYLE_LEARN || 'true') !== 'false',
  styleRequireReview: (process.env.STYLE_REQUIRE_REVIEW || 'true') !== 'false',
  styleSampleCount: Number(process.env.STYLE_SAMPLE_COUNT || 10),
  stickerWeight: Number(process.env.STICKER_WEIGHT || 0.18),
  stickerCooldownTurns: Number(process.env.STICKER_COOLDOWN_TURNS || 3),
  stickerLearnFreq: (process.env.STICKER_LEARN_FREQ || 'true') !== 'false',
  stickerAutoSteal: (process.env.STICKER_AUTO_STEAL || 'true') !== 'false',
  stickerRequireReview: (process.env.STICKER_REQUIRE_REVIEW || 'true') !== 'false',
  crossWindowAnyone: false,
  behaviorStyleText: '',
  crossWindowEnabled: (process.env.CROSS_WINDOW || 'true') !== 'false',
  globalStreamCount: Number(process.env.GLOBAL_STREAM_COUNT || 10),
  promptTemplate: process.env.PROMPT_TEMPLATE || '',
  targets: {},
  resumeSession: true,
  sessionMaxTurns: Number(process.env.SESSION_MAX_TURNS || 12),
  sessionMaxTokens: Number(process.env.SESSION_MAX_TOKENS || 48000),
  sessionAutoCompact: (process.env.SESSION_AUTO_COMPACT || 'true') !== 'false',
  sessionNotifyInChat: (process.env.SESSION_NOTIFY_CHAT || 'false') === 'true',
  galleryDir: 'gallery',
  diaryEnabled: true,
  impressionEnabled: true,
  impressionActiveTopN: Number(process.env.IMPRESSION_TOP_N || 8),
  diaryAt: '23:30',
  autoOrganize: true,
  organizeBatch: 4,
  organizeIntervalMin: 10,
  organizeDailyMax: 200,
  groupChimeInEnabled: (process.env.GROUP_CHIME_IN || 'true') !== 'false',
  groupChimeInCooldownMin: Number(process.env.GROUP_CHIME_IN_COOLDOWN_MIN || 6),
  // v3：默认收敛到 0.35（v2 的 0.58 太吵）；填 0 就是彻底闭嘴，不再被概率地板强行拉起来
  groupChimeInProb: Number(process.env.GROUP_CHIME_IN_PROB || 0.35),
  proactiveEnabled: false,
  proactiveMinGapMin: 35,
  proactiveMaxGapMin: 80,
  proactiveQuietMin: 15,
  proactiveProb: 0.45,
  proactiveDailyMax: 8,
  proactiveChat: '',
  quietStart: '23:30',
  quietEnd: '08:00',
  // 外部多模态视觉识图插件
  pluginVisionEnabled: (process.env.PLUGIN_VISION || 'false') === 'true',
  pluginVisionBaseUrl: process.env.PLUGIN_VISION_BASE_URL || 'https://api.siliconflow.cn/v1',
  pluginVisionApiKey: process.env.PLUGIN_VISION_API_KEY || '',
  pluginVisionModel: process.env.PLUGIN_VISION_MODEL || 'Qwen/Qwen2.5-VL-72B-Instruct',
  // 局域网 MuMu 模拟器 / ADB 手机控制接口
  pluginPhoneEnabled: (process.env.PLUGIN_PHONE || 'false') === 'true',
  pluginPhoneEndpoint: process.env.PLUGIN_PHONE_ENDPOINT || '',
  pluginPhoneAllowAllApps: (process.env.PLUGIN_PHONE_ALLOW_ALL || 'false') === 'true',
  // v3.4 升级：肥鱼语音 (feiyu_voice) 双接口架构（云端 API + 局域网本地 PC CosyVoice3/RVC 推理服务）
  pluginTtsEnabled: (process.env.PLUGIN_TTS || 'true') !== 'false',
  pluginTtsCommand: process.env.PLUGIN_TTS_CMD || '/workspace/tools/tts.sh',
  ttsMode: process.env.TTS_MODE || 'auto', // 'auto' (优先本地PC，离线回退云端) | 'local_pc' (仅局域网本地PC) | 'cloud' (仅云端接口)
  ttsLocalUrl: process.env.TTS_LOCAL_URL || '',
  ttsLocalKey: process.env.TTS_LOCAL_KEY || '',
  ttsStyle: process.env.TTS_STYLE || 'auto', // 'cute' (可爱·默认) | 'gentle' (温柔)
  ttsCaptionEnable: (process.env.TTS_CAPTION || 'true') !== 'false',
  ttsProvider: process.env.TTS_PROVIDER || 'auto', // 'auto' | 'edge' | 'dashscope' | 'siliconflow' | 'openai'
  ttsVoice: process.env.TTS_VOICE || 'zh-CN-XiaoyiNeural',
  ttsApiKey: process.env.TTS_API_KEY || '',
  ttsApiUrl: process.env.TTS_BASE_URL || '',
  ttsBaseUrl: process.env.TTS_BASE_URL || '',
  ttsModel: process.env.TTS_MODEL || '',
  ttsSpeed: Number(process.env.TTS_SPEED || 1.05),
  ttsAutoProb: Number(process.env.TTS_AUTO_PROB || 0),
  ttsAutoReplyProb: Number(process.env.TTS_AUTO_PROB || 0),
  // v2.8 升级：QQ 空间说说 (QZone) 插件默认开启（自动向 NapCat 取 Cookie 或使用自定义 Cookie）
  pluginQzoneEnabled: (process.env.PLUGIN_QZONE || 'true') !== 'false',
  qzoneCookie: process.env.QZONE_COOKIE || '',
  qzoneUin: process.env.QZONE_UIN || '',
  qzoneAutoSyncDiary: (process.env.QZONE_AUTO_DIARY || 'false') === 'true',
  // v2.9 升级：Anysearch 实时联网搜索插件配置（多源免Key/DuckDuckGo/Bing/聚合API）
  websearchEnabled: (process.env.WEBSEARCH_ENABLED || "true") !== "false",
  websearchProvider: process.env.WEBSEARCH_PROVIDER || "auto", // "auto" | "duckduckgo" | "bing" | "custom"
  websearchApiKey: process.env.WEBSEARCH_API_KEY || "",
  websearchBaseUrl: process.env.WEBSEARCH_BASE_URL || "",
  websearchLimit: Number(process.env.WEBSEARCH_LIMIT || 4),
  // v2.9 升级：chat_plus 读空气氛围感知与 LivingMemory 长期记忆生命周期开关
  atmospherePerception: (process.env.ATMOSPHERE_PERCEPTION || "true") !== "false",
  livingMemoryEnabled: (process.env.LIVING_MEMORY || "true") !== "false",
  // v3.2 升级：联想记忆树 Embedding 向量与启发式回忆配置
  embeddingEnabled: (process.env.EMBEDDING_ENABLED || "true") !== "false",
  embeddingProvider: process.env.EMBEDDING_PROVIDER || "auto", // "auto" | "local" | "siliconflow" | "openai"
  embeddingApiKey: process.env.EMBEDDING_API_KEY || "",
  embeddingBaseUrl: process.env.EMBEDDING_BASE_URL || "https://api.siliconflow.cn/v1",
  embeddingModel: process.env.EMBEDDING_MODEL || "BAAI/bge-m3",
  // 外部生图
  pluginDrawEnabled: (process.env.PLUGIN_DRAW || 'false') === 'true',
  pluginDrawCommand: process.env.PLUGIN_DRAW_CMD || 'node /workspace/tools/draw.mjs',
  // 附带固定功能脚本与工作区放权配置
  skylandToken: process.env.SKYLAND_TOKEN || '',
  skylandAutoSign: (process.env.SKYLAND_AUTO_SIGN || 'false') === 'true',
  permissionLevel: process.env.PERMISSION_LEVEL || 'standard',
  allowedPaths: (process.env.ALLOWED_PATHS || '').split(',').map((s) => s.trim()).filter(Boolean),
  allowPackageInstall: (process.env.ALLOW_PKG_INSTALL || 'false') === 'true',
  // v2.9.1 说明：这里保持默认开启。它是「插件功能总开关」而非「执行开关」，
  // 改成 false 会连带让 scanInstalledPlugins / saveCustomPluginScript 全失效（测试也会红）。
  // 真正的加固放在执行侧：runToolScript 越权直接拒绝（见 permissions.mjs）。
  allowCustomPlugins: (process.env.ALLOW_CUSTOM_PLUGINS || 'true') !== 'false',
}

let cached = null

function read() {
  return readSettingsDocument(settingsPath,{migrate:true})
}

function normalizeTargetsMap(targets) {
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) return {}
  const out = {}
  for (const [id, raw] of Object.entries(targets)) {
    if (!raw || typeof raw !== 'object') continue
    out[String(id)] = {
      ...raw,
      proactive: raw.proactive === true,
    }
  }
  return out
}

export function current() {
  if (!cached) {
    const onDisk = read()
    if (onDisk.stickerWeight === 0.45 && !onDisk._stickerWeightUserTuned) {
      onDisk.stickerWeight = 0.18
    }
    // v3：0.22 是 v2.6 的旧默认，0.58 是 v2.7~v2.9 的旧默认；两者都平滑收敛到 0.35。
    // 用户自己调过的值（_chimeInUserTuned=true）绝不动。
    if ((onDisk.groupChimeInProb === 0.22 || onDisk.groupChimeInProb === 0.58) && !onDisk._chimeInUserTuned) {
      onDisk.groupChimeInProb = 0.35
    }
    if (onDisk.groupChimeInCooldownMin === 12 && !onDisk._chimeInUserTuned) {
      onDisk.groupChimeInCooldownMin = 6
    }
    // v2.8 平滑迁移：将旧版默认过冲的 mowan 自动平滑迁移为傲娇松弛的 feiyu_tone
    if ((onDisk.personaPreset === 'mowan' || onDisk.personaPreset === 'feiyu') && !onDisk._personaV28Tuned) {
      onDisk.personaPreset = 'feiyu_tone'
    }
    // v2.9.1：不再强行打开语音合成。用户明确关过就保持关闭。
    if (onDisk.pluginTtsEnabled === undefined) {
      onDisk.pluginTtsEnabled = true
    }
    // v2.9.1 安全修复：权限级别以环境变量为准，避免模型改 settings.json 自我提权。
    const envPerm = String(process.env.PERMISSION_LEVEL || '').trim()
    if (['standard', 'elevated', 'unrestricted'].includes(envPerm) && onDisk.permissionLevel !== envPerm) {
      onDisk.permissionLevel = envPerm
    }
    // v3.0.2：旧版把 llmProvider 的默认值写成 'dsh'（本意只是"没配 Key 时回落"）。
    // 新的严格语义下 'dsh' 就是"必须走本机 dsh 进程"，所以配了 Key 又没手动选过渠道的部署迁移到 auto。
    if (onDisk.llmProvider === 'dsh' && !onDisk._llmProviderTuned) {
      const hasKey = [
        process.env.DEEPSEEK_API_KEY, process.env.GEMINI_API_KEY,
        onDisk.deepseekApiKey, onDisk.geminiApiKey,
      ].some((k) => String(k || '').trim())
      if (hasKey) onDisk.llmProvider = 'auto'
    }
    onDisk.targets = normalizeTargetsMap(onDisk.targets)
    cached = { ...DEFAULTS, ...onDisk }
  }
  return cached
}

// A contact-ID migration must not persist unrelated legacy model/persona normalizers.
export function migrateWechatContacts(contacts){
  const disk=read(),patch=migrateWechatSelection(disk,contacts)
  if(!patch)return false
  writeSettingsDocument(settingsPath,{...disk,...patch})
  if(cached)cached={...cached,...patch}
  return true
}

export function save(patch = {}) {
  const merged = { ...current(), ...patch }
  if (patch.stickerWeight !== undefined) merged._stickerWeightUserTuned = true
  if (patch.groupChimeInProb !== undefined || patch.groupChimeInCooldownMin !== undefined) merged._chimeInUserTuned = true
  if (patch.styleRequireReview !== undefined) merged._styleReviewUserTuned = true
  if (patch.personaPreset !== undefined) merged._personaV28Tuned = true
  if (patch.pluginTtsEnabled !== undefined) merged._ttsUserTuned = true
  if (patch.llmProvider !== undefined) merged._llmProviderTuned = true
  if (patch.ttsApiUrl !== undefined && patch.ttsBaseUrl === undefined) merged.ttsBaseUrl = String(patch.ttsApiUrl).trim()
  if (patch.ttsBaseUrl !== undefined && patch.ttsApiUrl === undefined) merged.ttsApiUrl = String(patch.ttsBaseUrl).trim()
  if (patch.ttsAutoProb !== undefined && patch.ttsAutoReplyProb === undefined) merged.ttsAutoReplyProb = Number(patch.ttsAutoProb) || 0
  if (patch.ttsAutoReplyProb !== undefined && patch.ttsAutoProb === undefined) merged.ttsAutoProb = Number(patch.ttsAutoReplyProb) || 0

  for (const k of [
    'ackDelayMs', 'replyChunk', 'casualMaxChars', 'chunkGapMs', 'timeoutMs',
    'contextMessages', 'contextChars', 'proactiveMinGapMin', 'proactiveMaxGapMin',
    'proactiveQuietMin', 'proactiveDailyMax', 'proactiveProb', 'organizeBatch',
    'organizeIntervalMin', 'organizeDailyMax', 'debounceMs', 'debounceMaxWaitMs',
    'followUpWindowMs', 'groupChimeInCooldownMin', 'groupChimeInProb',
    'sessionMaxTurns', 'sessionMaxTokens', 'impressionActiveTopN',
    'styleSampleCount', 'stickerWeight', 'stickerCooldownTurns', 'globalStreamCount',
    'ttsSpeed', 'ttsAutoProb', 'ttsAutoReplyProb', 'websearchLimit',
    'agentMaxSteps', 'temperature', 'maxReplyTokens', 'debounceTypingGapMs', 'debounceGroupMs', 'debounceMediaMs', 'groupFollowUpMs', 'groupFollowUpMaxTurns',
  ]) {
    const n = Number(merged[k])
    merged[k] = Number.isFinite(n) && n >= 0 ? n : Number(DEFAULTS[k])||0
  }
  for (const k of ['allowUsers', 'allowGroups', 'learnGroups', 'allowedPaths', 'ownerUsers', 'allowWechatUsers', 'allowWechatGroups']) {
    if (typeof merged[k] === 'string') {
      merged[k] = merged[k].split(',').map((s) => s.trim()).filter(Boolean)
    }
    if (!Array.isArray(merged[k])) merged[k] = []
  }
  if (!merged.allowedPaths.includes(workspaceRoot)) {
    merged.allowedPaths = [workspaceRoot, ...merged.allowedPaths]
  }
  for (const k of [
    'atOnly', 'resumeSession', 'paused', 'ackOnlyTask', 'proactiveEnabled',
    'autoOrganize', 'diaryEnabled', 'impressionEnabled', 'debounceSmart',
    'groupChimeInEnabled', 'sessionAutoCompact', 'sessionNotifyInChat',
    'learnAllGroups', 'styleLearnEnabled', 'styleRequireReview',
    'stickerLearnFreq', 'stickerAutoSteal', 'stickerRequireReview',
    'crossWindowEnabled', 'crossWindowAnyone', 'autoAllowNewFriends',
    'pluginVisionEnabled', 'pluginPhoneEnabled', 'pluginPhoneAllowAllApps',
    'pluginTtsEnabled', 'pluginQzoneEnabled', 'qzoneAutoSyncDiary', 'pluginDrawEnabled',
    'skylandAutoSign', 'allowPackageInstall', 'allowCustomPlugins',
    'websearchEnabled', 'atmospherePerception', 'livingMemoryEnabled', 'embeddingEnabled', 'agentTools','wechatEnabled','groupFollowUpEnabled','allowAnyone',
  ]) {
    merged[k] = !!merged[k]
  }
  merged.replyChunk = Math.min(1000, Math.max(24, Number(merged.replyChunk) || 120))
  merged.agentMaxSteps = Math.min(24, Math.max(1, Number(merged.agentMaxSteps) || 8))
  merged.debounceTypingGapMs = Math.min(15000, Math.max(1500, Number(merged.debounceTypingGapMs) || 4500))
  for(const key of ['temperature','proactiveProb','groupChimeInProb','stickerWeight','ttsAutoProb','ttsAutoReplyProb'])merged[key]=Math.min(key==='temperature'?2:1,Math.max(0,merged[key]))
  merged.groupFollowUpMaxTurns=Math.max(1,Math.min(20,Math.floor(merged.groupFollowUpMaxTurns)))
  merged.groupFollowUpMs=Math.max(10000,Math.min(600000,merged.groupFollowUpMs))
  merged.targets = normalizeTargetsMap(merged.targets)

  writeSettingsDocument(settingsPath,merged)
  cached = merged
  return merged
}

export function reload() {
  cached = null
  return current()
}

export const defaults = DEFAULTS
