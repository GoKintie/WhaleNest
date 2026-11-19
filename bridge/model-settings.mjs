import { randomUUID } from 'node:crypto'

const AUX = {
  vision: ['pluginVisionBaseUrl', 'pluginVisionApiKey', 'pluginVisionModel'],
  voice: ['ttsBaseUrl', 'ttsApiKey', 'ttsCloudModel'],
  embedding: ['embeddingBaseUrl', 'embeddingApiKey', 'embeddingModel'],
}
const DRIVERS = ['openai', 'gemini', 'dashscope', 'siliconflow', 'dsh']
const clean = (value) => typeof value === 'string' ? value.trim() : ''

export function connectionInfo(baseUrl, operation = '', driver = '') {
  if (driver === 'dsh') return {supplier:'本机 DSH',endpoint:'本机 DSH CLI',protocol:'本机进程'}
  let url
  try { url = new URL(baseUrl) } catch {}
  if (!url || !['http:','https:'].includes(url.protocol)) return {supplier:'接口未配置',endpoint:'',protocol:'OpenAI 兼容'}
  const host = url.hostname
  const dashscope = /^dashscope(?:-[a-z0-9-]+)?\.aliyuncs\.com$/i.test(host) || host.endsWith('.maas.aliyuncs.com')
  let supplier = '自定义接口'
  if (dashscope) supplier = '阿里云百炼'
  else if (host === 'api.deepseek.com') supplier = 'DeepSeek'
  else if (host === 'generativelanguage.googleapis.com') supplier = 'Google Gemini'
  else if (/^api\.siliconflow\.(cn|com)$/.test(host)) supplier = '硅基流动'
  else if (host === 'api.openai.com') supplier = 'OpenAI'
  url.username = url.password = url.search = url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (operation && !url.pathname.endsWith(operation)) url.pathname += operation
  return {supplier,endpoint:url.href.replace(/\/$/,''),host,protocol:'OpenAI 兼容',
    nativeDashscope:dashscope && !/\/compatible-mode(?:\/|$)/i.test(url.pathname)}
}

// The flat settings remain the runtime interface for existing adapters and CLI tools.
export function readModelCatalog(s, active) {
  if (s.modelCatalog) return s.modelCatalog
  const services = []
  function add(id, name, baseUrl, apiKey, driver = 'openai', proxy = '') {
    baseUrl = clean(baseUrl).replace(/\/+$/, '')
    apiKey = clean(apiKey)
    const existing = services.find(p => p.baseUrl === baseUrl && p.apiKey === apiKey && p.proxy === proxy && p.driver === driver)
    if (existing) return existing.id
    services.push({ id, name, baseUrl, apiKey, driver, proxy })
    return id
  }
  const ds = add('legacy-deepseek', 'DeepSeek / OpenAI 兼容', s.deepseekBaseUrl, s.deepseekApiKey, 'openai', s.apiProxy || '')
  const gem = add('legacy-gemini', 'Gemini', s.geminiBaseUrl, s.geminiApiKey, 'gemini', s.geminiProxy || s.apiProxy || '')
  const main = { service: active.id === 'dsh' ? add('local-dsh', '本机 DSH', '', '', 'dsh') : active.id === 'gemini' ? gem : ds, model: active.model }
  const backups = [{service:ds, model:s.deepseekModel}, {service:gem, model:s.geminiModel}]
    .filter(row => row.model && services.find(p => p.id === row.service)?.apiKey && !sameBinding(row, main))
  const roles = { main, backups }
  for (const [role, [urlKey, keyKey, modelKey]] of Object.entries(AUX)) {
    const url = role === 'voice' ? s.ttsApiUrl || s[urlKey] : s[urlKey]
    const key = s[keyKey]
    const driver = role === 'voice' && ['dashscope','siliconflow'].includes(s.ttsProvider) ? s.ttsProvider : 'openai'
    const service = key || (role === 'voice' && url) ? add(`legacy-${role}`, {vision:'视觉服务',voice:'语音服务',embedding:'向量服务'}[role], url, key, driver) : ''
    roles[role] = { service, model: clean(s[modelKey] || (role === 'voice' ? s.ttsModel : '')) }
  }
  return { services, roles }
}

export function publicModelCatalog(catalog) {
  return {...catalog, services:catalog.services.map(({apiKey, ...service}) => ({...service, hasKey:!!apiKey,
    connection:connectionInfo(service.baseUrl,'',service.driver)}))}
}

function sameBinding(a, b) { return a?.service === b?.service && a?.model === b?.model }

function binding(input, services, required = false) {
  const result = {service:clean(input?.service), model:clean(input?.model)}
  if (result.service && !services.some(p => p.id === result.service)) throw Error('所选服务商已不存在')
  if (required && (!result.service || !/^[a-zA-Z0-9._:/-]{1,200}$/.test(result.model))) throw Error('请选择服务商并填写合法的模型 ID')
  if (result.model.length > 200) throw Error('模型 ID 过长')
  return result
}

function requireRemoteBinding(route, services, operation) {
  const service = services.find(item => item.id === route.service)
  if (!service || service.driver === 'dsh' || !/^[a-zA-Z0-9._:/-]{1,200}$/.test(route.model)) {
    throw Error('请选择远端服务商并填写有效的模型 ID')
  }
  if (!service.baseUrl || !service.apiKey) throw Error('请先在「服务商」配置接口地址和 API Key')
  if (connectionInfo(service.baseUrl,operation).nativeDashscope) {
    throw Error('此用途需选择百炼的 OpenAI 兼容地址（compatible-mode/v1）')
  }
}

