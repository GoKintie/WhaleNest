import {parseConversation} from './context-scope.mjs'
// Resolve against actual platform directories, never confuse matching names or channels.
export function resolveCrossTarget(rawValue,qq,wx,settings={}){
 const raw=String(rawValue||'').trim();if(!raw)return null
 const candidates=[]
 for(const [platform,source] of [['qq',qq||{}],['wechat',wx||{}]])for(const [kind,rows] of [['private',source.friends||[]],['group',source.groups||[]]])for(const row of rows){
  const id=String(row.id??row.user_id??row.group_id??'');if(!id)continue
  const key=`${platform}:${kind}:${id}`,t=settings.targets?.[key]||(platform==='qq'?settings.targets?.[id]:null)||{}
  const aliases=[t.note,row.name,row.nickname,row.remark,row.group_name].filter(Boolean).map(x=>String(x).trim().toLowerCase())
  candidates.push({platform,kind,chatId:id,name:t.note||row.name||row.nickname||row.group_name||id,aliases,known:true})
 }
 const scoped=raw.match(/^(qq|wechat):(private|group):(.+)$/i)
 if(scoped){const p=parseConversation(raw);return candidates.find(x=>x.platform===p.platform&&x.kind===p.kind&&x.chatId===p.chatId)||{...p,name:p.chatId,known:false}}
 let q=raw.toLowerCase().replace(/^(?:给|向|对|找)\s*/, '').trim(),channel=''
 if(/^微信[:：\s]/.test(q)){channel='wechat';q=q.replace(/^微信[:：\s]+/,'')}
 else if(/^qq[:：\s]/i.test(q)&&!/^qq[:：]\d+$/i.test(q)){channel='qq';q=q.replace(/^qq[:：\s]+/,'')}
 let kind='';const prefix=q.match(/^(group|群聊|群|private|user|qq|好友|私聊)[:：\s]*(\d{4,13})$/i)
 if(prefix){kind=/^(group|群|群聊)$/i.test(prefix[1])?'group':'private';q=prefix[2];channel=channel||'qq'}
 const available=candidates.filter(c=>(!channel||c.platform===channel)&&(!kind||c.kind===kind))
 let matches=available.filter(c=>c.chatId.toLowerCase()===q||c.aliases.includes(q))
 if(!matches.length&&q.length>=2&&!/^\d+$/.test(q))matches=available.filter(c=>c.aliases.some(a=>a.includes(q)||q.includes(a)))
 if(matches.length===1){const {aliases,...result}=matches[0];return result}
 if(matches.length>1)return null
 // Preserve explicit owner/whitelist targets even before a directory sync.
 if(/^\d{4,13}$/.test(q)&&(!channel||channel==='qq'))return {platform:'qq',kind:kind||((settings.allowGroups||[]).map(String).includes(q)?'group':'private'),chatId:q,name:q,known:false}
 return null
}
