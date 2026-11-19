/* Settings navigation reuses the existing editors for ordinary fields. */
const settingsPages = Object.fromEntries(SET_PAGES.map(page => [page.id, page]))
const settingsRows = id => settingsPages[id].groups.flatMap(([, rows]) => rows)
const settingsGroups = [
  ['模型与服务', [['model','用途总览'],['services','服务商'],['vision','视觉'],['voice','语音'],['embedding','Embedding'],['generation','生成参数']]],
  ['人格与表达', [['persona','人设库'],['conversation-prompts','会话提示'],['prompt-advanced','高级模板']]],
  ['聊天行为', [['chat','对话与防抖'],['group','群聊与主动发言']]],
  ['渠道与联系人', [['qq','QQ'],['wechat','微信'],['allow','联系人与白名单']]],
  ['记忆与学习', [['memory','会话与记忆'],['learning','表达与表情学习'],['memory-identities','跨渠道身份']]],
  ['能力与权限', [['plugin','工具与插件'],['perm','管理员与权限']]],
]
const groupedPages = settingsGroups.flatMap(([, pages]) => pages)
const settingsPage = (id, groups = []) => ({id, name:groupedPages.find(([key]) => key === id)[1], groups})
const settingsMemory = settingsPages.memory.groups.map(([name, rows]) => [name, rows.filter(row => !row[0].startsWith('embedding'))])
settingsMemory[1][0] = '联想召回'
const learningRows = settingsRows('chat').filter(row => /^(sticker|style)/.test(row[0]))
const atmosphere = settingsRows('chat').filter(row => row[0] === 'atmospherePerception')
SET_PAGES.splice(0, SET_PAGES.length,
  settingsPage('model'), settingsPage('services'), settingsPage('persona'), settingsPage('conversation-prompts'), settingsPage('qq'),
  settingsPage('memory-identities'),
  settingsPage('prompt-advanced',[['高级对话模板',settingsRows('perm').filter(row => row[0] === 'promptTemplate')]]),
  settingsPage('vision'),
  settingsPage('voice'),
  settingsPage('embedding'),
  settingsPage('generation',[['生成参数',settingsPages.model.groups[1][1].filter(row => row[0] !== 'agentTools')],['兼容与诊断',[
    ...settingsRows('model').filter(row => row[0] === 'geminiReasoningEffort'),
  ]]]),
  settingsPage('chat',settingsPages.chat.groups.slice(0,2)),
  settingsPage('group',[['插话与语境',[...settingsPages.group.groups[0][1],...atmosphere]],settingsPages.group.groups[1]]),
  settingsPage('wechat',[settingsPages.wechat.groups[0]]),settingsPages.allow,
  settingsPage('memory',settingsMemory),settingsPage('learning',[['表达与表情学习',learningRows.filter(row => row[0] !== 'styleRequireReview')]]),
  settingsPage('plugin',[
    ['工具调用',settingsRows('model').filter(row => row[0] === 'agentTools')],
    ['QQ 空间',settingsRows('plugin').filter(row => /qzone/i.test(row[0]))],
    ['本地语音服务',settingsRows('plugin').filter(row => ['ttsLocalUrl','ttsLocalKey'].includes(row[0]))],
    ...settingsPages.plugin.groups.slice(2),
  ]),
  settingsPage('perm',[settingsPages.perm.groups[0],['运行状态',settingsRows('perm').filter(row => row[0] === 'paused')],
    [...settingsPages.perm.groups.at(-1).slice(0,1),[...settingsPages.perm.groups.at(-1)[1],
      ['modelFailureNotifyQQ','主模型故障通知 QQ','text','填写已列为管理员的 QQ。相同模型的通知每 10 分钟最多一条，由管理员手动切换。']]],
  ]),
)

const oldRenderSettings = renderSettings
let settingsRenderSerial = 0
const settingsSubpage = Object.create(null)
renderSettings = function(pageId = 'model', serviceId) {
  const group = settingsGroups.find(([, pages]) => pages.some(([id]) => id === pageId)) || settingsGroups[0]
  if (!group[1].some(([id]) => id === pageId)) pageId = group[1][0][0]
  settingsSubpage[group[0]] = pageId
  const serial = ++settingsRenderSerial
  oldRenderSettings(pageId)
  const nav = $('#snav'), body = $('#setBody')
  nav.innerHTML = settingsGroups.map(([name, pages], index) => `<button data-settings-group="${index}" class="${name === group[0] ? 'on' : ''}">${esc(name)}</button>`).join('')
  $$('[data-settings-group]', nav).forEach(btn => btn.onclick = () => {
    const [name, pages] = settingsGroups[Number(btn.dataset.settingsGroup)]
    renderSettings(settingsSubpage[name] || pages[0][0])
  })
  const subnav = document.createElement('nav')
  subnav.className = 'settings-subnav'
  subnav.setAttribute('aria-label', group[0])
  subnav.innerHTML = group[1].map(([id, name]) => `<button class="btn sm${id === pageId ? ' on' : ''}" aria-current="${id === pageId ? 'page' : 'false'}" data-setting-page="${id}">${esc(name)}</button>`).join('')
  body.prepend(subnav)
  $$('[data-setting-page]',subnav).forEach(btn => btn.onclick = () => renderSettings(btn.dataset.settingPage))
  if (['model','services','persona','qq','conversation-prompts','vision','voice','embedding','generation','memory-identities','learning'].includes(pageId)) {
    const mount = document.createElement('div')
    mount.className = 'settings-custom'
    subnav.after(mount)
    const alive = () => serial === settingsRenderSerial && mount.isConnected
    void renderSettingsCustom(pageId,mount,alive,serviceId).catch(error => {
      if (alive()) mount.textContent = '读取设置失败：' + error.message
    })
  }
}

