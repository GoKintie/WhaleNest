/* Whale Nest 3.6.1: one contact manager, separate channel identities. */
state.allowPlatform='qq'
state.contactsByPlatform={}
state.convoPlatform=localStorage.getItem('dsh_chat_platform')||'all'
const channelName=p=>p==='wechat'?'微信':p==='webui'?'直连':'QQ'
function platformForChat(c){return c.kind==='webui'?'webui':c.platform||String(c.chat||'').split(':')[0]||'qq'}
function channelChats(){return (state.chats||[]).filter(c=>(state.convoPlatform==='all'||platformForChat(c)===state.convoPlatform)&&(state.convoFilter==='all'||c.kind===state.convoFilter)&&(!state.convoQuery||String(c.title||'').toLowerCase().includes(state.convoQuery)||String(c.chat).toLowerCase().includes(state.convoQuery)))}
const channelBar=document.createElement('div');channelBar.className='channel-filter';channelBar.setAttribute('aria-label','对话渠道')
channelBar.innerHTML=['all','qq','wechat','webui'].map(p=>`<button data-chat-channel="${p}" class="${p===state.convoPlatform?'on':''}">${p==='all'?'全部渠道':channelName(p)}</button>`).join('')
$('#filter').before(channelBar)
function showEmptyChannel(){
 state.chat='';state.chatKind='';state.chatTitle=''
 $('#chatTitle').textContent=state.convoPlatform==='wechat'?'微信对话':'未选择会话';$('#chatKind').textContent='';$('#chatCount').textContent=''
 $('#msgs').innerHTML='<div class="empty">这个渠道暂无会话。先在设置 → 白名单中选择联系人或群聊。</div>'
 $('#composer').disabled=true;$('#sendBtn').disabled=true;$('#quick').style.display='none';$('#delChat').style.display='none'
}
const loadChannelChat=loadChat
loadChat=async function(chat){if(!chat)return;$('#composer').disabled=false;$('#sendBtn').disabled=false;await loadChannelChat(chat)}
function chooseVisibleChat(){const list=channelChats();if(!list.some(c=>c.chat===state.chat)){const first=list[0];if(!first){showEmptyChannel();return}state.chat=first.chat;state.chatKind=first.kind;state.chatTitle=first.title;loadChat(first.chat)}}
$$('[data-chat-channel]',channelBar).forEach(b=>{b.onclick=()=>{state.convoPlatform=b.dataset.chatChannel;localStorage.setItem('dsh_chat_platform',state.convoPlatform);$$('[data-chat-channel]',channelBar).forEach(x=>x.classList.toggle('on',x===b));chooseVisibleChat();paintConvos()}})
paintConvos=function(){
 const box=$('#convos'),list=channelChats();box.replaceChildren()
 if(!list.length){box.innerHTML='<div class="empty">没有匹配的会话</div>';return}
 for(const c of list){const p=platformForChat(c),el=document.createElement('div');el.className='citem'+(c.chat===state.chat?' on':'');el.dataset.channel=p
  const kind=c.kind==='group'?'群聊':'私聊',badge=p==='webui'?'直连':channelName(p)+' · '+kind
  const avatar=String(c.avatar||''),safeAvatar=p==='webui'?avatar==='/assets/avatar.jpg':/^https:\/\/(?:q1\.qlogo\.cn|p\.qlogo\.cn|wx\.qlogo\.cn)\//i.test(avatar)
  el.innerHTML=`<div class="av">${safeAvatar?`<img src="${esc(avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:esc((c.title||'?').slice(0,1))}</div><div class="convo-identity"><div class="t">${esc(c.title||c.chat)}</div><div class="p">${esc(String(c.last||'').slice(0,45))}</div></div><span class="k channel-${p}">${esc(badge)}</span>`
  const img=el.querySelector('.av img');if(img)img.onerror=()=>{img.parentElement.textContent=(c.title||'?').slice(0,1)}
  el.onclick=()=>{state.chat=c.chat;state.chatKind=c.kind;state.chatTitle=c.title;$('#chatWrap').dataset.view='thread';paintConvos();loadChat(c.chat)};box.appendChild(el)
 }
}
loadChats=async function(){const r=await api('/api/chats');state.chats=r.chats||[];$('#navChat').textContent=state.chats.length;chooseVisibleChat();paintConvos()}
$('#syncConvo').onclick=async()=>{const b=$('#syncConvo');b.disabled=true;try{await api('/api/contacts?platform=all&force=1');state.contactsByPlatform={};await loadChats();toast('QQ 和微信已同步')}catch(e){toast(e.message)}finally{b.disabled=false}}

