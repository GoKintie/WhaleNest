const dashboardNumber = new Intl.NumberFormat('zh-CN')
const dashboardStorageNumber = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1})
const dashboardSampleTime = new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
let dashboardLoad = 0
let dashboardHostLoading = false
let dashboardCurrentQuote

function dashboardBytes(bytes) {
  const size = bytes / 1024 ** 3
  return size >= 1024 ? dashboardStorageNumber.format(size / 1024) + ' TiB' : dashboardStorageNumber.format(size) + ' GiB'
}

function paintDashboardMeter(id, usage) {
  const node = $(id)
  node.textContent = Number.isFinite(usage) ? usage+'%' : '—'
  node.parentElement.style.setProperty('--fill', Number.isFinite(usage) ? usage+'%' : '0%')
}

async function loadDashboardHost() {
  if (dashboardHostLoading) return
  dashboardHostLoading = true
  const note = $('#dashboardHostNote')
  try {
    const {system,cpu,memory,storage,sampledAt} = await api('/api/dashboard/host')
    $('#dashboardHostSystem').textContent = [system.platform,system.arch].filter(Boolean).join(' ') || '—'
    $('#dashboardHostKernel').textContent = system.release || '—'
    $('#dashboardHostStorage').textContent = storage ? `${dashboardBytes(storage.available)} 可用 / ${dashboardBytes(storage.total)}` : '—'
    $('#dashboardCpuModel').textContent = cpu.model || '—'
    $('#dashboardCpuCores').textContent = cpu.cores > 0 ? dashboardNumber.format(cpu.cores) : '—'
    $('#dashboardMemoryUsed').textContent = memory.total ? dashboardBytes(memory.used) : '—'
    $('#dashboardMemoryTotal').textContent = memory.total ? dashboardBytes(memory.total) : '—'
    paintDashboardMeter('#dashboardCpuPercent',cpu.percent)
    paintDashboardMeter('#dashboardMemoryPercent',memory.percent)
    note.textContent = dashboardSampleTime.format(sampledAt) + ' 更新'
  } catch {
    note.textContent = '主机数据暂不可用'
  } finally {
    dashboardHostLoading = false
  }
}

async function loadDashboardQuote() {
  const next = $('#dashboardQuoteNext')
  if (next.disabled) return
  next.disabled = true
  const kind = dashboardCurrentQuote?.kind === 'literature' ? 'anime' : 'literature'
  try {
    const quote = await api('/api/dashboard/quote?kind='+kind)
    dashboardCurrentQuote = quote
    $('#dashboardQuoteText').textContent = quote.text
    $('#dashboardQuoteWork').textContent = quote.work ? '《'+quote.work+'》' : ''
    $('#dashboardQuoteAuthor').textContent = quote.author
    $('#dashboardQuoteSource').hidden = quote.source !== 'hitokoto'
    $('#dashboardQuoteCopy').disabled = false
  } catch {
    if (!dashboardCurrentQuote) $('#dashboardQuoteText').textContent = '名言暂不可用'
    else toast('换句失败，请再试一次')
  } finally {
    next.disabled = false
  }
}

async function copyDashboardQuote() {
  if (!dashboardCurrentQuote) return
  const {text,work,author} = dashboardCurrentQuote
  const credit = [work && '《'+work+'》',author].filter(Boolean).join(' ')
  const value = credit ? text+' —— '+credit : text
  try {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable')
    await navigator.clipboard.writeText(value)
  } catch {
    // The LAN WebUI can also be opened over plain HTTP.
    const input = document.createElement('textarea')
    input.value = value
    input.readOnly = true
    input.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
    const focused = document.activeElement
    document.body.append(input)
    input.select()
    let copied = false
    try { copied = document.execCommand('copy') }
    catch {}
    finally { input.remove(); focused?.focus() }
    if (!copied) return toast('复制失败，请选中名言手动复制')
  }
  toast('已复制名言')
}

function renderDashboardStatus(s) {
  const setChannel = (id, connected, label) => {
    const el = $(id)
    el.textContent = label
    el.classList.toggle('connected', connected)
  }
  setChannel('#dashboardQQ',!!s.wsConnected,s.wsConnected?'已连接':s.wsRetrying?'正在重连':'未连接')
  setChannel('#dashboardWechat',!!s.wechat?.connected,s.wechat?.connected?'已连接':s.wechat?.enabled?'未连接':'未启用')
  $('#dashboardBotStatus').textContent = s.paused?'回复已暂停':(s.wsConnected||s.wechat?.connected)?'在线':'等待渠道连接'
  $('#dashboardModel').textContent = s.model || '未设置'
  $('#dashboardRunning').textContent = dashboardNumber.format(s.running || 0)
  $('#dashboardQueued').textContent = dashboardNumber.format(s.queued || 0)
  const minutes = Math.floor(s.uptime / 60)
  $('#dashboardUptime').textContent = !Number.isFinite(minutes)?'—':minutes>=1440?`${Math.floor(minutes/1440)} 天 ${Math.floor(minutes%1440/60)} 小时`:minutes>=60?`${Math.floor(minutes/60)} 小时 ${minutes%60} 分`:`${minutes} 分钟`
  const review = s.reviewCounts || {}
  $('#dashboardStickerReview').textContent = dashboardNumber.format(review.pendingStickers || 0)
  $('#dashboardExpressionReview').textContent = dashboardNumber.format(review.expressions?.pending ?? review.pendingExpressions ?? 0)
}