const settingCard = (title, content, actions = '') => `<section class="card"><div class="card-h"><b>${esc(title)}</b><div class="grow"></div>${actions}</div><div class="card-b">${content}</div></section>`
const actionButton = (id, label, primary = false) => `<button class="btn sm${primary ? ' pri' : ''}" id="${id}">${esc(label)}</button>`
const settingInput = (id, label, value = '', type = 'text') => `<label class="setting-input" for="${id}"><span>${esc(label)}</span><input id="${id}" type="${type}" value="${esc(value)}" autocomplete="${type==='password'?'new-password':'off'}"></label>`

async function settingsMutation(button, action) {
  button.disabled = true
  try { await action(); toast('已保存') }
  catch (error) { toast('保存失败：' + error.message) }
  finally { button.disabled = false }
}

const personaPath = '/api/settings/personas'
const modelCatalogPath = '/api/settings/model-catalog'
const driverLabels = {openai:'OpenAI 兼容',gemini:'Gemini',dashscope:'阿里云百炼',siliconflow:'硅基流动',dsh:'本机 DSH'}

async function renderSettingsCustom(page, mount, alive, serviceId) {
  if (page === 'voice') {
    const {voice} = await api('/api/settings/voice')
    if (alive()) renderVoiceSettings(mount,voice,alive)
    return
  }
  if (page === 'memory-identities') {
    const {links} = await api('/api/settings/memory-identities')
    if (alive()) renderMemoryIdentities(mount,links,alive)
    return
  }
  if (page === 'learning') {
    mount.innerHTML = settingCard('群聊学习与审核','<p>在联系人设置中为群开启「旁听学习与记忆」。小鲸鱼会把适用情境、用法和避用情境提炼成规则，逐条审核后才能用于回复。</p>'+actionButton('openLearningReview','查看待审核'))
    $('#openLearningReview',mount).onclick = () => tab('review')
    return
  }
  if (page === 'persona') {
    const library = await api(personaPath)
    if (alive()) renderPersonaLibrary(mount,library,library.active,alive)
    return
  }
  if (page === 'conversation-prompts' || page === 'qq') {
    const title = page === 'qq' ? 'QQ 渠道' : '按聊天对象设置'
    mount.innerHTML = settingCard(title,`<p>${page === 'qq' ? (state.lastState?.wsConnected ? 'NapCat 已连接。' : 'NapCat 未连接。') : '选择 QQ 或微信联系人、群聊，分别查看管理员手写提示与小鲸鱼的印象。手写提示优先。'}</p>${actionButton('settingsOpenContacts','打开联系人与白名单')}`)
    $('#settingsOpenContacts',mount).onclick = () => { if (page === 'qq') state.allowPlatform = 'qq'; renderSettings('allow') }
    return
  }
  if (page === 'generation') {
    renderModelDiagnostics(mount)
    return
  }
  const {catalog,effective} = await api(modelCatalogPath)
  if (!alive()) return
  if (page === 'services') renderModelServices(mount,catalog,alive,serviceId)
  else renderModelRoles(page,mount,catalog,effective,alive)
}

