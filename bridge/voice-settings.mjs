const DEFAULT_URLS = {
  dashscope: 'https://dashscope.aliyuncs.com/api/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  openai: 'https://api.openai.com/v1',
  edge: '',
}
const clean = value => typeof value === 'string' ? value.trim() : ''

function currentProvider(s) {
  if (Object.hasOwn(DEFAULT_URLS, s.ttsProvider)) return s.ttsProvider
  const base = s.ttsApiUrl || s.ttsBaseUrl || ''
  if (/dashscope|maas\.aliyuncs/i.test(base) || /^(qwen-audio|cosyvoice)/i.test(s.ttsModel || '')) return 'dashscope'
  if (/siliconflow/i.test(base)) return 'siliconflow'
  return base || s.ttsApiKey ? 'openai' : 'edge'
}

function voiceKey(s, provider) {
  return s.ttsApiKey || (!s.ttsVoiceSelection && (
    s.pluginTtsApiKey || process.env.TTS_API_KEY || (provider === 'dashscope' ? process.env.DASHSCOPE_API_KEY : '')
  )) || ''
}

function voiceUrl(provider, raw = '') {
  if (provider === 'edge') return ''
  const url = new URL(raw || DEFAULT_URLS[provider])
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Error('API 接口须为不含账号、查询参数或锚点的 HTTP(S) 地址')
  }
  return url.href.replace(/\/+$/, '')
}

export function publicVoiceSettings(s) {
  const provider = currentProvider(s)
  const fixed = s.ttsStyle === 'gentle' ? s.ttsVoiceGentle : s.ttsStyle === 'cute' ? s.ttsVoiceCute : ''
  return {
    enabled: s.pluginTtsEnabled !== false, provider,
    baseUrl: provider === 'edge' ? '' : s.ttsApiUrl || s.ttsBaseUrl || DEFAULT_URLS[provider],
    defaultUrls: DEFAULT_URLS,
    hasKey: provider !== 'edge' && Boolean(voiceKey(s,provider)),
    mode: s.ttsVoiceSelection || (!fixed && (s.ttsVoiceCute || s.ttsVoiceGentle) ? 'context' : 'single'),
    voice: !s.ttsVoiceSelection && fixed ? fixed : s.ttsVoice,
    cute: s.ttsVoiceCute, gentle: s.ttsVoiceGentle,
    pool: Array.isArray(s.ttsVoicePool) ? s.ttsVoicePool : [],
    voiceModels: s.ttsVoiceModels || {},
  }
}

function connection(s, input) {
  const provider = clean(input.provider)
  if (!Object.hasOwn(DEFAULT_URLS,provider)) throw Error('请选择云端语音渠道')
  let baseUrl, oldUrl
  try { baseUrl = voiceUrl(provider,clean(input.baseUrl)) }
  catch { throw Error('请填写合法的 HTTP(S) 接口地址，地址中不含账号、查询参数或锚点') }
  const oldProvider = currentProvider(s)
  try { oldUrl = voiceUrl(oldProvider,s.ttsApiUrl || s.ttsBaseUrl) } catch {}
  const same = provider === oldProvider && baseUrl === oldUrl
  const sameOrigin = provider === oldProvider && (same || (
    baseUrl && oldUrl && new URL(baseUrl).origin === new URL(oldUrl).origin
  ))
  const suppliedKey = clean(input.apiKey)
  const apiKey = provider === 'edge' ? '' : (suppliedKey && suppliedKey !== '********' ? suppliedKey : '') ||
    (sameOrigin ? voiceKey(s,provider) : '')
  return {provider,baseUrl,apiKey,same}
}

