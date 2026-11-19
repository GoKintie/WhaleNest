/* Whale Nest 3.6. Runs after the existing compatibility UI, without CDN dependencies. */
const V36_MEMORY_MODULES = {
  overview: ['记忆概览', '所有相处留下的线索'], graph: ['关联图谱', '人物、概念与文字片段之间的联系'],
  people: ['人物画像', '当前印象、事实与变化历史'], recall: ['事实与检索', '检查她想起了什么，以及为什么想起'],
  diary: ['她的日常', '日记与当天的小事'], archive: ['接力与归档', '对话结束之后，进度仍有迹可循'], core: ['核心与观察', '稳定的记忆、人格与人间观察'],
}
const TREE_COLOR = { person: '#317caa', group: '#9773bb', fact: '#39977e', concept: '#b38a4f', scene: '#bf7f73', episode: '#718897' }
const TREE_LABEL = { person: '人物', group: '群聊', fact: '事实', concept: '概念', scene: '情景', episode: '往事' }
state.memModule = 'overview'
state.memoryFiles = []
state.memoryPeople = []
const v36Graph = { nodes: [], edges: [], positions: new Map(), width: 900, height: 580, tx: 0, ty: 0, scale: 1, selected: '', pointers: new Map(), moved: false }

function v36Text(value) {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(v36Text).filter(Boolean).join('\n')
  return v36Text(value.summary ?? value.text ?? value.fact ?? value.content ?? value.label ?? value.description ?? '')
}
function v36Date(ts, withTime = false) {
  if (!ts) return '时间未记录'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return String(ts)
  return d.toLocaleString('zh-CN', withTime ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { year: 'numeric', month: '2-digit', day: '2-digit' })
}
function v36Empty(title, description = '') {
  return `<div class="memory-empty"><b>${esc(title)}</b>${description ? `<p>${esc(description)}</p>` : ''}</div>`
}
function v36PlainPreview(content) {
  const lines = String(content || '').split('\n')
  let out = '', list = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!/^[-*]\s+/.test(line) && list) { out += '</ul>'; list = false }
    if (!line) continue
    if (/^#\s+/.test(line)) out += `<h2>${esc(line.replace(/^#\s+/, ''))}</h2>`
    else if (/^#{2,6}\s+/.test(line)) out += `<h3>${esc(line.replace(/^#{2,6}\s+/, ''))}</h3>`
    else if (/^[-*]\s+/.test(line)) { if (!list) { out += '<ul>'; list = true }; out += `<li>${esc(line.replace(/^[-*]\s+/, ''))}</li>` }
    else out += `<p>${esc(line)}</p>`
  }
  return out + (list ? '</ul>' : '')
}
function memLabel(file) {
  if (file === 'profile.md') return '她是谁 · 人格档案'
  if (file === 'core_memory.md') return '永久核心记忆'
  if (file === 'human-world.md') return '人间观察信笺'
  if (file === 'style/slang.md') return '学会的表达与黑话'
  if (file.startsWith('diary/')) return file.slice(6, 16) + ' 的日记'
  if (file.startsWith('events/')) return file.slice(7, 17) + ' 的小事'
  if (file.startsWith('people/')) { const n = file.slice(7).replace(/\.md$/, ''); return n.startsWith('group_') ? '群聊印象 · ' + n.slice(6) : '人物印象 · ' + n }
  if (file.startsWith('handover/')) return '接力记录 · ' + file.slice(9).replace(/\.md$/, '')
  if (file.startsWith('archives/')) return '会话归档 · ' + file.slice(9).replace(/\.md$/, '')
  return file
}
function v36FileModule(file) {
  if (/^(diary|events)\//.test(file)) return 'diary'
  if (/^(archives|handover)\//.test(file)) return 'archive'
  return 'core'
}
function v36ModuleFiles() {
  const list = state.memoryFiles || []
  if (state.memModule === 'diary') return list.filter(f => /^(diary|events)\//.test(f.file)).sort((a, b) => b.file.localeCompare(a.file))
  if (state.memModule === 'archive') return list.filter(f => /^(archives|handover)\//.test(f.file)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
  return list.filter(f => !/^(diary|events|archives|handover|people)\//.test(f.file))
}
async function v36OptionalApi(path) {
  try { return await api(path) } catch (e) { return { unavailable: true, error: String(e.message || e), items: [] } }
}
function showMemoryModule(name) {
  if (!V36_MEMORY_MODULES[name]) name = 'overview'
  state.memModule = name
  state.memTab = name === 'graph' ? 'tree' : 'file'
  $$('.memory-tabs button').forEach(b => { b.classList.toggle('on', b.dataset.memoryModule === name); b.setAttribute('aria-current', b.dataset.memoryModule === name ? 'page' : 'false') })
  $('#memoryOverview').classList.toggle('hidden', name !== 'overview')
  $('#memoryPeoplePanel').classList.toggle('hidden', name !== 'people')
  $('#memoryRecallPanel').classList.toggle('hidden', name !== 'recall')
  $('#treeWrap').classList.toggle('hidden', name !== 'graph')
  const fileMode = ['diary', 'archive', 'core'].includes(name)
  $('#memWrap').classList.toggle('hidden', !fileMode)
  if (name === 'overview') renderMemoryOverview()
  if (name === 'people') loadMemoryPeople()
  if (name === 'recall') loadMemoryTrace()
  if (name === 'graph') drawTree()
  if (fileMode) {
    const [label, description] = V36_MEMORY_MODULES[name]
    $('#memLibraryTitle').textContent = label
    $('#memLibraryKicker').textContent = { diary: 'DIARY & MOMENTS', archive: 'HANDOVER & ARCHIVE', core: 'CORE & REFLECTIONS' }[name]
    $('#writeDiary').classList.toggle('hidden', name !== 'diary')
    renderMemoryFiles()
    if (state.memFile && v36ModuleFiles().some(f => f.file === state.memFile)) {
      loadMemFile(state.memFile).catch(e => toast('读取失败：' + e.message))
    } else {
      state.memFile = ''
      $('#memWrap').dataset.view = 'list'
      $('#memName').textContent = '选择一段记忆'
      $('#memMeta').textContent = ''
      $('#memPreview').innerHTML = v36Empty(label, description + '。从记录列表中选择一项开始阅读。')
      $('#memBox').value = ''
      setMemoryEditing(false)
    }
  }
}
function applyMemTab() { showMemoryModule(state.memTab === 'tree' ? 'graph' : (['diary', 'archive', 'core'].includes(state.memModule) ? state.memModule : 'core')) }
$$('[data-memory-module]').forEach(b => { b.onclick = () => showMemoryModule(b.dataset.memoryModule) })
$$('[data-memory-jump]').forEach(b => { b.onclick = () => showMemoryModule(b.dataset.memoryJump) })

async function loadMemList() {
  try {
    const r = await api('/api/memory')
    state.memoryFiles = Array.isArray(r.files) ? r.files : []
    state.diaryList = state.memoryFiles.filter(f => f.file.startsWith('diary/')).sort((a, b) => b.file.localeCompare(a.file))
    showMemoryModule(state.memModule || 'overview')
  } catch (e) {
    $('#memoryRecent').innerHTML = v36Empty('暂时无法读取记忆', e.message)
    toast('记忆加载失败：' + e.message)
  }
}
function renderMemoryOverview() {
  const files = state.memoryFiles || []
  const t = state.lastState?.memoryTree || {}
  const cards = [
    ['记忆片段', t.nodes ?? t.total ?? '—', '人物、事实与往事的联系', '◌'],
    ['人物档案', state.lastState?.peopleCount ?? state.memoryPeople?.length ?? files.filter(f => f.file.startsWith('profiles/') || f.file.startsWith('people/') && !f.file.startsWith('people/group_')).length, '每个人都有自己的来处', '人'],
    ['日记与小事', files.filter(f => /^(diary|events)\//.test(f.file)).length, '让日常不只停在当前对话', '日'],
    ['会话归档', files.filter(f => /^(archives|handover)\//.test(f.file)).length, '承接上一段聊天的进度', '↗'],
  ]
  $('#memoryStats').innerHTML = cards.map(([label, count, hint, icon]) => `<div class="memory-stat"><span>${esc(label)}</span><i aria-hidden="true">${esc(icon)}</i><b>${esc(count)}</b><small>${esc(hint)}</small></div>`).join('')
  const recent = files.slice().sort((a, b) => (Number(b.mtime || 0) - Number(a.mtime || 0)) || b.file.localeCompare(a.file)).slice(0, 4)
  const box = $('#memoryRecent')
  box.innerHTML = recent.length ? recent.map((f, i) => `<button class="memory-record" data-recent-index="${i}"><span class="record-icon">${/diary/.test(f.file) ? '日' : /people/.test(f.file) ? '人' : '记'}</span><span><span class="record-title">${esc(memLabel(f.file))}</span><span class="record-sub">${esc(v36Date(f.mtime))} · ${esc(fmtSize(f.size || 0))}</span></span><span class="record-arrow">↗</span></button>`).join('') : v36Empty('记忆从下一次聊天开始', '产生的日记、人物印象和归档会出现在这里。')
  $$('[data-recent-index]', box).forEach(b => { b.onclick = () => openMemoryFile(recent[Number(b.dataset.recentIndex)].file) })
  loadMemoryTrace(true)
}
function renderMemoryFiles() {
  const list = v36ModuleFiles()
  const box = $('#memList')
  box.innerHTML = list.length ? list.map((f, i) => `<button class="memory-file-card${f.file === state.memFile ? ' on' : ''}" data-file-index="${i}"><b>${esc(memLabel(f.file))}</b><span>${esc(v36Date(f.mtime))} · ${esc(fmtSize(f.size || 0))}</span></button>`).join('') : v36Empty('这里还没有记录', '新的内容会自动归入这个模块。')
  $$('[data-file-index]', box).forEach(b => { b.onclick = () => openMemoryFile(list[Number(b.dataset.fileIndex)].file) })
}
async function openMemoryFile(file) {
  if (file.startsWith('people/')) {
    showMemoryModule('people')
    const id = file.slice(7).replace(/\.md$/, '')
    await openMemoryPerson({ id, file, name: memLabel(file) })
    return
  }
  state.memFile = file
  showMemoryModule(v36FileModule(file))
  $('#memWrap').dataset.view = 'thread'
  try { await loadMemFile(file) } catch (e) { toast('读取失败：' + e.message) }
}
function setMemoryEditing(on) {
  $('#memBox').classList.toggle('hidden', !on)
  $('#memPreview').classList.toggle('hidden', on)
  $('#saveMem').classList.toggle('hidden', !on)
  $('#editMem').textContent = on ? '取消编辑' : '编辑'
  $('#editMem').dataset.editing = on ? '1' : '0'
}
async function loadMemFile(file) {
  const r = await api('/api/memory?file=' + encodeURIComponent(file))
  if (state.memFile && state.memFile !== file) return
  state.memFile = file
  const content = r.content || ''
  $('#memBox').value = content
  $('#memName').textContent = memLabel(file)
  $('#memMeta').textContent = content.length + ' 字'
  const meta = (state.memoryFiles || []).find(f => f.file === file)
  $('#memPreview').innerHTML = `<div class="reading-meta">${esc(memLabel(file))} · ${esc(v36Date(meta?.mtime))} · ${content.length} 字</div>` + (v36PlainPreview(content) || v36Empty('这条记录还是空的', '点击编辑，为她留下一条新的线索。'))
  setMemoryEditing(false)
  const idx = state.diaryList.findIndex(f => f.file === file)
  state.diaryIdx = idx
  $('#diaryPrev').classList.toggle('hidden', !(idx >= 0 && idx < state.diaryList.length - 1))
  $('#diaryNext').classList.toggle('hidden', !(idx > 0))
  renderMemoryFiles()
}
$('#editMem').onclick = () => { if (!state.memFile) return toast('先选择一条记录'); setMemoryEditing($('#editMem').dataset.editing !== '1') }
$('#memBox').oninput = () => { $('#memMeta').textContent = $('#memBox').value.length + ' 字' }
$('#mobileBackMemList').onclick = () => { $('#memWrap').dataset.view = 'list' }
$('#saveMem').onclick = async () => {
  if (!state.memFile) return
  const b = $('#saveMem'); b.disabled = true
  try { await post('/api/memory', { file: state.memFile, content: $('#memBox').value }); await loadMemFile(state.memFile); toast('这段记忆已保存') } catch (e) { toast('保存失败：' + e.message) } finally { b.disabled = false }
}
$('#diaryPrev').onclick = () => { const f = state.diaryList[(state.diaryIdx ?? 0) + 1]; if (f) openMemoryFile(f.file) }
$('#diaryNext').onclick = () => { const f = state.diaryList[(state.diaryIdx ?? 0) - 1]; if (f) openMemoryFile(f.file) }
$('#writeDiary').onclick = async () => {
  const b = $('#writeDiary'); b.disabled = true
  try { const r = await post('/api/diary', { force: true }); if (r.error) throw new Error(r.error); toast('新日记已经写好'); await loadMemList() } catch (e) { toast('日记生成失败：' + e.message) } finally { b.disabled = false }
}
$('#writeImpression').onclick = async () => {
  const b = $('#writeImpression'); b.disabled = true
  try { const r = await post('/api/impressions', {}); if (r.error) throw new Error(r.error); toast('人物印象已更新'); await loadMemoryPeople() } catch (e) { toast('更新失败：' + e.message) } finally { b.disabled = false }
}
$('#refreshMemory').onclick = () => loadMemList()

async function loadMemoryPeople() {
  $('#peopleGrid').innerHTML = v36Empty('正在整理人物档案…')
  const r = await v36OptionalApi('/api/memory/people')
  if (state.memModule !== 'people') return
  if (!r.unavailable) state.memoryPeople = Array.isArray(r.items) ? r.items : []
  else state.memoryPeople = (state.memoryFiles || []).filter(f => f.file.startsWith('people/')).map(f => ({ id: f.file.slice(7).replace(/\.md$/, ''), name: memLabel(f.file), file: f.file, summary: '打开查看当前保存的印象。', legacy: true }))
  renderMemoryPeople()
}
function renderMemoryPeople() {
  const q = $('#peopleFilter').value.trim().toLowerCase()
  const list = (state.memoryPeople || []).filter(p => `${p.name || ''} ${p.id || ''} ${v36Text(p.summary)}`.toLowerCase().includes(q))
  $('#peopleCount').textContent = list.length + ' 份档案'
  const box = $('#peopleGrid')
  box.innerHTML = list.length ? list.map((p, i) => `<button class="person-card${state.selectedPerson === String(p.id) + ':' + String(p.scope || '') ? ' selected' : ''}" data-person-index="${i}"><div class="person-top"><span class="person-avatar">${esc((p.name || p.id || '人').slice(0, 1))}</span><span><b>${esc(p.name || p.id)}</b><span class="person-id">${esc(p.id)}</span></span></div><p>${esc(v36Text(p.summary) || '还没有形成稳定印象，事实和互动仍在积累。')}</p><span class="scope-tag">${esc(p.scope || '原始档案')}</span><span class="memory-tag">${Array.isArray(p.facts) ? p.facts.length : Number(p.factCount || 0)} 条事实</span><span class="memory-tag">${Array.isArray(p.versions) ? p.versions.length : Number(p.versionCount || 0)} 次记录</span></button>`).join('') : v36Empty(q ? '没有匹配的熟人' : '还没有人物档案', q ? '换个昵称或关键词试试。' : '与她互动后，人物印象会在这里逐渐积累。')
  $$('[data-person-index]', box).forEach(b => { b.onclick = () => openMemoryPerson(list[Number(b.dataset.personIndex)]) })
}
async function openMemoryPerson(person) {
  state.selectedPerson = String(person.id) + ':' + String(person.scope || '')
  const detail = $('#personDetail')
  detail.classList.remove('hidden'); detail.innerHTML = v36Empty('正在读取印象与来源…')
  renderMemoryPeople()
  const r = await v36OptionalApi('/api/memory/person?id=' + encodeURIComponent(person.id) + '&scope=' + encodeURIComponent(person.scope || ''))
  let profile = r.profile || person, versions = r.versions || person.versions || []
  if (r.unavailable && person.file) {
    const file = await v36OptionalApi('/api/memory?file=' + encodeURIComponent(person.file))
    profile = { ...person, summary: file.content || '暂无可读取的摘要。' }
  }
  if (state.selectedPerson !== String(person.id) + ':' + String(person.scope || '')) return
  const facts = Array.isArray(profile.facts) ? profile.facts : []
  if (!Array.isArray(versions)) versions = []
  detail.innerHTML = `<button class="text-btn detail-close" id="closePersonDetail">关闭</button><span class="section-kicker">PERSON PROFILE</span><h3>${esc(profile.name || person.name || person.id)}</h3><span class="scope-tag">${esc(profile.scope || person.scope || '原始档案')}</span><span class="person-id">${esc(person.id)}</span><h4>当前印象</h4><p>${esc(v36Text(profile.summary) || '暂时还没有稳定摘要。')}</p><h4>累积事实 · ${facts.length}</h4>${facts.length ? `<ul class="fact-list">${facts.map(f => `<li>${esc(v36Text(f))}<small>${esc(v36Text(f.source || f.sourceMessageId || (f.sourceIds?.length?f.sourceIds.join('、'):'') || f.chat || '来源未记录'))}${f.ts || f.createdAt ? ' · ' + esc(v36Date(f.ts || f.createdAt, true)) : ''}</small></li>`).join('')}</ul>` : '<p class="faint">暂无结构化事实。新的事实会持续累积，不会只保留最新摘要。</p>'}<h4>印象更新历史 · ${versions.length}</h4>${versions.length ? versions.slice().reverse().map(v => `<div class="profile-version"><b>${esc(v36Date(v.ts || v.at || v.createdAt || v.updatedAt, true))}</b><p>${esc(v36Text(v.summary || v))}</p></div>`).join('') : '<p class="faint">还没有历史版本。首次更新后会从这里开始记录。</p>'}`
  $('#closePersonDetail').onclick = () => { detail.classList.add('hidden'); state.selectedPerson = ''; renderMemoryPeople() }
}
$('#peopleFilter').oninput = () => renderMemoryPeople()

function v36RecallCards(items) {
  return items.map((it, i) => `<article class="recall-result"><div><span class="memory-tag recalled">${i + 1} · ${esc(TREE_LABEL[it.type] || it.source || '记忆片段')}</span>${it.chat || it.chatId ? `<span class="scope-tag">${esc(it.chat || it.chatId)}</span>` : ''}${it.when || it.ts ? `<span class="scope-tag">${esc(v36Date(it.when || it.ts, true))}</span>` : ''}</div><p>${esc(v36Text(it))}</p><div class="recall-reason">${esc(it.cue || it.reason || '根据当前查询与记忆内容匹配')}${it.score != null ? ' · 得分 ' + esc(it.score) : ''}${it.similarity != null ? ' · 语义相似 ' + esc(it.similarity) : ''}</div>${it.source ? `<div class="recall-reason">来源：${esc(v36Text(it.source))}</div>` : ''}</article>`).join('')
}
$('#memoryRecallRun').onclick = async () => {
  const q = $('#memoryQuery').value.trim(), chat = $('#memoryChatScope').value.trim(), kind = $('#memoryKindScope').value
  if (!q) return toast('输入一句想回忆的话题')
  const b = $('#memoryRecallRun'); b.disabled = true
  $('#memoryResults').innerHTML = v36Empty('正在寻找相关的片段…', '结果仅用于检查本次检索，不会发送到聊天窗口。')
  try {
    const r = await api('/api/memory/recall?query=' + encodeURIComponent(q) + '&chat=' + encodeURIComponent(chat) + '&kind=' + encodeURIComponent(kind))
    const items = Array.isArray(r.items) ? r.items : []
    $('#memoryResults').innerHTML = items.length ? v36RecallCards(items) : v36Empty('这次没有想起相关内容', '可以换一个具体的人名、事件或时间。没有命中时不会拼凑无关记忆。')
  } catch (e) { $('#memoryResults').innerHTML = v36Empty('检索暂时不可用', e.message === 'HTTP 404' ? '记忆检索服务尚未就绪，现有文件和图谱仍可正常查看。' : e.message) } finally { b.disabled = false }
}
$('#memoryQuery').onkeydown = e => { if (e.key === 'Enter') $('#memoryRecallRun').click() }
async function loadMemoryTrace(overview = false) {
  const chat = overview ? '' : $('#memoryChatScope').value.trim()
  const r = await v36OptionalApi('/api/memory/trace?chat=' + encodeURIComponent(chat))
  const items = Array.isArray(r.items) ? r.items.slice(-8).reverse() : []
  const html = items.length ? items.slice(0, overview ? 3 : 8).map(it => {
    const used = it.items || it.recalled || it.memories || it.results || []
    return `<div class="trace-item"><div class="trace-time">${esc(v36Date(it.ts || it.at || it.createdAt, true))} · ${esc(it.chat || it.chatId || '会话未记录')}</div><div class="trace-text">${esc(it.query || it.inputText || it.text || '一次记忆召回')}</div><div style="margin-top:9px">${Array.isArray(used) && used.length ? used.slice(0, 5).map(m => `<span class="memory-tag recalled">${esc(v36Text(m).slice(0, 38) || m.id || '记忆片段')}</span>`).join('') : '<span class="memory-tag">本轮没有采用长期记忆</span>'}</div></div>`
  }).join('') : v36Empty(r.unavailable ? '召回记录尚未就绪' : '下一次想起，会留下依据', r.unavailable ? '服务就绪后会显示真实记录；当前不展示示例或模拟数据。' : '她在对话中检索记忆后，这里会记录查询与命中的片段。')
  if (overview) $('#memoryOverviewTrace').innerHTML = html
  else $('#memoryTrace').innerHTML = html
}
$('#reloadRecallTrace').onclick = () => loadMemoryTrace()

/* Graph layout and camera. Text snippets remain nodes; complete source is in the detail pane. */
function v36LayoutGraph(nodes) {
  const mobile = matchMedia('(max-width:680px)').matches
  const columns = Math.min(nodes.length || 1, mobile ? 2 : 4)
  return new Map(nodes.map((n,i)=>[n.id,{n,x:(i%columns)*224,y:Math.floor(i/columns)*115}]))
}
function v36GraphSize() {
  const rect = $('#treeCanvas').getBoundingClientRect()
  v36Graph.width = Math.max(280, rect.width || 900); v36Graph.height = Math.max(280, rect.height || 580)
  $('#treeSvg').setAttribute('viewBox', `0 0 ${v36Graph.width} ${v36Graph.height}`)
}
function v36ApplyCamera() {
  const viewport = $('#graphViewport')
  if (viewport) viewport.setAttribute('transform', `translate(${v36Graph.tx},${v36Graph.ty}) scale(${v36Graph.scale})`)
  $('#graphZoomLabel').textContent = Math.round(v36Graph.scale * 100) + '%'
}
function v36FitGraph() {
  v36GraphSize()
  const list = [...v36Graph.positions.values()]
  if (!list.length) return
  const minX = Math.min(...list.map(p => p.x)) - 110, maxX = Math.max(...list.map(p => p.x)) + 110
  const minY = Math.min(...list.map(p => p.y)) - 60, maxY = Math.max(...list.map(p => p.y)) + 60
  const fitWidth=(v36Graph.width-22)/(maxX-minX||1), fitHeight=(v36Graph.height-90)/(maxY-minY||1)
  v36Graph.scale = Math.max(.25,Math.min(1.15,fitWidth,Math.max(.78,fitHeight)))
  v36Graph.tx = v36Graph.width / 2 - (minX + maxX) / 2 * v36Graph.scale
  v36Graph.ty = (maxY-minY)*v36Graph.scale>v36Graph.height-65
    ? 22-minY*v36Graph.scale : v36Graph.height / 2 - (minY + maxY) / 2 * v36Graph.scale
  v36ApplyCamera()
}
function v36ZoomGraph(factor, px = v36Graph.width / 2, py = v36Graph.height / 2) {
  const next = Math.max(.1, Math.min(3.5, v36Graph.scale * factor)), r = next / v36Graph.scale
  v36Graph.tx = px - (px - v36Graph.tx) * r; v36Graph.ty = py - (py - v36Graph.ty) * r; v36Graph.scale = next
  v36ApplyCamera()
}
let graphRequest = 0, graphSearchTimer
async function v36GraphFocus(id) {
  if (await drawTree(id)) v36SelectGraphNode(id)
}
async function drawTree(focus = v36Graph.selected || '') {
  const request=++graphRequest
  const query=$('#treeSearch').value.trim()
  const params=new URLSearchParams({view:'focused',focus,q:query,type:$('#treeTypeFilter').value})
  const r=await v36OptionalApi('/api/memory/tree?'+params)
  if (request!==graphRequest || state.memModule!=='graph') return false
  if (r.unavailable) { $('#treeSvg').innerHTML=''; $('#graphHint').textContent='图谱暂时无法读取：'+r.error; return false }
  state.treeData=r
  v36Graph.nodes=Array.isArray(r.nodes)?r.nodes:[]
  v36Graph.edges=Array.isArray(r.edges)?r.edges:[]
  v36Graph.positions=v36LayoutGraph(v36Graph.nodes)
  renderGraph()
  v36FitGraph()
  return focus && v36Graph.positions.has(focus)
}
function v36NodeLines(text, width = 13) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return [clean.slice(0, width), clean.length > width * 2 ? clean.slice(width, width * 2 - 1) + '…' : clean.slice(width, width * 2)]
}
function renderGraph() {
  v36GraphSize()
  const svg = $('#treeSvg'), pos = v36Graph.positions
  const neighbors = new Set([v36Graph.selected])
  for (const e of v36Graph.edges) { if (e.a === v36Graph.selected) neighbors.add(e.b); if (e.b === v36Graph.selected) neighbors.add(e.a) }
  if (!pos.size) { svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="currentColor" opacity=".55" font-size="13">没有符合条件的记忆片段</text>`; $('#treeLegend').innerHTML = ''; $('#graphHint').textContent = ''; return }
  let out = '<g id="graphViewport">'
  const edges = v36Graph.edges.filter(e => pos.has(e.a) && pos.has(e.b)).slice(0, 650)
  edges.forEach((e, i) => {
    const a = pos.get(e.a), b = pos.get(e.b), selected = !!v36Graph.selected && (e.a === v36Graph.selected || e.b === v36Graph.selected)
    const d = `M${a.x.toFixed(1)} ${a.y.toFixed(1)} L${b.x.toFixed(1)} ${b.y.toFixed(1)}`
    out += `<path class="graph-edge-line${selected ? ' selected' : ''}" d="${d}"/><path class="graph-edge-hit" data-eid="${i}" d="${d}"/>`
    if (selected) out += `<text class="graph-edge-label" x="${((a.x + b.x) / 2).toFixed(1)}" y="${((a.y + b.y) / 2 - 5).toFixed(1)}" text-anchor="middle">${esc(e.kind || '关联')}</text>`
  })
  for (const [id, p] of pos) {
    const n = p.n, hit = state.treeHitIds.has(id), dim = v36Graph.selected && !neighbors.has(id)
    const [line1, line2] = v36NodeLines(n.label || n.text || id)
    const color = TREE_COLOR[n.type] || '#718897'
    out += `<g data-nid="${esc(id)}" class="graph-node${hit ? ' hit' : ''}${id === v36Graph.selected ? ' selected' : ''}${dim ? ' dim' : ''}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" tabindex="0" role="button" aria-label="${esc((TREE_LABEL[n.type] || '记忆') + '：' + (n.label || id))}"><rect x="-90" y="-37" width="180" height="74" rx="10"/><circle cx="-75" cy="-23" r="3" fill="${color}"/><text class="graph-node-type" x="-66" y="-20">${esc(TREE_LABEL[n.type] || '记忆片段')}</text><text x="-76" y="-1" font-size="11.5">${esc(line1)}</text><text x="-76" y="17" font-size="11.5">${esc(line2)}</text><title>${esc(n.label || n.text || id)}</title></g>`
  }
  svg.innerHTML = out + '</g>'
  v36Graph.renderedEdges = edges
  const counts = state.treeData?.counts || {}
  $('#treeLegend').innerHTML = Object.entries(TREE_LABEL).map(([k, label]) => `<span><i style="background:${TREE_COLOR[k]}"></i>${label} ${counts[k] ?? v36Graph.nodes.filter(n => n.type === k).length}</span>`).join('')
  $('#graphHint').textContent = `${v36Graph.nodes.length} 个片段 · 点卡片展开关联`
  v36ApplyCamera()
}
function v36GraphDetailClose() { $('#graphDetail').classList.add('hidden'); v36Graph.selected = ''; void drawTree() }
function v36SelectGraphNode(id) {
  const n = v36Graph.nodes.find(x => x.id === id)
  if (!n) return
  v36Graph.selected = id
  const extra = n.extra || {}, box = $('#graphDetail')
  const related = v36Graph.edges.filter(e => e.a === id || e.b === id).slice(0, 15).map(e => ({ edge: e, node: v36Graph.nodes.find(x => x.id === (e.a === id ? e.b : e.a)) })).filter(x => x.node)
  box.classList.remove('hidden')
  box.innerHTML = `<button class="text-btn detail-close" id="closeGraphDetail">关闭</button><span class="section-kicker">${esc(TREE_LABEL[n.type] || 'MEMORY')}</span><h3>${esc(n.label || n.text || id)}</h3><dl><dt>片段编号</dt><dd>${esc(id)}</dd><dt>来源会话</dt><dd>${esc(extra.chat || extra.chatId || n.chat || '未记录')}</dd><dt>可见范围</dt><dd>${esc(extra.visibility || extra.kind || '依来源权限')}</dd><dt>记录时间</dt><dd>${esc(v36Date(extra.ts || n.at || n.createdAt, true))}</dd><dt>事实主体</dt><dd>${esc(extra.subject || extra.uid || extra.name || '—')}</dd><dt>来源证据</dt><dd>${esc(v36Text(extra.sourceMessageIds || extra.messageId || extra.source || '未记录'))}</dd><dt>记忆权重</dt><dd>${esc(n.weight ?? n.w ?? '—')}</dd><dt>召回次数</dt><dd>${esc(n.hits || 0)}</dd></dl>${extra.fullText || extra.text || extra.fact ? `<h4>完整内容</h4><p>${esc(v36Text(extra.fullText || extra.text || extra.fact))}</p>` : ''}<h4>与它有关的片段 · ${related.length}</h4><div class="graph-related">${related.length ? related.map((r, i) => `<button data-related-index="${i}">${esc(r.edge.kind || '关联')} → ${esc((r.node.label || r.node.id).slice(0, 55))}</button>`).join('') : '<p>暂无已建立的联系。</p>'}</div>`
  $('#closeGraphDetail').onclick = v36GraphDetailClose
  $$('[data-related-index]', box).forEach(b => { b.onclick = () => v36GraphFocus(related[Number(b.dataset.relatedIndex)].node.id) })
  renderGraph()
  v36FitGraph()
}
function v36SelectGraphEdge(index) {
  const e = v36Graph.renderedEdges?.[index]
  if (!e) return
  const a = v36Graph.nodes.find(n => n.id === e.a), b = v36Graph.nodes.find(n => n.id === e.b), box = $('#graphDetail')
  box.classList.remove('hidden')
  box.innerHTML = `<button class="text-btn detail-close" id="closeGraphDetail">关闭</button><span class="section-kicker">RELATIONSHIP</span><h3>${esc(e.kind || '关联关系')}</h3><dl><dt>关联强度</dt><dd>${esc(e.w ?? e.weight ?? '—')}</dd><dt>关系类型</dt><dd>${esc(e.kind || 'assoc')}</dd></dl><h4>连接的两段记忆</h4><div class="graph-related"><button id="graphEdgeFrom">${esc(a?.label || e.a)}</button><button id="graphEdgeTo">${esc(b?.label || e.b)}</button></div><p>连线表示已建立的关联，具体事实仍以节点中的来源和文字记录为准。</p>`
  $('#closeGraphDetail').onclick = v36GraphDetailClose
  $('#graphEdgeFrom').onclick = () => v36GraphFocus(e.a); $('#graphEdgeTo').onclick = () => v36GraphFocus(e.b)
}
const v36Svg = $('#treeSvg')
v36Svg.addEventListener('wheel', e => { e.preventDefault(); const r = v36Svg.getBoundingClientRect(); v36ZoomGraph(Math.exp(-e.deltaY * .0014), e.clientX - r.left, e.clientY - r.top) }, { passive: false })
v36Svg.addEventListener('pointerdown', e => {
  const r = v36Svg.getBoundingClientRect(), point = { x: e.clientX - r.left, y: e.clientY - r.top }
  v36Graph.pointers.set(e.pointerId, point)
  if (v36Graph.pointers.size === 1) { v36Graph.start = { ...point, tx: v36Graph.tx, ty: v36Graph.ty, target: e.target }; v36Graph.moved = false }
  if (v36Graph.pointers.size === 2) { const [a, b] = [...v36Graph.pointers.values()]; v36Graph.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: v36Graph.scale }; v36Graph.moved = true }
  v36Svg.setPointerCapture(e.pointerId)
})
v36Svg.addEventListener('pointermove', e => {
  if (!v36Graph.pointers.has(e.pointerId)) return
  const r = v36Svg.getBoundingClientRect(), point = { x: e.clientX - r.left, y: e.clientY - r.top }
  v36Graph.pointers.set(e.pointerId, point)
  if (v36Graph.pointers.size === 2 && v36Graph.pinch) {
    const [a, b] = [...v36Graph.pointers.values()], distance = Math.hypot(a.x - b.x, a.y - b.y)
    const targetScale = v36Graph.pinch.scale * distance / Math.max(1, v36Graph.pinch.distance)
    v36ZoomGraph(targetScale / v36Graph.scale, (a.x + b.x) / 2, (a.y + b.y) / 2)
  } else if (v36Graph.pointers.size === 1 && v36Graph.start) {
    const dx = point.x - v36Graph.start.x, dy = point.y - v36Graph.start.y
    if (Math.hypot(dx, dy) > 5) v36Graph.moved = true
    v36Graph.tx = v36Graph.start.tx + dx; v36Graph.ty = v36Graph.start.ty + dy; v36ApplyCamera()
  }
})
function v36EndPointer(e) {
  const start = v36Graph.start, click = !v36Graph.moved && v36Graph.pointers.size === 1 && start
  v36Graph.pointers.delete(e.pointerId)
  if (click && e.type !== 'pointercancel') {
    const node = start.target.closest?.('[data-nid]'), edge = start.target.closest?.('[data-eid]')
    if (node) void v36GraphFocus(node.dataset.nid)
    else if (edge) v36SelectGraphEdge(Number(edge.dataset.eid))
  }
  if (v36Graph.pointers.size === 1) { const p = [...v36Graph.pointers.values()][0]; v36Graph.start = { ...p, tx: v36Graph.tx, ty: v36Graph.ty, target: v36Svg }; v36Graph.moved = true }
  if (!v36Graph.pointers.size) { v36Graph.start = null; v36Graph.pinch = null }
}
v36Svg.addEventListener('pointerup', v36EndPointer); v36Svg.addEventListener('pointercancel', v36EndPointer)
v36Svg.addEventListener('keydown', e => {
  if (e.key === '+' || e.key === '=') { e.preventDefault(); v36ZoomGraph(1.25) }
  if (e.key === '-') { e.preventDefault(); v36ZoomGraph(.8) }
  if (e.key === '0') v36FitGraph()
  if (e.key === 'Enter' && e.target.dataset.nid) void v36GraphFocus(e.target.dataset.nid)
})
$('#graphZoomIn').onclick = () => v36ZoomGraph(1.3)
$('#graphZoomOut').onclick = () => v36ZoomGraph(1 / 1.3)
$('#graphFit').onclick = () => v36FitGraph()
$('#treeTypeFilter').onchange = v36GraphDetailClose
$('#treeSearch').oninput = () => {
  clearTimeout(graphSearchTimer)
  graphRequest++
  graphSearchTimer=setTimeout(v36GraphDetailClose,200)
}
$('#treeSearch').onkeydown = e => { if (e.key === 'Enter') { clearTimeout(graphSearchTimer); v36GraphDetailClose() } }
$('#graphFullScreen').onclick = async () => {
  const panel = $('#treeWrap')
  try { if (document.fullscreenElement) await document.exitFullscreen(); else if (panel.requestFullscreen) await panel.requestFullscreen(); else panel.classList.toggle('graph-expanded') }
  catch { panel.classList.toggle('graph-expanded') }
  $('#graphFullScreen').textContent = document.fullscreenElement || panel.classList.contains('graph-expanded') ? '退出全屏 ↙' : '全屏查看 ↗'
  requestAnimationFrame(() => { v36GraphSize(); v36ApplyCamera() })
}
document.addEventListener('fullscreenchange', () => { $('#graphFullScreen').textContent = document.fullscreenElement ? '退出全屏 ↙' : '全屏查看 ↗'; requestAnimationFrame(() => { v36GraphSize(); v36ApplyCamera() }) })
window.addEventListener('resize', () => { if (state.memModule === 'graph') { v36Graph.positions=v36LayoutGraph(v36Graph.nodes); renderGraph(); v36FitGraph() } })
$('#btnTreeRecall').onclick = async () => {
  const q = $('#treeRecallInput').value.trim(), box = $('#treeRecallOut'), b = $('#btnTreeRecall')
  if (!q) return toast('输入一句话或一个话题')
  box.classList.remove('hidden'); box.textContent = '正在寻找能关联上的文字片段…'; b.disabled = true
  try {
    const r = await api('/api/memory/tree/recall?q=' + encodeURIComponent(q)), items = r.items || []
    state.treeHitIds = new Set(r.hitIds || items.map(x => x.id).filter(Boolean))
    box.textContent = items.length ? items.map((it, i) => `${i + 1}. ${v36Text(it)}\n   ${it.cue || it.reason || '关联召回'}${it.score != null ? ' · 得分 ' + it.score : ''}`).join('\n\n') : '没有召回相关片段。换一个具体的人、事件或时间试试。'
    if (items[0]?.id) await v36GraphFocus(items[0].id)
    else renderGraph()
  } catch (e) { box.textContent = '这次召回没有完成：' + e.message } finally { b.disabled = false }
}
$('#treeRecallInput').onkeydown = e => { if (e.key === 'Enter') $('#btnTreeRecall').click() }
$('#btnTreeRebuild').onclick = async () => {
  if (!await confirmBox('补建历史记忆', '从已有聊天与档案中补充关联图谱。历史内容仍按各自的来源范围保存。')) return
  const b = $('#btnTreeRebuild'); b.disabled = true
  try { const r = await post('/api/memory/tree/rebuild', {}); state.treeHitIds = new Set(); toast(`补建完成：${r.addedChats || 0} 条聊天、${r.addedFacts || 0} 条事实`); await drawTree() } catch (e) { toast('补建失败：' + e.message) } finally { b.disabled = false }
}

/* Keep existing settings and add the new integration and expression controls. */
SET_PAGES.splice(1, 0, { id: 'persona', name: '人格与表达', groups: [
  ['她是谁', [
    ['botName', '称呼', 'text', '显示与自称使用的名字'],
    ['personaPreset', '人格基底', 'select', '提供稳定的性格底色；具体表达习惯在下方单独设置', [['feiyu_tone', '小鲸鱼 · 松弛傲娇'], ['game_bro', '游戏群友'], ['bili_humanism', '人间观察'], ['mowan', '俏皮损友'], ['tieba', '直来直往']]],
    ['personalityText', '性格与关系', 'area', '描述她怎样看待事情、对待熟人；留空时使用选择的人格基底'],
    ['behaviorStyleText', '行为与参与时机', 'area', '例如：什么时候参与群聊、如何对待熟人，以及何时安静旁听'],
  ]],
  ['怎样接你的话', [
    ['speakingStyle', '表达风格', 'select', '群聊与私聊共用同一表达基底，再按场景自然调整', [['natural', '自然随和'], ['playful', '俏皮接梗'], ['gentle', '温柔陪伴'], ['concise', '简洁直接']]],
    ['replyStyleText', '表达习惯', 'area', '例如：先回应具体细节，顺着情绪说话；认真提问时把事情讲清楚'],
    ['responseExamples', '场景与回应示例', 'area', '写“对方在分享趣事 → 抓住有意思的细节接一句”；示例用于理解方式，不用固定台词'],
  ]],
] })
SET_PAGES.splice(5, 0, { id: 'wechat', name: '微信接入', groups: [
  ['渠道连接', [
    ['wechatEnabled', '启用微信渠道', 'bool', '连接到已经部署的微信适配器后生效'],
    ['wechatMode', '适配协议', 'select', '能力以实际桥接回报为准，未支持的媒体会明确报错', [['onebot', 'OneBot 兼容适配器']]],
    ['wechatWsUrl', '适配器 WebSocket 地址', 'text', '例如 ws://适配器地址:端口；外网连接使用 wss://'],
    ['wechatToken', '适配器访问令牌', 'text', '与适配器端配置一致'],
  ]],
  ['微信会话范围', [
    ['allowWechatUsers', '允许的联系人', 'text', '填写适配器返回的用户标识，多个用逗号分隔'],
    ['allowWechatGroups', '允许的群聊', 'text', '填写适配器返回的群标识，多个用逗号分隔'],
  ]],
] })
const v36ChatPage = SET_PAGES.find(p => p.id === 'chat')
v36ChatPage.groups[0][1].find(r => r[0] === 'debounceMs')[3] = '静默等待基础时长，给连续分段输入留出时间'
v36ChatPage.groups[0][1].push(['debounceTypingGapMs', '续发保护间隔 (ms)', 'num', '同一人继续补话后，重新等待的最短时间'])
const v36GroupPage = SET_PAGES.find(p => p.id === 'group')
v36GroupPage.groups[0][1].unshift(['groupFollowUpEnabled', '自然接住免 @ 续聊', 'bool', '根据最近互动、受话对象与话题连续性识别，与随机插话概率分别控制'])
const v36VoiceRows = SET_PAGES.find(p => p.id === 'plugin').groups.find(g => g[1].some(r => r[0] === 'ttsStyle'))[1]
const v36VoiceStyle = v36VoiceRows.find(r => r[0] === 'ttsStyle')
v36VoiceStyle[1] = '语音语气选择'; v36VoiceStyle[3] = '自动模式按聊天语境在可爱与温柔之间选择，也可固定一种语气'
v36VoiceStyle[4] = [['auto', '按语境自动选择'], ['cute', '固定可爱'], ['gentle', '固定温柔']]
v36VoiceRows.splice(v36VoiceRows.findIndex(r => r[0] === 'ttsVoice') + 1, 0,
  ['ttsVoiceCute', '可爱语气 · 云端音色', 'text', '填写对应的百炼复刻音色 ID'],
  ['ttsVoiceGentle', '温柔语气 · 云端音色', 'text', '填写另一种语气的复刻音色 ID；留空沿用默认音色'],
  ['ttsCloudModel', '复刻音色对应模型', 'text', '使用创建该音色时匹配的语音模型名称'])
const v36OriginalFieldRow = fieldRow
fieldRow = function(key, label, kind, hint, options) {
  let html = v36OriginalFieldRow(key, label, kind, hint, options)
  return html
}
const v36OriginalRenderSettings = renderSettings
renderSettings = function(pageId) {
  v36OriginalRenderSettings(pageId)
  if(pageId==='wechat'){
    const box=document.createElement('div');box.className='card'
    const wx=state.lastState?.wechat||{},cap=wx.capabilities||{}
    box.innerHTML='<div class="card-h"><b>微信连接与能力</b><button class="btn sm" id="wxManageContacts">管理微信联系人</button></div><div class="card-b"></div>'
    box.querySelector('.card-b').textContent=(wx.connected?'微信桥已连接':'微信桥未连接')+' · 文字 '+(cap.text?'可用':'未就绪')+' · 图片 '+(cap.image?'可用':'未就绪')+' · 原生表情 '+(cap.emoji?'可用':'未就绪')+' · 原生语音 '+(cap.record?'可用':'未就绪')+'。联系人和群聊统一在「白名单」页按渠道管理。'
    $('#setBody').prepend(box);$('#wxManageContacts').onclick=()=>{state.allowPlatform='wechat';state.contacts=null;renderSettings('allow')}
  }
  $$('#setBody .sw').forEach(sw => {
    sw.setAttribute('role', 'switch'); sw.setAttribute('tabindex', '0'); sw.setAttribute('aria-label', sw.closest('.row')?.querySelector('label')?.textContent || '设置开关'); sw.setAttribute('aria-checked', sw.classList.contains('on'))
    const click = sw.onclick
    sw.onclick = e => { if (click) click.call(sw, e); sw.setAttribute('aria-checked', sw.classList.contains('on')) }
    sw.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sw.click() } }
  })
}
const v36OriginalLoadState = loadState
loadState = async function() {
  const s = await v36OriginalLoadState()
  const connected = !!s.wsConnected, el = $('#liveStatus')
  el.classList.toggle('connected', connected)
  $('span', el).textContent = connected ? 'QQ 已连接' : (s.wsRetrying ? '渠道重连中' : 'QQ 未连接')
  return s
}
const v36OriginalTab = tab
tab = function(name) {
  if (!TITLES[name]) return
  v36OriginalTab(name)
  $('#mobileMorePanel').classList.add('hidden'); $('#mobileMoreBtn').setAttribute('aria-expanded', 'false')
  $('#mobileMoreBtn').classList.toggle('on', ['log', 'review', 'gallery', 'files', 'settings'].includes(name))
}
$('#mobileMoreBtn').onclick = () => { const p = $('#mobileMorePanel'), expanded = p.classList.contains('hidden'); p.classList.toggle('hidden', !expanded); $('#mobileMoreBtn').setAttribute('aria-expanded', expanded) }
$('#mobileMoreClose').onclick = () => { $('#mobileMorePanel').classList.add('hidden'); $('#mobileMoreBtn').setAttribute('aria-expanded', 'false') }
$$('[data-go-tab]').forEach(b => { b.onclick = () => tab(b.dataset.goTab) })
document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('#mobileMorePanel').classList.add('hidden'); $('#mobileMoreBtn').setAttribute('aria-expanded', 'false'); $('#treeSearchResults').classList.add('hidden'); if ($('#treeWrap').classList.contains('graph-expanded')) { $('#treeWrap').classList.remove('graph-expanded'); $('#graphFullScreen').textContent = '全屏查看 ↗' } } })
TITLES.memory = ['记忆', '让人物、往事与线索各有归处']
TITLES.skill = ['能力', '有真实结果，才算完成一件事']
TITLES.settings = ['设置', '连接、表达与行为，都由你决定']

// Boot runs after the channel UI extension.

const permPage=SET_PAGES.find(p=>p.id==='perm');permPage.groups.push(['跨窗口与管理员',[['ownerUsers','最高管理 QQ','text','多个账号用逗号分隔；可管理高权限功能'],['crossWindowEnabled','允许跨窗口发送','bool','允许向其他窗口发送文字和支持的媒体'],['crossWindowAnyone','允许可对话的人发起跨窗口发送','bool','开启后可对话的人也可向已识别的联系人和群发消息；管理功能仍限管理员']]])