function renderVoiceSettings(mount, saved, alive) {
  const providers = {dashscope:'阿里云百炼',siliconflow:'硅基流动',openai:'OpenAI 兼容',edge:'Microsoft Edge'}
  const path = '/api/settings/voice'
  const voiceInput = (id, label, value = '') => `<label class="setting-input" for="${id}"><span>${label}</span><input type="text" id="${id}" value="${esc(value)}" list="voiceSuggestions" maxlength="240" placeholder="从列表选择，或填写音色 ID" autocomplete="off"></label>`
  mount.innerHTML = settingCard('云端语音',`<div class="voice-settings">
    <div class="voice-grid">
      <label class="voice-enable"><input type="checkbox" role="switch" id="voiceEnabled"${saved.enabled ? ' checked' : ''}><span>启用语音</span></label>
      <label class="setting-input"><span>云端 API 渠道</span><select id="voiceProvider">${Object.entries(providers).map(([id,name])=>`<option value="${id}"${saved.provider===id?' selected':''}>${name}</option>`).join('')}</select></label>
    </div>
    <div class="voice-grid" id="voiceConnection">
      ${settingInput('voiceBaseUrl','API 接口地址',saved.baseUrl)}
      ${settingInput('voiceApiKey','API Key','','password')}
    </div>
    <p class="faint voice-route-hint">云端渠道决定请求发到哪里。复刻音色 ID 由该渠道发放，百炼按复刻音色 ID 选择对应的合成模型。</p>
    <div class="voice-grid voice-choice">
      <label class="setting-input"><span>音色使用方式</span><select id="voiceMode">
        <option value="single">固定音色</option><option value="context">按语境选择</option><option value="random">随机音色</option>
      </select></label>
      <div class="voice-lookup">${actionButton('lookupVoices','获取音色')}<span id="voiceLookupStatus" class="faint" aria-live="polite"></span></div>
    </div>
    <datalist id="voiceSuggestions"></datalist>
    <div data-voice-mode="single">${voiceInput('voiceSingle','云端音色 ID',saved.voice)}</div>
    <div data-voice-mode="context" class="voice-grid">${voiceInput('voiceCute','可爱音色 ID',saved.cute)}${voiceInput('voiceGentle','温柔音色 ID',saved.gentle)}</div>
    <div data-voice-mode="random">
      <div id="voicePool"></div>
      ${actionButton('addVoice','添加音色')}
      <p class="faint">每条语音随机选一个，至少填写两个不同的音色 ID。</p>
    </div>
  </div>`,actionButton('saveVoiceSettings','保存',true))
  const control = id => $('#'+id,mount)
  const provider = control('voiceProvider'), mode = control('voiceMode')
  const address = control('voiceBaseUrl'), key = control('voiceApiKey')
  const results = control('voiceSuggestions'), lookup = control('lookupVoices'), status = control('voiceLookupStatus')
  let discovered = [], request = 0
  let rowId = 0
  const choices = () => $$('[data-pool-voice]',mount).map(input=>input.value.trim())
  const list = control('voicePool')
  const addVoice = value => {
    if (list.childElementCount >= 20) return toast('最多添加 20 个音色')
    const id = 'poolVoice'+(++rowId)
    const row = document.createElement('div')
    row.className = 'voice-pool-row'
    row.innerHTML = voiceInput(id,'云端音色 ID',value) + '<button class="btn sm" type="button">移除</button>'
    $('input',row).dataset.poolVoice = ''
    $('button',row).onclick = () => row.remove()
    list.append(row)
  }
  const fillPool = values => {
    list.replaceChildren()
    const ids = [...new Set(values.filter(Boolean))]
    for (const id of ids.length >= 2 ? ids : [...ids,...Array(2-ids.length).fill('')]) addVoice(id)
  }
  const contextVoices = [saved.cute,saved.gentle].filter(Boolean)
  const savedPool = saved.pool.length ? saved.pool : contextVoices.length ? contextVoices : [saved.voice]
  fillPool(savedPool)
  mode.value = saved.mode
  const showMode = () => $$('[data-voice-mode]',mount).forEach(group=>{
    group.hidden = group.dataset.voiceMode !== mode.value
  })
  const draft = () => ({provider:provider.value,baseUrl:address.value.trim(),apiKey:key.value})
  const invalidate = () => {
    ++request
    discovered = []
    results.replaceChildren()
    status.textContent = provider.value === 'openai' ? '兼容接口请手填音色 ID。' : ''
    lookup.disabled = provider.value === 'openai'
  }
  const origin = value => { try { return new URL(value).origin } catch { return '' } }
  const showConnection = () => {
    control('voiceConnection').hidden = provider.value === 'edge'
    address.placeholder = saved.defaultUrls[provider.value]
    key.placeholder = provider.value === saved.provider && saved.hasKey &&
      origin(address.value || address.placeholder) === origin(saved.baseUrl) ? '已配置，留空保留' : '填写该接口的 API Key'
  }
  const load = async () => {
    if (provider.value === 'openai') return
    const version = ++request
    lookup.disabled = true
    status.textContent = '正在获取音色…'
    try {
      const {voices} = await post(path+'/voices',draft())
      if (!alive() || version !== request) return
      discovered = voices
      results.replaceChildren(...voices.map(item => new Option(item.name || '',item.id)))
      status.textContent = voices.length ? `已获取 ${voices.length} 个，可在音色输入框选择。` : '没有可选音色，可手填 ID。'
    } catch (error) {
      if (alive() && version === request) status.textContent = error.message+'，可手填 ID。'
    } finally {
      if (alive() && version === request) lookup.disabled = false
    }
  }
  provider.onchange = () => {
    const original = provider.value === saved.provider
    address.value = original ? saved.baseUrl : saved.defaultUrls[provider.value]
    key.value = ''
    control('voiceSingle').value = original ? saved.voice || '' : ''
    control('voiceCute').value = original ? saved.cute || '' : ''
    control('voiceGentle').value = original ? saved.gentle || '' : ''
    fillPool(original ? savedPool : [])
    invalidate()
    showConnection()
    if (provider.value === 'edge' || (original && saved.hasKey)) void load()
  }
  address.oninput = () => { invalidate(); showConnection() }
  key.oninput = invalidate
  mode.onchange = showMode
  control('addVoice').onclick = () => addVoice('')
  lookup.onclick = () => void load()
  const save = control('saveVoiceSettings')
  save.onclick = () => settingsMutation(save,async () => {
    const modelMap = provider.value === saved.provider && origin(address.value || address.placeholder) === origin(saved.baseUrl)
      ? saved.voiceModels : {}
    const {voice} = await post(path,{
      ...draft(), enabled:control('voiceEnabled').checked, mode:mode.value,
      voice:control('voiceSingle').value, cute:control('voiceCute').value, gentle:control('voiceGentle').value,
      pool:choices(), voiceModels:{...modelMap,...Object.fromEntries(discovered.filter(item=>item.model).map(item=>[item.id,item.model]))},
    })
    if (alive()) renderVoiceSettings(mount,voice,alive)
  })
  invalidate()
  showMode()
  showConnection()
  if (saved.hasKey || saved.provider === 'edge') void load()
}

