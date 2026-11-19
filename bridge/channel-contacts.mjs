// A platform identifier always accompanies contact IDs; never flatten channels by raw number.
export function normalizeWechatContacts(users=[],groups=[]){
 return {platform:'wechat',friends:users.map(x=>({id:String(x.user_id),name:x.remark||x.nickname||String(x.user_id),nickname:x.nickname||'',avatar:x.avatar||'',platform:'wechat',kind:'private',legacyId:x.legacy_user_id==null?'':String(x.legacy_user_id)})),groups:groups.map(x=>({id:String(x.group_id),name:x.group_name||String(x.group_id),avatar:x.avatar||'',platform:'wechat',kind:'group',count:x.member_count||0}))}
}
export function addWechatThreads(map,contacts,settings){
 for(const [kind,list,allowed] of [['private',contacts.friends||[],settings.allowWechatUsers||[]],['group',contacts.groups||[],settings.allowWechatGroups||[]]]){
  for(const person of list){const id=String(person.id),scope=`wechat:${kind}:${id}`,old=map.get(scope)
   if(old){old.peer=person.name||old.peer;old.avatar=person.avatar||'';continue}
   if(!allowed.map(String).includes(id))continue
   map.set(scope,{chat:scope,targetId:id,platform:'wechat',kind,count:0,last:'暂无消息',ts:1,peer:person.name||id,avatar:person.avatar||''})
  }
 }
 return map
}
export function migrateWechatSelection(settings,contacts){
 const ids=new Set((contacts.friends||[]).map(x=>String(x.id)))
 const mapping=new Map((contacts.friends||[]).filter(x=>x.legacyId&&!ids.has(x.legacyId)&&x.legacyId!==x.id).map(x=>[x.legacyId,x.id]))
 const users=[...new Set((settings.allowWechatUsers||[]).map(x=>mapping.get(String(x))||String(x)))]
 const targets={...(settings.targets||{})};let changed=JSON.stringify(users)!==JSON.stringify(settings.allowWechatUsers||[])
 for(const [legacy,id]of mapping){const before='wechat:private:'+legacy,after='wechat:private:'+id;if(Object.hasOwn(targets,before)){targets[after]={...targets[before],...targets[after]};delete targets[before];changed=true}}
 return changed?{allowWechatUsers:users,targets}:null
}
