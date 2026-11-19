// Real HTTP handlers with fake contact transports; no messaging/model requests.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {once} from 'node:events'
const root=fs.mkdtempSync(path.resolve('.http361-test-'))
for(const [k,v]of Object.entries({WORKDIR:root,MEMORY_DIR:path.join(root,'memory'),SETTINGS_FILE:path.join(root,'settings.json'),CONTACTS_FILE:path.join(root,'contacts.json'),WEB_TOKEN:'http-test-fixed',WEB_PORT:'0'}))process.env[k]=v
const {save,reload,SECRET_MASK}=await import('./settings.mjs');save({allowUsers:['10001'],allowWechatUsers:['100009'],allowWechatGroups:['room@chatroom'],targets:{'10001':{note:'QQ 专属备注'}},embeddingProvider:'local'})
const {readSettingsDocument,settingsKeyPath}=await import('./settings-secrets.mjs')
const galleryFolder=path.join(root,'gallery','表情包');fs.mkdirSync(galleryFolder,{recursive:true})
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=','base64')
fs.writeFileSync(path.join(galleryFolder,'示例 + 1.png'),png)
const file=path.join(root,'settings.json'),disk=JSON.parse(fs.readFileSync(file));disk.model='deepseek-flash';disk.deepseekModel='deepseek-flash';disk.ttsLocalUrl='http://voice.test:9880';disk.websearchApiKey='legacy-search-key';fs.writeFileSync(file,JSON.stringify(disk))
assert.equal(reload().websearchApiKey,'legacy-search-key')
assert.equal(fs.readFileSync(file,'utf8').includes('legacy-search-key'),false)
const m=await import('./memory.mjs');m.ensureLayout();m.appendChat({platform:'qq',kind:'private',chat:'10001',id:'10001',name:'QQ 好友',role:'user',text:'QQ history'})
const transport=p=>async action=>{assert.ok(['get_friend_list','get_group_list'].includes(action),'unexpected action '+action);return{retcode:0,data:action==='get_friend_list'?[{user_id:'10001',legacy_user_id:p==='wechat'?100009:undefined,nickname:p==='wechat'?'微信好友':'QQ 好友'}]:[{group_id:p==='wechat'?'room@chatroom':'20001',group_name:p+'群'}]}}
const {startWeb}=await import('./webui.mjs');const server=startWeb({callOneBot:transport('qq'),callWechat:transport('wechat')});await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port
const get=async route=>{const r=await fetch(base+route,{headers:{'x-web-token':'http-test-fixed'}});assert.equal(r.status,200,route);return r.json()}
const post=async(route,body,status=200)=>{const r=await fetch(base+route,{method:'POST',headers:{'x-web-token':'http-test-fixed','content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,status,data.error||route);return data}
try{
 assert.equal((await fetch(base+'/api/auth/check')).status,401)
 assert.equal((await fetch(base+'/api/auth/check',{headers:{'x-web-token':'wrong'}})).status,401)
 assert.equal((await get('/api/auth/check')).ok,true)
 assert.equal((await fetch(base+'/api/dashboard/activity')).status,401)
 const activity=await get('/api/dashboard/activity?tz=Asia%2FTokyo')
 assert.equal(activity.days.length,7)
 assert.equal(activity.days.at(-1).received,1)
 assert.equal(activity.days.at(-1).sent,0)
 assert.equal((await fetch(base+'/api/dashboard/host')).status,401)
 assert.equal((await fetch(base+'/api/dashboard/quote')).status,401)
 const host=await get('/api/dashboard/host')
 assert.ok(host.system.platform && host.system.arch)
 assert.ok(host.memory.total>0 && host.memory.used<=host.memory.total)
 assert.ok(host.storage.total>0 && host.storage.available<=host.storage.total)
 assert.equal((await get('/api/dashboard/host')).sampledAt,host.sampledAt)
 const fetchWithoutQuoteMock=globalThis.fetch
 try {
   globalThis.fetch=(url,options)=>{
     if (url.hostname!=='v1.hitokoto.cn') return fetchWithoutQuoteMock(url,options)
     const genres=url.searchParams.getAll('c')
     return genres.includes('a')
       ? Promise.resolve(new Response(null,{status:503}))
       : Promise.resolve(Response.json({hitokoto:'测试文学短句',from:'测试作品',from_who:'测试作者',type:'d'}))
   }
   const literary=await get('/api/dashboard/quote?kind=literature')
   assert.deepEqual([literary.kind,literary.source,literary.text,literary.work],['literature','hitokoto','测试文学短句','测试作品'])
   const offline=await get('/api/dashboard/quote?kind=anime')
   assert.equal(offline.kind,'anime')
   assert.equal(offline.source,'local')
   assert.ok(offline.text && offline.work)
 } finally { globalThis.fetch=fetchWithoutQuoteMock }
 assert.equal((await fetch(base+'/api/settings?t=http-test-fixed')).status,401)
 assert.equal((await fetch(base+'/api/state?t=http-test-fixed')).status,401)
 const stateResponse = await fetch(base+'/api/state',{headers:{'x-web-token':'http-test-fixed'}})
 assert.equal(stateResponse.status,200)
 assert.equal((await stateResponse.json()).skillDetails.daily_fortune.label, '今日运势')
 const gallery=(await get('/api/gallery')).images
 assert.equal(gallery.length,1)
 const galleryUrl=base+gallery[0].url
 const thumbnail=await fetch(galleryUrl)
 assert.equal(thumbnail.status,200)
 assert.equal(thumbnail.headers.get('content-type'),'image/png')
 assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()),png)
 const edited=(await post('/api/gallery/sticker-metadata',{path:gallery[0].path,name:'散步的猫',tags:['散步','猫'],scene:'晚上下楼散步'})).sticker
 assert.deepEqual(edited.tags,['散步','猫'])
 assert.equal((await get('/api/gallery')).images[0].sticker.scene,'晚上下楼散步')
 const stickerTest=await post('/api/gallery/test_match',{text:'下楼散步',reply:'走吧'})
 assert.ok(stickerTest.picked.previewUrl)
 assert.equal(stickerTest.picked.name,m.pickStickerByMood('下楼散步 走吧',path.join(root,'gallery')).name)
 assert.equal((await post('/api/gallery/test_match',{text:'这份报价已经发出'})).picked,null)
 await post('/api/gallery/sticker-metadata',{path:'settings.json',tags:['no']},400)
 const graph=await get('/api/memory/tree?view=focused&type=person&q='+encodeURIComponent('QQ 好友'))
 assert.ok(graph.nodes.length>0)
 assert.ok(graph.nodes.every(node=>node.type==='person'))
 const neighborhood=await get('/api/memory/tree?view=focused&focus='+encodeURIComponent(graph.nodes[0].id))
 assert.equal(neighborhood.nodes[0].id,graph.nodes[0].id)
 assert.equal((await fetch(base+'/api/raw?path='+encodeURIComponent(gallery[0].path))).status,401)
 const media=await get('/api/media-url?path='+encodeURIComponent(gallery[0].path))
 assert.equal(media.ok,true)
 assert.equal((await fetch(base+media.url)).status,200)
 const ticket=await get('/api/stream-ticket')
 assert.match(ticket.query,/sig=[a-f0-9]{64}/)
 const qq=await get('/api/contacts');assert.equal(qq.friends[0].name,'QQ 好友')
 const wx=await get('/api/contacts?platform=wechat');assert.equal(wx.friends[0].id,'10001');assert.equal(wx.friends[0].legacyId,'100009')
 const s=(await get('/api/settings')).settings;assert.deepEqual(s.allowWechatUsers,['10001']);assert.deepEqual(s.allowUsers,['10001']);assert.deepEqual(s.allowWechatGroups,['room@chatroom'])
 const persisted=JSON.parse(fs.readFileSync(file));assert.equal(persisted.model,disk.model);assert.equal(persisted.deepseekModel,disk.deepseekModel);assert.equal(persisted.ttsLocalUrl,disk.ttsLocalUrl)
 const c=(await get('/api/chats')).chats
 assert.equal(c.find(x=>x.chat==='qq:private:10001').title,'QQ 专属备注')
 assert.equal(c.find(x=>x.chat==='wechat:private:10001').title,'微信好友')
 assert.ok(c.find(x=>x.chat==='wechat:group:room@chatroom'))
 const all=await get('/api/contacts?platform=all');assert.equal(all.channels.qq.friends.length,1);assert.equal(all.channels.wechat.friends.length,1)
 const profiles='/api/settings/personas', catalog='/api/settings/model-catalog'
 const legacy=(await get(profiles)).profiles[0]
 assert.ok(legacy.personalityText);assert.ok(legacy.replyStyleText)
 const custom={name:'温柔鲸鱼',personalityText:'PERSONALITY',behaviorStyleText:'BEHAVIOR',replyStyleText:'WARM EXPRESSION',responseExamples:'EXAMPLES'}
 const created=await post(profiles,{action:'save',...custom,activate:true})
 assert.notEqual(created.active,legacy.id)
 assert.equal((await get('/api/settings')).settings.replyStyleText,custom.replyStyleText)
 await post(profiles,{action:'activate',id:legacy.id})
 assert.equal((await get('/api/settings')).settings.replyStyleText,legacy.replyStyleText)
 await post(profiles,{action:'activate',id:created.active})
 assert.match(m.buildContext({chatId:'10001',userId:'10001',kind:'private',platform:'wechat'}),/WARM EXPRESSION/)
 await post('/api/settings',{targets:{...s.targets,'10001':{note:'QQ 专属备注',prompt:'QQ_ONLY_OVERRIDE'}}})
 assert.match(m.buildContext({chatId:'10001',userId:'10001',kind:'private',platform:'qq'}),/QQ_ONLY_OVERRIDE/)
 assert.doesNotMatch(m.buildContext({chatId:'10001',userId:'10001',kind:'private',platform:'wechat'}),/QQ_ONLY_OVERRIDE/)
 const initial=(await get(catalog)).catalog
 assert.equal(initial.roles.main.model,'deepseek-flash')
 const added=(await post(catalog,{action:'service',name:'Shared',driver:'openai',baseUrl:'https://shared.invalid/v1',apiKey:'test-secret'})).catalog
 const shared=added.services.find(x=>x.name==='Shared')
 assert.equal(shared.hasKey,true);assert.equal(shared.apiKey,undefined)
 const withGemini=(await post(catalog,{action:'service',name:'Gemini Test',driver:'gemini',baseUrl:'https://gemini.invalid/v1beta/openai',apiKey:'gemini-secret'})).catalog
 const gemini=withGemini.services.find(service=>service.name==='Gemini Test')
 const discover='/api/models/discover'
 const originalFetch=globalThis.fetch
 let discoveryCalls=0
 let sharedUnavailable=false
 globalThis.fetch=(url,init)=>{
   if (String(url).startsWith(base+'/')) return originalFetch(url,init)
   discoveryCalls++
   if (String(url)==='https://shared.invalid/v1/models') {
     assert.equal(init.headers.authorization,'Bearer test-secret')
     return Promise.resolve(sharedUnavailable ? new Response('private upstream error',{status:404}) : Response.json({data:[{id:'chat-test'},{id:'chat-test'},{id:'invalid model'}]}))
   }
   assert.equal(String(url),'https://gemini.invalid/v1beta/openai/models')
   assert.equal(init.headers.authorization,'Bearer gemini-secret')
   return Promise.resolve(Response.json({models:[{name:'models/gemini-test'}]}))
 }
 try {
   const [shareResult,geminiResult]=await Promise.all([post(discover,{serviceId:shared.id}),post(discover,{serviceId:gemini.id})])
   assert.deepEqual(shareResult.models,['chat-test'])
   assert.deepEqual(geminiResult.models,['gemini-test'])
   await post(discover,{serviceId:'missing'},400)
   assert.equal(discoveryCalls,2)
   sharedUnavailable=true
   assert.equal((await post(discover,{serviceId:shared.id},502)).error,'该接口未提供模型列表')
   assert.deepEqual((await get(catalog)).catalog.roles,initial.roles)
 } finally { globalThis.fetch=originalFetch }
 await post(catalog,{action:'roles',only:'embedding',embedding:{service:shared.id,model:'emb-test'}})
 await post(catalog,{action:'roles',only:'vision',vision:{service:shared.id,model:'vision-test'}})
 const backup={service:shared.id,model:'model-test'}
 await post(catalog,{action:'roles',only:'chat',main:initial.roles.main,backups:[backup]})
 assert.equal((await get('/api/settings')).settings.model,'deepseek-flash')
 await post(catalog,{action:'activate',...backup})
 assert.equal((await get('/api/models')).current,'model-test')
 globalThis.fetch=(url,init)=>{
   if (String(url).startsWith(base+'/')) return originalFetch(url,init)
   assert.equal(String(url),'https://shared.invalid/v1/chat/completions')
   assert.equal(JSON.parse(init.body).model,'model-test')
   return Promise.resolve(Response.json({choices:[{message:{content:'Mock response'}}]}))
 }
 try {
   const result=await post('/api/task',{text:'Mock request'})
   assert.equal(result.ok,true);assert.equal(result.text,'Mock response')
   const {events}=await get('/api/logs')
   const webMessages=events.filter(event=>event.kind==='msg' && event.chatKind==='webui')
   assert.deepEqual(webMessages.map(event=>[event.role,event.chat,event.text]),[
     ['user','webui','Mock request'],['assistant','webui','Mock response'],
   ])
   assert.ok(events.some(event=>event.kind==='log' && event.msg==='[webui直通] 正在请求 model-test'))
 } finally { globalThis.fetch=originalFetch }
 await post(catalog,{action:'service-key',id:shared.id,apiKey:'new-secret'})
 const sharedSettings=(await get('/api/settings')).settings
 for(const key of ['deepseekApiKey','pluginVisionApiKey','embeddingApiKey'])assert.equal(sharedSettings[key],SECRET_MASK)
 const rawSecrets=fs.readFileSync(file,'utf8')
 const persistedSecrets=readSettingsDocument(file)
 for(const key of ['deepseekApiKey','pluginVisionApiKey','embeddingApiKey']){
   assert.equal(persistedSecrets[key],'new-secret')
   assert.equal(JSON.parse(rawSecrets)[key].$whaleSecret,'aes-256-gcm:v1')
 }
 assert.equal(rawSecrets.includes('new-secret'),false)
 const nested=JSON.parse(rawSecrets).modelCatalog.services.find(item=>item.id===shared.id).apiKey
 assert.equal(nested.$whaleSecret,'aes-256-gcm:v1')
 const {TOOLS}=await import('./tools.mjs')
 const config=await TOOLS.find(tool=>tool.name==='read_config').run({key:'modelCatalog'})
 assert.equal(JSON.parse(config.text).modelCatalog.services.find(item=>item.id===shared.id).apiKey,SECRET_MASK)
 const vaultRequest=await fetch(base+'/api/media-url?path='+encodeURIComponent(path.relative(root,settingsKeyPath(file)).replaceAll('\\','/')),{headers:{'x-web-token':'http-test-fixed'}})
 assert.equal(vaultRequest.status,403)
 await post(catalog,{action:'remove-service',id:shared.id},400)
 const identityPath='/api/settings/memory-identities'
 assert.equal((await fetch(base+identityPath)).status,401)
 assert.deepEqual((await post(identityPath,{action:'link',qq:'10001',wechat:'wxid_same'})).links,[{qq:'10001',wechat:'wxid_same'}])
 await post(identityPath,{action:'link',qq:'10002',wechat:'wxid_same'},400)
 await post(identityPath,{action:'link',qq:'10003',wechat:'sample@chatroom'},400)
 assert.deepEqual((await post(identityPath,{action:'remove',qq:'10001',wechat:'wxid_same'})).links,[])
 assert.equal((await fetch(base+'/api/settings/conversation-impression?scope=qq%3Agroup%3A..%2Fsecret',{headers:{'x-web-token':'http-test-fixed'}})).status,400)
 assert.equal((await fetch(base+'/assets/ui-settings.js')).status,200)
 const longText='鲸'.repeat(40000)
 const longSaved=await post('/api/settings',{ackText:longText})
 assert.equal(longSaved.settings.ackText,longText)
 await post('/api/settings',{deepseekApiKey:SECRET_MASK,allowUsers:['10001']})
 assert.equal(readSettingsDocument(file).deepseekApiKey,'new-secret')
 await post('/api/settings',{deepseekApiKey:'typed-new-secret'})
 assert.equal(readSettingsDocument(file).deepseekApiKey,'typed-new-secret')
 assert.equal(fs.readFileSync(file,'utf8').includes('typed-new-secret'),false)
 assert.equal((await get('/api/settings')).settings.deepseekApiKey,SECRET_MASK)
 await post('/api/settings',{clearSecrets:['deepseekApiKey']})
 assert.equal(JSON.parse(fs.readFileSync(file)).deepseekApiKey,'')
 const statuses=[]
 for(let i=0;i<8;i++)statuses.push((await fetch(base+'/api/auth/check',{headers:{'x-web-token':'bad-'+i}})).status)
 assert.deepEqual(statuses,[401,401,401,401,401,401,401,429])
 const blocked=await fetch(base+'/api/auth/check',{headers:{'x-web-token':'http-test-fixed'}})
 assert.equal(blocked.status,429)
 assert.ok(Number(blocked.headers.get('retry-after'))>0)
 console.log('PASS settings: persona switching, scope priority, shared credentials, manual backup activation; no real sends')
 console.log('PASS HTTP: authentication, split contacts, selected-ID migration, unseen threads, cross-channel name isolation; no real sends')
 server.closeAllConnections();await new Promise(r=>server.close(r));process.exit(0)
}catch(e){console.error(e);server.closeAllConnections();server.close();process.exit(1)}