function applyRole(role, route, services, patch) {
  const service = services.find(p => p.id === route.service)
  if (role === 'main') {
    if (service.driver === 'dsh') {
      Object.assign(patch, {llmProvider:'dsh', model:route.model})
    } else {
      if (!service.apiKey) throw Error('先为主模型的服务商配置 API Key')
      if (!service.baseUrl) throw Error('先为主模型的服务商配置接口地址')
      const channel = service.driver === 'gemini' ? 'gemini' : 'deepseek'
      Object.assign(patch, {llmProvider:channel, model:route.model, [`${channel}Model`]:route.model,
        [`${channel}BaseUrl`]:service.baseUrl, [`${channel}ApiKey`]:service.apiKey,
        [channel === 'gemini' ? 'geminiProxy' : 'apiProxy']:service.proxy})
    }
    return
  }
  const [urlKey, keyKey, modelKey] = AUX[role]
  patch[modelKey] = route.model
  patch[urlKey] = service?.baseUrl || ''
  patch[keyKey] = service?.apiKey || ''
  if (role === 'voice') {
    patch.ttsApiUrl = patch.ttsBaseUrl
    patch.ttsModel = route.model
    if (service) patch.ttsProvider = ['dashscope','siliconflow'].includes(service.driver) ? service.driver : 'openai'
  }
}

export function changeModelCatalog(catalog, input) {
  let {services, roles} = catalog
  const patch = {}
  if (input.action === 'service' || input.action === 'service-key') {
    const keyOnly = input.action === 'service-key'
    const old = services.find(p => p.id === input.id)
    if ((input.id || keyOnly) && !old) throw Error('服务商已不存在')
    if (keyOnly && old.driver === 'dsh') throw Error('本机 DSH 不使用此入口的 API Key')
    const name = clean(keyOnly ? old.name : input.name)
    const driver = clean(keyOnly ? old.driver : input.driver)
    const baseUrl = clean(keyOnly ? old.baseUrl : input.baseUrl).replace(/\/+$/, '')
    if (!name || name.length > 80 || !DRIVERS.includes(driver)) throw Error('请填写服务商名称和协议')
    if (driver !== 'dsh' && baseUrl) {
      let url
      try { url = new URL(baseUrl) } catch { throw Error('接口地址格式错误') }
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw Error('接口地址需为 HTTP 或 HTTPS，且不能包含用户名和密码')
    }
    let sameOrigin = baseUrl === old?.baseUrl
    if (old && !sameOrigin) {
      try { sameOrigin = new URL(baseUrl).origin === new URL(old.baseUrl).origin } catch {}
    }
    const newKey = clean(input.apiKey)
    const apiKey = input.clearKey ? '' : (newKey === '********' ? '' : newKey) || (sameOrigin ? old?.apiKey : '') || ''
    const service = {id:old?.id || randomUUID(), name, driver, baseUrl,
      apiKey, proxy:clean(keyOnly ? old.proxy : input.proxy)}
    services = [...services.filter(p => p.id !== service.id), service]
    if (old && ['baseUrl','apiKey','driver','proxy'].some(key => service[key] !== old[key])) {
      for (const role of ['main', ...Object.keys(AUX)]) {
        if (roles[role]?.service === service.id) applyRole(role, roles[role], services, patch)
      }
    }
  } else if (input.action === 'remove-service') {
    if ([roles.main, ...roles.backups, ...Object.keys(AUX).map(role => roles[role])].some(r => r?.service === input.id)) {
      throw Error('此服务商仍有模型在使用，请先调整用途或备选模型')
    }
    services = services.filter(p => p.id !== input.id)
  } else if (input.action === 'roles') {
    if (input.only === 'chat') {
      const main = binding(input.main, services, true)
      if (services.find(p => p.id === main.service)?.driver !== 'dsh') requireRemoteBinding(main,services,'/chat/completions')
      const backups = []
      for (const row of (Array.isArray(input.backups) ? input.backups : []).slice(0, 30)) {
        const candidate = binding(row, services, true)
        if (!sameBinding(candidate, main) && !backups.some(item => sameBinding(item, candidate))) backups.push(candidate)
      }
      applyRole('main', main, services, patch)
      roles = {...roles, main, backups}
    } else if (Object.hasOwn(AUX,input.only)) {
      const role = input.only
      const next = binding(input[role], services)
      if (role === 'embedding' && ['off','local','remote'].includes(input.mode)) {
        if (input.mode === 'remote') requireRemoteBinding(next,services,'/embeddings')
        patch.embeddingEnabled = input.mode !== 'off'
        if (input.mode !== 'off') patch.embeddingProvider = input.mode === 'local' ? 'local' : 'openai'
      }
      if (role === 'vision' && typeof input.enabled === 'boolean') {
        if (input.enabled) requireRemoteBinding(next,services,'/chat/completions')
        patch.pluginVisionEnabled = input.enabled
      }
      if (!sameBinding(roles[role], next) || (role==='vision' && input.enabled===true) || (role==='embedding' && input.mode==='remote')) {
        applyRole(role, next, services, patch)
      }
      roles = {...roles, [role]:next}
    } else {
      throw Error('未知模型用途')
    }
  } else if (input.action === 'activate') {
    const next = binding(input, services, true)
    if (!roles.backups.some(row => sameBinding(row, next))) throw Error('此模型已不在备选列表中')
    applyRole('main', next, services, patch)
    roles = {...roles, main:next, backups:[roles.main, ...roles.backups.filter(row => !sameBinding(row, next))]}
  } else {
    throw Error('未知模型配置操作')
  }
  return {...patch, modelCatalog:{services, roles}}
}