function renderMemoryIdentities(mount, links, alive) {
  const list = links.map((link,index)=>`<div class="row"><span>QQ ${esc(link.qq)} ↔ 微信 ${esc(link.wechat)}</span><button class="btn sm" data-remove-identity="${index}">解除绑定</button></div>`).join('')
  mount.innerHTML = settingCard('已确认属于同一人的账号',`<p class="faint">绑定后，两边的私聊都能回忆这个人自己在获准学习的群里说过的事。请使用微信联系人详情里的 ID。</p>${list || '<p class="faint">暂无绑定</p>'}`) +
    settingCard('确认新绑定',`<div class="settings-editor">${settingInput('memoryLinkQQ','QQ 号')}${settingInput('memoryLinkWechat','微信联系人 ID')}</div>`,actionButton('saveMemoryLink','确认同一人',true))
  const update = async (action, link) => {
    const result = await post('/api/settings/memory-identities',{action,...link})
    if (alive()) renderMemoryIdentities(mount,result.links,alive)
  }
  const save = $('#saveMemoryLink',mount)
  save.onclick = () => settingsMutation(save,()=>update('link',{qq:$('#memoryLinkQQ',mount).value,wechat:$('#memoryLinkWechat',mount).value}))
  $$('[data-remove-identity]',mount).forEach(btn=>btn.onclick=()=>settingsMutation(btn,()=>update('remove',links[Number(btn.dataset.removeIdentity)])))
}

function renderPersonaLibrary(mount, library, id, alive) {
  const current = library.profiles.find(p => p.id === id)
  const fields = [['personalityText','人格与关系'],['behaviorStyleText','行为与参与时机'],['replyStyleText','说话风格'],['responseExamples','场景与回应示例']]
  const list = library.profiles.map(p => `<button class="btn sm${p.id === id ? ' on' : ''}" data-persona-id="${esc(p.id)}">${esc(p.name)}${p.id === library.active ? ' · 使用中' : ''}</button>`).join('')
  mount.innerHTML = settingCard('人设库',`<div class="settings-inline">${list}${actionButton('newPersona','新建人设')}</div><p class="faint">人格、行为和表达分开编辑，按一套保存。QQ 与微信共用当前人设。</p>`) +
    settingCard(current?.name || '新建人设',`<div class="settings-editor">${settingInput('personaName','人设名称',current?.name)}${fields.map(([key,label]) => `<label class="setting-input" for="persona-${key}"><span>${label}</span><textarea id="persona-${key}" rows="4" maxlength="12000">${esc(current?.[key] || '')}</textarea></label>`).join('')}</div>`,
      `${current && id !== library.active ? actionButton('deletePersona','删除') : ''}${actionButton('savePersona','保存')}${id !== library.active ? actionButton('activatePersona','保存并切换',true) : ''}`) +
    settingCard('显示与自称',settingInput('settingsBotName','称呼',state.settings?.botName || ''),actionButton('saveBotName','保存'))
  const draft = () => ({action:'save',id,name:$('#personaName',mount).value,
    ...Object.fromEntries(fields.map(([key]) => [key,$(`#persona-${key}`,mount).value]))})
  const original = JSON.stringify(draft())
  const save = async (activate = false) => {
    library = await post(personaPath,{...draft(),activate})
    return id || library.profiles.at(-1).id
  }
  const choose = async (button,next) => {
    button.disabled = true
    try {
      if (JSON.stringify(draft()) !== original) await save()
      if (alive()) renderPersonaLibrary(mount,library,next,alive)
    } catch (error) { toast('当前人设未保存：' + error.message) }
    finally { button.disabled = false }
  }
  $$('[data-persona-id]',mount).forEach(btn => btn.onclick = () => choose(btn,btn.dataset.personaId))
  $('#newPersona',mount).onclick = event => choose(event.currentTarget,undefined)
  for (const [buttonId,activate] of [['savePersona',false],['activatePersona',true]]) {
    const btn = $(`#${buttonId}`,mount)
    if (btn) btn.onclick = () => settingsMutation(btn,async () => {
      const next = await save(activate)
      if (alive()) renderPersonaLibrary(mount,library,next,alive)
    })
  }
  const remove = $('#deletePersona',mount)
  if (remove) remove.onclick = async () => {
    if (!await confirmBox('删除人设', `删除「${current.name}」？`)) return
    void settingsMutation(remove,async () => {
      library = await post(personaPath,{action:'delete',id})
      if (alive()) renderPersonaLibrary(mount,library,library.active,alive)
    })
  }
  const nameButton = $('#saveBotName',mount)
  nameButton.onclick = () => settingsMutation(nameButton,async () => {
    const result = await post('/api/settings',{botName:$('#settingsBotName',mount).value.trim()})
    state.settings = result.settings
  })
}