export function voiceSettingsPatch(s, input, catalog) {
  const {provider,baseUrl,apiKey,same} = connection(s,input)
  const mode = clean(input.mode)
  if (!['single','context','random'].includes(mode)) throw Error('请选择音色使用方式')
  const normalize = value => {
    const id = clean(value)
    if (id && !/^[\p{L}\p{N} ._:/-]{1,240}$/u.test(id)) throw Error('音色 ID 格式不正确')
    if (id && provider === 'edge' && !/^[a-z0-9-]{1,80}$/i.test(id)) throw Error('Edge 音色 ID 格式不正确')
    return id
  }
  const voice = normalize(input.voice), cute = normalize(input.cute), gentle = normalize(input.gentle)
  const pool = [...new Set((Array.isArray(input.pool) ? input.pool : []).map(normalize).filter(Boolean))]
  if (pool.length > 20) throw Error('随机列表最多支持 20 个音色')
  if (input.enabled === true && mode === 'random' && pool.length < 2) throw Error('开启随机音色需要至少两个不同的音色 ID')
  if (input.enabled === true && mode === 'context' && !cute && !gentle) throw Error('请填写至少一个语境音色 ID')
  if (input.enabled === true && mode === 'single' && !voice) throw Error('请填写或选择云端音色 ID')
  if (input.enabled === true && provider !== 'edge' && !apiKey) throw Error('请填写该接口的 API Key')
  const model = same ? s.ttsCloudModel || s.ttsModel || '' : ''
  const voiceModels = Object.fromEntries([voice,cute,gentle,...pool].filter(Boolean).flatMap(id => {
    const name = input.voiceModels?.[id] || (same && s.ttsVoiceModels?.[id])
    return provider === 'siliconflow' && typeof name === 'string' && /^[a-zA-Z0-9._/-]{1,150}$/.test(name) ? [[id,name]] : []
  }))
  return {
    pluginTtsEnabled: input.enabled === true, ttsMode: 'cloud', ttsProvider: provider,
    ttsApiUrl: baseUrl, ttsBaseUrl: baseUrl, ttsApiKey: apiKey, ttsStyle: 'auto',
    ttsVoiceSelection: mode, ttsVoice: voice, ttsVoiceCute: cute, ttsVoiceGentle: gentle,
    ttsVoicePool: pool, ttsVoiceModels: voiceModels, ttsModel: model, ttsCloudModel: model,
    modelCatalog: {...catalog,roles:{...catalog.roles,voice:{service:'',model}}},
  }
}

export async function discoverCloudVoices(s, input) {
  const {provider,baseUrl,apiKey} = connection(s,input)
  if (provider === 'edge') {
    return [
      {id:'zh-CN-XiaoyiNeural',name:'晓伊'},
      {id:'zh-CN-XiaoxiaoNeural',name:'晓晓'},
      {id:'zh-CN-YunxiNeural',name:'云希'},
    ]
  }
  if (provider === 'openai') return []
  if (!apiKey) throw Error('请先填入该接口的 API Key')
  const init = {headers:{authorization:`Bearer ${apiKey}`},redirect:'error',signal:AbortSignal.timeout(7500)}
  let requestUrl, unpack
  if (provider === 'dashscope') {
    requestUrl = baseUrl.replace(/\/(?:api\/v1|compatible-mode)(?:\/.*)?$/i,'') + '/api/v1/services/audio/tts/customization'
    init.method = 'POST'
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify({model:'voice-enrollment',input:{action:'list_voice',page_index:0,page_size:100}})
    unpack = data => data.output.voice_list
      .filter(item => (!item.status || item.status === 'OK') && !/realtime/i.test(item.voice_id))
      .map(item => ({id:item.voice_id}))
  } else {
    requestUrl = baseUrl.replace(/\/audio\/speech$/i,'') + '/audio/voice/list'
    unpack = data => data.results.map(item => ({id:item.uri,name:item.customName,model:item.model}))
  }
  const response = await fetch(requestUrl,init)
  if (!response.ok) throw Error(`音色列表接口返回 HTTP ${response.status}`)
  let voices
  try { voices = unpack(await response.json()) }
  catch { throw Error('服务商未返回有效的音色列表') }
  return voices.filter(item => typeof item.id === 'string' && item.id.trim() && item.id.length <= 240)
}