function dashboardChats() {
  return state.chats.filter(chat=>!chat.pinned && chat.count>0 && chat.ts>0 && Number.isFinite(Number(chat.ts))).sort((a,b)=>b.ts-a.ts)
}

function openDashboardChat(chat) {
  if (!chat) return tab('chat')
  if (state.convoPlatform !== 'all') state.convoPlatform = platformForChat(chat)
  state.convoFilter = 'all'
  state.convoQuery = ''
  $('#searchConvo').value = ''
  $$('[data-chat-channel]').forEach(b=>b.classList.toggle('on',b.dataset.chatChannel===state.convoPlatform))
  $$('#filter .chip').forEach(b=>b.classList.toggle('on',b.dataset.f==='all'))
  state.chat = chat.chat; state.chatKind = chat.kind; state.chatTitle = chat.title
  $('#chatWrap').dataset.view = 'thread'
  tab('chat')
  void loadChat(chat.chat).catch(error=>toast('读取对话失败：'+error.message))
}

function paintDashboardChats() {
  const list = $('#dashboardRecent')
  const chats = dashboardChats().slice(0,4)
  list.innerHTML = chats.length ? chats.map((chat,index)=>{
    const name = chat.title || '未命名会话'
    const channel = channelName(platformForChat(chat))
    const avatar = /^https:\/\/(?:q1\.qlogo\.cn|p\.qlogo\.cn|wx\.qlogo\.cn)\//i.test(chat.avatar)
      ? `<img src="${esc(chat.avatar)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : ''
    return `<button type="button" class="dashboard-thread" data-dash-chat="${index}"><span class="dashboard-thread-avatar" aria-hidden="true"><span>${esc(name.slice(0,1))}</span>${avatar}</span><span class="dashboard-thread-text"><strong>${esc(name)}</strong><small>${esc(chat.last||'')}</small></span><span class="dashboard-thread-meta"><span>${esc(channel)} · ${chat.kind==='group'?'群聊':'私聊'}</span><time>${esc(chatDateTime.format(Number(chat.ts)))}</time></span></button>`
  }).join('') : '<p class="dashboard-empty">暂无近期 QQ 或微信对话</p>'
  $$('[data-dash-chat]',list).forEach(button=>{
    button.onclick = () => openDashboardChat(chats[Number(button.dataset.dashChat)])
    const avatar = $('img',button)
    if (avatar) avatar.onerror = () => avatar.remove()
  })
  $('#dashboardChat').textContent = chats.length ? '继续聊天 ↗' : '打开对话 ↗'
}

function paintDashboardChart({days,partial}) {
  const chart = $('#dashboardChart')
  const max = Math.max(1,...days.flatMap(d=>[d.received,d.sent]))
  $('#dashboardReceived').textContent = dashboardNumber.format(days.reduce((n,d)=>n+d.received,0))
  $('#dashboardSent').textContent = dashboardNumber.format(days.reduce((n,d)=>n+d.sent,0))
  chart.innerHTML = days.map(day=>{
    const label = day.date.slice(5).replace(/^0/,'').replace(/-0?/,'/')
    const detail = `${label} 接收 ${day.received} 条，发出 ${day.sent} 条`
    return `<div class="dashboard-day" role="img" aria-label="${esc(detail)}" title="${esc(detail)}"><div class="dashboard-bars"><i style="--height:${day.received/max*100}%"></i><i style="--height:${day.sent/max*100}%"></i></div><span>${esc(label)}</span></div>`
  }).join('')
  $('#dashboardActivityNote').textContent = partial?'按可读取的近期聊天统计':'按本机时区统计'
}

async function loadDashboard() {
  const request = ++dashboardLoad
  void loadDashboardHost()
  if (!dashboardCurrentQuote) void loadDashboardQuote()
  const now = new Date()
  $('#dashboardDate').textContent = new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(now)
  paintDashboardChats()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const refresh = $('#dashboardRefresh')
  refresh.disabled = true
  if (!$('#dashboardChart').childElementCount) $('#dashboardActivityNote').textContent = '正在读取聊天活动…'
  try {
    const activity = api('/api/dashboard/activity?tz='+encodeURIComponent(timezone)).then(data=>{
      if (request===dashboardLoad) paintDashboardChart(data)
    }).catch(error=>{
      if (request===dashboardLoad) $('#dashboardActivityNote').textContent = '读取失败：'+error.message
    })
    if (state.dashboardLoaded) await loadChats().then(()=>{ if (request===dashboardLoad) paintDashboardChats() }).catch(()=>{})
    state.dashboardLoaded = true
    await activity
  } finally { if (request===dashboardLoad) refresh.disabled=false }
}

$('#dashboardRefresh').onclick = () => {
  void loadState().catch(error=>toast('刷新状态失败：'+error.message))
  void loadDashboard()
}
$('#dashboardChat').onclick = () => openDashboardChat(dashboardChats()[0])
$('#dashboardSettings').onclick = () => { tab('settings'); renderSettings('allow') }
$('#dashboardQuoteNext').onclick = () => void loadDashboardQuote()
$('#dashboardQuoteCopy').onclick = () => void copyDashboardQuote()

const skillDetails = {
  list_abilities:['能力自查','系统与文件'],search_web:['联网搜索','查询与娱乐'],run_shell:['运行命令','系统与文件'],
  read_file:['读取文件','系统与文件'],read_config:['查看配置','系统与文件'],write_file:['写入文件','系统与文件'],list_dir:['浏览文件夹','系统与文件'],
  remember:['管理记忆','记忆与记录'],recall:['回忆旧事','记忆与记录'],write_diary:['写日记','记忆与记录'],observe_world:['记录见闻','记忆与记录'],
  send_message:['发送文字','交流与媒体'],send_voice:['发送语音','交流与媒体'],send_image:['发送图片','交流与媒体'],send_sticker:['发送表情包','交流与媒体'],
  set_reminder:['设置提醒','交流与媒体'],post_qzone:['发表 QQ 空间说说','交流与媒体'],phone_control:['手机控制','系统与文件'],
  bilibili:['浏览 B 站','查询与娱乐'],skland_sign:['森空岛签到','查询与娱乐'],draw_tarot:['抽塔罗牌','查询与娱乐'],daily_fortune:['今日运势','查询与娱乐'],meme_lookup:['查梗','查询与娱乐'],
}
let skillCatalog = [], skillCategory = '全部'

function renderSkillCards(catalog, details = {}) {
  skillCatalog = String(catalog||'').split('\n').filter(line=>line.startsWith('- ')).map(line=>{
    const match = line.match(/^- `([^`]+)`(?:\(([^)]*)\))?：(.*)$/)
    if (!match) return {name:line.slice(2),label:line.slice(2),category:'其他',args:'',description:''}
    const [,name,args,description] = match
    const metadata = Object.hasOwn(details, name) ? details[name] : undefined
    const [label,category] = skillDetails[name] || [name,'其他']
    const access = metadata && [
      metadata.audience === 'chat' ? '已获准聊天的用户' : '仅管理员',
      ...metadata.platforms.map(platform => ({qq:'QQ',wechat:'微信',webui:'Web 对话'})[platform] || platform),
    ].join(' · ')
    return {name,args,label:metadata?.label || label,category:metadata?.category || category,description,access}
  })
  const categories = ['全部',...new Set(skillCatalog.map(item=>item.category))]
  if (!categories.includes(skillCategory)) skillCategory = '全部'
  const filters = $('#skillCategories')
  filters.innerHTML = categories.map(category=>`<button class="skill-filter" type="button" aria-pressed="${category===skillCategory}">${esc(category)}</button>`).join('')
  $$('button',filters).forEach(button=>{button.onclick=()=>{
    skillCategory = button.textContent
    $$('button',filters).forEach(item=>item.setAttribute('aria-pressed',String(item===button)))
    filterSkillCards()
  }})
  $('#navSkill').textContent = skillCatalog.length
  filterSkillCards()
}

function filterSkillCards() {
  const q = $('#skillSearch').value.trim().toLowerCase()
  const visible = skillCatalog.filter(item=>(skillCategory==='全部'||item.category===skillCategory) && `${item.label} ${item.name} ${item.description}`.toLowerCase().includes(q))
  $('#skillHint').textContent = `${visible.length} 项`
  $('#skillList').innerHTML = visible.length ? visible.map(item=>`<article class="skill-entry"><header><h3>${esc(item.label)}</h3><small>${esc(item.category)}</small></header><p>${esc(item.description)}</p><details><summary>调用信息</summary><code>${esc(item.name)}${item.args ? `(${esc(item.args)})` : '()'}</code>${item.access ? `<p>${esc(item.access)}</p>` : ''}</details></article>`).join('') : '<div class="empty">没有符合条件的能力</div>'
}
$('#skillSearch').oninput = filterSkillCards