function modelServiceLabel(service) {
  const supplier = service?.connection?.supplier
  return !supplier || service.name.includes(supplier) ? service?.name : `${supplier} · ${service.name}`
}

function renderModelServices(mount, catalog, alive, id) {
  id ??= catalog.roles.main?.service || catalog.services[0]?.id || ''
  const service = catalog.services.find(p => p.id === id)
  const links = catalog.services.map(p => `<button class="btn sm${p.id === id ? ' on' : ''}" data-service-id="${esc(p.id)}">${esc(modelServiceLabel(p))}</button>`).join('')
  mount.innerHTML = settingCard('服务商', `<div class="settings-inline">${links}${actionButton('newModelService','添加服务商')}</div><p class="faint">选中服务商即可编辑地址和 API Key。保存后的 Key 加密存储，留空保留同一服务地址的原 Key。</p>`) +
    (id !== undefined ? settingCard(service?.name || '新建服务商',`<div class="settings-editor">
      ${settingInput('serviceName','备注名称',service?.name)}
      <label class="setting-input" for="serviceDriver"><span>协议</span><select id="serviceDriver">${Object.entries(driverLabels).map(([value,label]) => `<option value="${value}"${value === service?.driver ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      ${settingInput('serviceUrl','接口地址',service?.baseUrl)}${settingInput('serviceKey',service?.hasKey ? 'API Key 已配置，留空保留' : 'API Key','','password')}
      ${settingInput('serviceProxy','聊天请求代理（可选）',service?.proxy)}${service?.hasKey ? '<label><input id="serviceClearKey" type="checkbox"> 清空已保存的 API Key</label>' : ''}</div>`,
      `${service ? actionButton('removeModelService','删除') : ''}${actionButton('saveModelService','保存',true)}`) : '')
  $$('[data-service-id]',mount).forEach(btn => btn.onclick = () => renderModelServices(mount,catalog,alive,btn.dataset.serviceId))
  $('#newModelService',mount).onclick = () => renderModelServices(mount,catalog,alive,'')
  const save = $('#saveModelService',mount)
  if (save) save.onclick = () => settingsMutation(save,async () => {
    const result = await post(modelCatalogPath,{action:'service',id,name:$('#serviceName',mount).value,driver:$('#serviceDriver',mount).value,
      baseUrl:$('#serviceUrl',mount).value,apiKey:$('#serviceKey',mount).value,proxy:$('#serviceProxy',mount).value,
      clearKey:$('#serviceClearKey',mount)?.checked})
    if (alive()) renderModelServices(mount,result.catalog,alive,id || result.catalog.services.at(-1).id)
    void loadState().catch(() => {})
  })
  const remove = $('#removeModelService',mount)
  if (remove) remove.onclick = async () => {
    if (!await confirmBox('删除服务商',`删除「${service.name}」？`)) return
    void settingsMutation(remove,async () => {
      const result = await post(modelCatalogPath,{action:'remove-service',id})
      if (alive()) renderModelServices(mount,result.catalog,alive)
    })
  }
}

const auxModelLabels = {vision:'视觉模型',voice:'云端语音模型',embedding:'远端 Embedding 模型'}

function bindModelChoices(row, services, pendingLists, alive, role) {
  const provider = $('[data-route-service]',row)
  const model = $('[data-route-model]',row)
  const options = $('[data-model-options]',row)
  const refresh = $('[data-model-refresh]',row)
  const status = $('[data-model-status]',row)
  const manualField = model.closest('label')
  const connection = $('[data-route-connection]',row)
  const test = $('[data-role-test]',row)
  const testStatus = $('[data-role-test-status]',row)
  const keyBox = $('[data-route-key-box]',row)
  const key = $('[data-route-key]',row)
  const saveKey = $('[data-save-route-key]',row)
  const keyStatus = $('[data-route-key-status]',row)
  let request = 0
  let testRequest = 0

  const updateConnection = () => {
    const service = services.find(item => item.id === provider.value)
    const target = service?.connection
    keyBox.hidden = !service || service.driver === 'dsh'
    key.placeholder = service?.hasKey ? '已配置，输入新 Key 替换' : '填写所选平台的 API Key'
    const operation = role === 'embedding' ? '/embeddings' : '/chat/completions'
    const endpoint = target?.endpoint && !target.endpoint.endsWith(operation) && service.driver !== 'dsh'
      ? target.endpoint + operation : target?.endpoint
    connection.innerHTML = service
      ? `<span>${esc(target?.supplier || service.name)}</span>${endpoint ? `<code>${esc(endpoint)}</code>` : ''}<span>${service.driver === 'dsh' ? '本机进程' : service.hasKey ? 'API Key 已配置' : '缺少 API Key'}</span>`
      : '<span>请选择提供此模型的服务商</span>'
    test.disabled = !service?.hasKey || !service.baseUrl || !model.value.trim() || target?.nativeDashscope || service.driver === 'dsh'
  }
  const clearValidation = () => { ++testRequest; testStatus.textContent = ''; updateConnection() }
  key.oninput = () => { saveKey.disabled = !key.value.trim() }
  key.onkeydown = event => {
    if (event.key === 'Enter' && !saveKey.disabled) { event.preventDefault(); saveKey.click() }
  }
  saveKey.onclick = async () => {
    const service = services.find(item => item.id === provider.value)
    if (!service || !key.value.trim()) return
    saveKey.disabled = true
    keyStatus.textContent = '正在保存…'
    try {
      const result = await post(modelCatalogPath,{action:'service-key',id:service.id,apiKey:key.value})
      if (!alive() || !row.isConnected) return
      Object.assign(service,result.catalog.services.find(item => item.id === service.id))
      pendingLists.delete(service.id)
      if (provider.value !== service.id) return
      key.value = ''
      keyStatus.textContent = '已加密保存'
      for (const item of $$('[data-model-row]',row.closest('.settings-custom'))) {
        item.dispatchEvent(new Event('service-key-saved'))
      }
      clearValidation()
      void load()
    } catch (error) {
      if (alive() && row.isConnected && provider.value === service.id) keyStatus.textContent = '保存失败：'+error.message
    } finally {
      if (alive() && row.isConnected) saveKey.disabled = !key.value.trim()
    }
  }
  row.addEventListener('service-key-saved',updateConnection)
  $('[data-add-route-service]',row).onclick = () => renderSettings('services','')
  test.onclick = async () => {
    const serial = ++testRequest
    test.disabled = true
    testStatus.textContent = '正在发送测试请求…'
    try {
      const result = await post('/api/models/test-role',{role,service:provider.value,model:model.value.trim()})
      if (alive() && row.isConnected && serial===testRequest) {
        testStatus.textContent = result.dimension ? `验证成功 · ${result.dimension} 维向量` : '验证成功 · 收到模型回复'
      }
    } catch (error) {
      if (alive() && row.isConnected && serial===testRequest) testStatus.textContent = '验证失败：'+error.message
    } finally {
      if (alive() && row.isConnected && serial===testRequest) updateConnection()
    }
  }

  const load = async (reload = false) => {
    const version = ++request
    const id = provider.value
    const service = services.find(item => item.id === id)
    options.replaceChildren(new Option('手动填写模型 ID',''))
    options.disabled = true
    manualField.hidden = false
    refresh.disabled = true
    status.textContent = ''
    updateConnection()
    if (!service || service.driver === 'dsh' || row.closest('#auxRouteFields')?.hidden) return
    if (service.connection?.nativeDashscope) {
      status.textContent = '请选择同一平台的 OpenAI 兼容接口。'
      return
    }
    if (!service.baseUrl) {
      status.textContent = '请先在「服务商」保存接口地址。'
      return
    }

    status.textContent = '正在获取模型列表…'
    let pending = pendingLists.get(id)
    if (reload || !pending) {
      pending = post('/api/models/discover',{serviceId:id})
      pendingLists.set(id,pending)
    }
    const current = () => row.isConnected && alive() && version === request
    try {
      const {models} = await pending
      if (!current()) return
      for (const id of models) options.add(new Option(id,id))
      options.disabled = !models.length
      options.value = models.includes(model.value.trim()) ? model.value.trim() : ''
      manualField.hidden = Boolean(options.value)
      status.textContent = models.length ? '目录来自所选平台。用「验证调用」确认模型支持此用途。' : '服务商未返回可选模型，可以手填模型 ID。'
    } catch (error) {
      if (pendingLists.get(id) === pending) pendingLists.delete(id)
      if (current()) status.textContent = error.message + '。可以手填模型 ID。'
    } finally {
      if (current()) refresh.disabled = false
    }
  }

  provider.onchange = () => {
    key.value = ''
    saveKey.disabled = true
    keyStatus.textContent = ''
    model.value = ''
    model.dispatchEvent(new Event('input',{bubbles:true}))
    void load()
  }
  options.onchange = () => {
    if (!options.value) {
      manualField.hidden = false
      model.focus()
      return
    }
    model.value = options.value
    model.dispatchEvent(new Event('input',{bubbles:true}))
    manualField.hidden = true
  }
  model.addEventListener('input', () => {
    clearValidation()
    options.value = model.value.trim()
    if (options.selectedIndex === -1) options.selectedIndex = 0
  })
  refresh.onclick = () => void load(true)
  void load()
  return load
}

function effectiveRouteLine(route, status = '') {
  return `<div class="model-route-current" aria-label="当前生效配置">
    <strong>当前生效</strong><span>${esc(status || route.supplier)}</span>
    ${route.model ? `<code>${esc(route.model)}</code>` : ''}
    ${route.endpoint ? `<code>${esc(route.endpoint)}</code>` : ''}
    ${route.endpoint && route.protocol !== '本机进程' ? `<span>${esc(route.protocol)} · ${route.hasKey ? 'API Key 已配置' : '缺少 API Key'}</span>` : ''}
  </div>`
}

function renderModelRoles(page,mount,catalog,effective,alive) {
  const {services,roles} = catalog
  const row = (route = {}, role = 'main') => `<div class="settings-model-row" data-model-row>
    <div class="settings-model-field">
      <label class="setting-input"><span>调用平台</span><select data-route-service><option value="">选择服务商</option>${services.filter(s => role === 'main' || s.driver !== 'dsh').map(s => `<option value="${esc(s.id)}"${s.id === route.service ? ' selected' : ''}>${esc(modelServiceLabel(s))}</option>`).join('')}</select></label>
      <div class="model-route-connection" data-route-connection></div>
      <div data-route-key-box hidden>
        <div class="model-route-key-row">
          <label class="setting-input"><span>API Key</span><input type="password" data-route-key autocomplete="new-password"></label>
          <button type="button" class="btn sm" data-save-route-key disabled>保存 Key</button>
        </div>
        <span class="faint" data-route-key-status aria-live="polite"></span>
      </div>
      <div><button type="button" class="btn sm" data-add-route-service>添加服务商</button></div>
    </div>
    <div class="settings-model-field">
      <div class="settings-model-choices"><label class="setting-input"><span>平台模型目录</span><select data-model-options disabled></select></label><button type="button" class="btn sm" data-model-refresh disabled>刷新列表</button></div>
      <label class="setting-input"><span>模型 ID</span><input type="text" data-route-model value="${esc(route.model || '')}" placeholder="从目录选择，或填写平台提供的 ID"></label>
      <div class="faint" data-model-status aria-live="polite"></div>
      <div class="settings-inline"><button type="button" class="btn sm" data-role-test disabled>验证调用</button><span class="faint" data-role-test-status aria-live="polite"></span></div>
    </div>
  </div>`
  const getRow = parent => ({service:$('[data-route-service]',parent).value,model:$('[data-route-model]',parent).value.trim()})
  const pendingLists = new Map()
  if (page !== 'model') {
    const route = effective[page]
    const embedding = page === 'embedding'
    const label = embedding ? '向量检索' : '视觉识图'
    const current = embedding
      ? route.mode === 'remote'
        ? effectiveRouteLine(route,route.supplier + (route.lastFailure ? ' · 最近远端请求失败' : ' · 远端向量'))
        : effectiveRouteLine({},route.mode === 'off' ? '已关闭' : route.requested === 'local' ? '本机向量' : '本机向量 · 远端配置不完整')
      : route.enabled && route.ready ? effectiveRouteLine(route)
        : effectiveRouteLine({},route.enabled ? '配置不完整' : '已关闭')
    const mode = embedding
      ? `<label class="setting-input model-route-mode"><span>检索模式</span><select id="modelRoleMode"><option value="off">关闭向量检索</option><option value="local">仅使用本机向量</option><option value="remote">使用远端向量，失败时用本机</option></select></label>`
      : `<label class="voice-enable"><input type="checkbox" role="switch" id="modelRoleEnabled"${route.enabled?' checked':''}><span>启用外部视觉识图</span></label>`
    mount.innerHTML = settingCard(label,current+mode+`<p class="faint">${embedding
      ? '用于记忆的语义检索。远端模式会把检索用的文字发送给选定平台。'
      : '用于理解图片。验证调用只发送一张测试图。'}</p><div id="auxRouteFields">${row(roles[page],page)}</div>`,actionButton('saveAuxModel','保存',true))
    const selection = $('#modelRoleMode',mount)
    const enabled = $('#modelRoleEnabled',mount)
    const fields = $('#auxRouteFields',mount)
    if (selection) selection.value = route.mode === 'off' ? 'off' : route.requested
    else enabled.checked = route.enabled
    const showFields = () => {
      fields.hidden = selection ? selection.value !== 'remote' : !enabled.checked
    }
    showFields()
    const reloadChoices = bindModelChoices($('[data-model-row]',fields),services,pendingLists,alive,page)
    ;(selection || enabled).onchange = () => {
      showFields()
      if (!fields.hidden) void reloadChoices()
    }
    const btn = $('#saveAuxModel',mount)
    btn.onclick = () => settingsMutation(btn,async () => {
      const result = await post(modelCatalogPath,{action:'roles',[page]:getRow(fields),only:page,
        ...(selection ? {mode:selection.value} : {enabled:enabled.checked})})
      if (alive()) renderModelRoles(page,mount,result.catalog,result.effective,alive)
      void loadState().catch(() => {})
    })
    return
  }
  const summary = Object.entries(auxModelLabels).map(([id,label]) => {
    const route = effective[id]
    const active = id==='embedding' ? route.mode!=='off' : route.enabled
    const local = id==='embedding' && route.mode==='local'
    const model = !active ? '已关闭' : local ? '本机向量' : route.model || '模型由音色决定'
    const supplier = !active || local ? '' : route.provider==='edge' ? 'Microsoft Edge' : route.supplier
    return `<button class="settings-model-tile" data-aux-model="${id}"><span>${label}</span><strong>${esc(model)}</strong>${supplier?`<small>${esc(supplier)}</small>`:''}</button>`
  }).join('')
  mount.innerHTML = settingCard('主模型',effectiveRouteLine(effective.main)+`<p class="faint">负责写回复与调用工具。模型 ID 由所选平台识别，保存前可以验证调用。</p><div id="settingsMainModel">${row(roles.main)}</div>`,actionButton('saveModelRoles','保存主模型与备选',true)) +
    settingCard('手动备选',`<p class="faint">主模型异常时，管理员收到 QQ 提示后可在这里手动切换。</p><div id="settingsBackups"></div>${actionButton('addBackupModel','添加备选')}`) +
    settingCard('其他模型用途',`<div class="settings-tiles">${summary}</div>`)
  $$('[data-aux-model]',mount).forEach(btn => btn.onclick = () => renderSettings(btn.dataset.auxModel))
  bindModelChoices($('#settingsMainModel [data-model-row]',mount),services,pendingLists,alive,'main')
  const backups = $('#settingsBackups',mount)
  const addBackup = (route, persisted) => {
    const wrapper = document.createElement('div')
    wrapper.className = 'settings-backup'
    wrapper.innerHTML = `${row(route)}<div class="settings-inline">${persisted ? '<button class="btn sm" data-use-backup>切换到这个模型</button>' : ''}<button class="btn sm" data-remove-backup>从备选移除</button></div>`
    backups.append(wrapper)
    bindModelChoices($('[data-model-row]',wrapper),services,pendingLists,alive,'main')
    $('[data-remove-backup]',wrapper).onclick = () => wrapper.remove()
    const activate = $('[data-use-backup]',wrapper)
    if (activate) {
      wrapper.addEventListener('input',() => { activate.disabled = true },{once:true})
      activate.onclick = () => settingsMutation(activate,async () => {
      const result = await post(modelCatalogPath,{action:'activate',...route})
      if (alive()) renderModelRoles(page,mount,result.catalog,result.effective,alive)
        await loadState()
      })
    }
  }
  roles.backups.forEach(route => addBackup(route,true))
  $('#addBackupModel',mount).onclick = () => addBackup({},false)
  const save = $('#saveModelRoles',mount)
  save.onclick = () => settingsMutation(save,async () => {
    const result = await post(modelCatalogPath,{action:'roles',only:'chat',main:getRow($('#settingsMainModel',mount)),
      backups:$$('[data-model-row]',backups).map(getRow)})
    if (alive()) renderModelRoles(page,mount,result.catalog,result.effective,alive)
    await loadState()
  })
}

function renderModelDiagnostics(mount) {
  mount.innerHTML = settingCard('主模型诊断',`<div class="settings-inline">${actionButton('settingDiscover','探测模型列表')}${actionButton('settingModelTest','测试主模型')}${actionButton('settingBalance','查 DeepSeek 余额')}</div><pre id="settingDiagnosticOut" class="faint" aria-live="polite"></pre>`)
  const diagnostic = (id, run) => {
    const btn = $(`#${id}`,mount), out = $('#settingDiagnosticOut',mount)
    btn.onclick = async () => {
      btn.disabled = true
      out.textContent = '正在请求…'
      try { out.textContent = await run() }
      catch (e) { out.textContent = e.message }
      finally { btn.disabled = false }
    }
  }
  diagnostic('settingDiscover',async () => {
    const result = await post('/api/models/discover',{})
    return (result.models || []).map(m => m.id).join('、') || '未找到模型'
  })
  diagnostic('settingModelTest',async () => {
    const path = state.settings?.llmProvider === 'gemini' ? '/api/gemini/test' : '/api/deepseek/test'
    const result = await post(path,{model:state.model})
    return result.ok ? `${result.model} 连通正常。${result.reply || result.text || ''}` : result.error
  })
  diagnostic('settingBalance',async () => {
    const r = await api('/api/balance?force=1')
    return r.ok ? `总余额 ${r.total} ${r.currency}` : r.error
  })
}

const legacyModelPicker = $('#modelSel').onchange
const baseSettingsLoadState = loadState
loadState = async function() {
  const result = await baseSettingsLoadState()
  const sel = $('#modelSel'), catalog = result.settings?.modelCatalog
  sel.onchange = legacyModelPicker
  if (catalog) {
    const {main,backups} = catalog.roles
    sel.replaceChildren(new Option(result.model || main.model,''), ...backups.map((route,index) =>
      new Option(`${route.model} · ${catalog.services.find(s => s.id === route.service)?.name || '备选'}`,String(index))), new Option('管理模型…','settings'))
    sel.onchange = async () => {
      const value = sel.value
      sel.value = ''
      if (value === 'settings') { tab('settings'); renderSettings('model'); return }
      if (value === '' || !backups[Number(value)]) return
      sel.disabled = true
      try { await post(modelCatalogPath,{action:'activate',...backups[Number(value)]}); await loadState(); toast('主模型已切换') }
      catch (error) { toast('切换失败：' + error.message) }
      finally { sel.disabled = false }
    }
  }
  return result
}

function attachConversationImpression(platform, kind, id, field) {
  if (!field) return
  const card = document.createElement('details')
  card.className = 'settings-impression'
  card.open = true
  card.innerHTML = '<summary>小鲸鱼总结的印象</summary><p class="faint">正在读取…</p>'
  field.after(card)
  const display = $('p',card)
  void api('/api/settings/conversation-impression?scope='+encodeURIComponent(`${platform}:${kind}:${id}`))
    .then(result => { display.textContent = result.impression || '这个会话还没有生成印象。' })
    .catch(error => { display.textContent = '读取失败：' + error.message })
}

const baseSettingsEditTarget = editTarget
editTarget = function(id,kind) {
  baseSettingsEditTarget(id,kind)
  attachConversationImpression('qq',kind,id,$('#tmPrompt'))
}
