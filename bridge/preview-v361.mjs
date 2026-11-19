import fs from 'node:fs';import path from 'node:path'
const root=path.resolve('.preview-361');fs.mkdirSync(root,{recursive:true})
for(const [k,v]of Object.entries({WORKDIR:root,MEMORY_DIR:path.join(root,'memory'),SETTINGS_FILE:path.join(root,'settings.json'),WEB_PORT:'3188',WEB_TOKEN:'local-ui-review',CONTACTS_FILE:path.join(root,'contacts.json')}))process.env[k]=v
const {save}=await import('./settings.mjs');save({botName:'肥鱼',allowUsers:['10001'],allowGroups:['20001'],allowWechatUsers:['10001'],allowWechatGroups:['room@chatroom'],embeddingProvider:'local',diaryEnabled:false})
const m=await import('./memory.mjs');m.ensureLayout()
m.appendChat({role:'user',id:'10001',name:'QQ 测试好友',platform:'qq',kind:'private',chat:'10001',text:'这是 QQ 历史'})
m.appendChat({role:'user',id:'10001',name:'微信测试好友',platform:'wechat',kind:'private',chat:'10001',text:'这是微信历史'})
const fake=p=>async action=>({retcode:0,data:action==='get_friend_list'?[{user_id:'10001',nickname:p==='qq'?'QQ 测试好友':'微信测试好友'},{user_id:'10002',nickname:p==='qq'?'QQ 另一个好友':'微信另一个好友'}]:action==='get_group_list'?[{group_id:p==='qq'?'20001':'room@chatroom',group_name:p==='qq'?'QQ 测试群':'微信测试群'}]:{}})
const {startWeb}=await import('./webui.mjs')
startWeb({callOneBot:fake('qq'),callWechat:fake('wechat'),getState:()=>({busy:false,queued:0,wsConnected:true,wechat:{enabled:true,connected:true,capabilities:{text:true,image:true,emoji:false,record:false}}})})