let allowRequest=0
renderAllowlist=async function(){
 const box=$('#wlBody');if(!box)return
 const platform=state.allowPlatform||'qq',serial=++allowRequest
 box.innerHTML=`<div class="channel-filter allow-channel-tabs" role="tablist" aria-label="联系人渠道"><button role="tab" data-allow-channel="qq" aria-selected="${platform==='qq'}" class="${platform==='qq'?'on':''}">QQ</button><button role="tab" data-allow-channel="wechat" aria-selected="${platform==='wechat'}" class="${platform==='wechat'?'on':''}">微信</button></div><div id="channelContacts"><div class="empty">正在读取${channelName(platform)}联系人…</div></div>`
 $$('[data-allow-channel]',box).forEach(b=>{b.onclick=()=>{state.allowPlatform=b.dataset.allowChannel;renderAllowlist()}})
 const sync=$('#wlSync');if(sync)sync.onclick=async()=>{delete state.contactsByPlatform[state.allowPlatform];await renderAllowlist();toast('当前渠道已刷新')}
 try{
  const data=state.contactsByPlatform[platform]||await api('/api/contacts?platform='+platform+'&force=1')
  if(serial!==allowRequest||platform!==state.allowPlatform)return
  if(!data.ok&&!data.friends?.length&&!data.groups?.length){$('#channelContacts').innerHTML=`<div class="empty">${esc(data.error||'渠道未连接')}</div>`;return}
  state.contactsByPlatform[platform]=data
  const current=await api('/api/settings');if(serial!==allowRequest||platform!==state.allowPlatform)return;state.settings=current.settings||state.settings
  const s=state.settings||{},userKey=platform==='wechat'?'allowWechatUsers':'allowUsers',groupKey=platform==='wechat'?'allowWechatGroups':'allowGroups'
  const users=new Set((s[userKey]||[]).map(String)),groups=new Set((s[groupKey]||[]).map(String))
  const people=new Map()
  const rows=(list,kind,set)=>list.map((it,i)=>{const id=String(it.id),key=platform==='wechat'?`wechat:${kind}:${id}`:id,t=s.targets?.[key]||{},on=set.has(id),index=people.size;people.set(index,{...it,id,kind,platform,key});const hints=[on?'允许对话':'未开启'];if(platform==='qq'&&t.proactive)hints.push('主动搭话');if(kind==='group'&&t.atOnly===false)hints.push('免 @')
   return `<div class="wl-row${on?' on':''}" data-contact-index="${index}"><div class="contact-identity"><strong>${esc(t.note||it.name||id)}</strong><small>${esc(id)}</small></div><span class="tag">${esc(hints.join(' · '))}</span><button class="contact-toggle ${on?'on':''}" role="switch" aria-checked="${on}" aria-label="允许${esc(it.name||id)}对话" data-contact-toggle="${index}"><span></span></button></div>`}).join('')
  $('#channelContacts').innerHTML=`<p class="faint">${channelName(platform)}联系人与 QQ／微信其他渠道分别授权。点击姓名可修改备注和专属设定。</p>${data.stale?'<p class="faint">当前显示最近一次联系人缓存</p>':''}<h3 class="contact-section">${channelName(platform)}群聊 <small>${(data.groups||[]).length}</small></h3><div class="wl">${rows(data.groups||[],'group',groups)||'<div class="empty">没有群聊</div>'}</div><h3 class="contact-section">${channelName(platform)}好友 <small>${(data.friends||[]).length}</small></h3><div class="wl">${rows(data.friends||[],'private',users)||'<div class="empty">没有好友</div>'}</div><div class="contact-actions"><button class="btn pri sm" id="wlSave">保存${channelName(platform)}白名单</button></div>`
  const save=async()=>{const r=await post('/api/settings',{[userKey]:[...users],[groupKey]:[...groups]});state.settings=r.settings||state.settings;await loadChats()}
  $$('[data-contact-toggle]',box).forEach(b=>{b.onclick=async e=>{e.stopPropagation();const person=people.get(Number(b.dataset.contactToggle)),set=person.kind==='group'?groups:users,before=set.has(person.id);if(before)set.delete(person.id);else set.add(person.id);$$('[data-contact-toggle]',box).forEach(x=>x.disabled=true)
   try{await save();await renderAllowlist();toast(channelName(platform)+'白名单已保存')}catch(err){if(before)set.add(person.id);else set.delete(person.id);await renderAllowlist();toast('保存失败：'+err.message)}
  }})
  $$('[data-contact-index]',box).forEach(row=>{row.onclick=()=>{const person=people.get(Number(row.dataset.contactIndex));if(platform==='qq')editTarget(person.id,person.kind);else editWechatTarget(person)}})
  $('#wlSave').onclick=async()=>{try{await save();toast(channelName(platform)+'白名单已保存')}catch(e){toast(e.message)}}
 }catch(e){if(serial===allowRequest)$('#channelContacts').innerHTML=`<div class="empty">读取失败：${esc(e.message)}</div>`}
}
function editWechatTarget(person){
 const s=state.settings,t=s.targets?.[person.key]||{},isGroup=person.kind==='group';let modal=$('#targetModal');if(!modal){modal=document.createElement('div');modal.id='targetModal';modal.className='overlay';document.body.appendChild(modal)}
 modal.innerHTML=`<div class="dialog"><h2>微信${isGroup?'群聊':'好友'}配置</h2><p class="faint">${esc(person.name)} · ${esc(person.id)}</p><label>备注名</label><input id="wxTargetNote" value="${esc(t.note||person.name)}">${isGroup?`<label class="row">需要 @ 或呼叫才参与<input id="wxTargetAt" type="checkbox" ${(t.atOnly??s.atOnly)!==false?'checked':''}></label><label class="row">旁听学习与记忆<input id="wxTargetLearn" type="checkbox" ${t.learnExpression===true?'checked':''}></label><p class="faint">表达规则需审核。该群可作为群友私聊回忆自己发言的来源。</p>`:''}<label>这个会话的专属设定</label><textarea id="wxTargetPrompt">${esc(t.prompt||'')}</textarea><div class="acts"><button class="btn" id="wxTargetCancel">取消</button><button class="btn pri" id="wxTargetSave">保存</button></div></div>`
 attachConversationImpression('wechat',person.kind,person.id,$('#wxTargetPrompt'))
 modal.classList.add('on');$('#wxTargetCancel').onclick=()=>modal.classList.remove('on');$('#wxTargetSave').onclick=async()=>{const next={...t,note:$('#wxTargetNote').value.trim(),prompt:$('#wxTargetPrompt').value.trim(),proactive:false};if(isGroup){next.atOnly=$('#wxTargetAt').checked;next.learnExpression=$('#wxTargetLearn').checked}try{const r=await post('/api/settings',{targets:{...(state.settings.targets||{}),[person.key]:next}});state.settings=r.settings||state.settings;modal.classList.remove('on');await renderAllowlist();await loadChats();toast('微信会话设置已保存')}catch(e){toast(e.message)}}
}
const channelLoadState=loadState
loadState=async function(){const s=await channelLoadState(),q=!!s.wsConnected,w=!!s.wechat?.connected;$('#liveStatus span').textContent=`QQ ${q?'已连接':'未连接'} · 微信 ${w?'已连接':'未连接'}`;return s}
boot()
