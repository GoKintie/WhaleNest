import {existsSync,readFileSync,copyFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {readJson,writeJsonNow} from './store.mjs'
import {safeScopeName} from './context-scope.mjs'
// Copy unambiguous legacy contexts; keep the originals and a backup for administrator review.
export function migrateLegacySessions(root=process.env.WORKDIR||'/workspace'){
  const marker=join(root,'scope-migration-v36.json');if(existsSync(marker))return readJson(marker,{})
  const memory=process.env.MEMORY_DIR||join(root,'memory'),scopes=new Map(),copied=[],ambiguous=[]
  const rows=existsSync(join(memory,'chat.jsonl'))?readFileSync(join(memory,'chat.jsonl'),'utf8').split('\n'):[]
  for(const line of rows){let row;try{row=JSON.parse(line)}catch{continue}if(!['private','group'].includes(row.kind)||!row.chat)continue
    const id=String(row.chat),key=`${row.platform||'qq'}:${row.kind}:${id}`;if(!scopes.has(id))scopes.set(id,new Set());scopes.get(id).add(key)
  }
  scopes.set('webui',new Set(['webui:private:webui']))
  for(const file of ['sessions.json','sessions-agent.json']){
    const target=join(root,file);if(!existsSync(target))continue
    const data=readJson(target,{});let changed=false
    for(const [id,rec] of Object.entries(data)){
      if(id.includes(':'))continue
      const candidates=scopes.get(id)
      if(candidates?.size!==1){ambiguous.push({file,id});continue}
      const key=[...candidates][0];if(data[key])continue
      data[key]={...rec,migratedFrom:id};changed=true;copied.push({file,id,scope:key})
    }
    if(changed){copyFileSync(target,target+'.pre-v36');writeJsonNow(target,data)}
  }
  for(const folder of ['handover','archives']){
    const dir=join(memory,folder);if(!existsSync(dir))continue
    for(const file of readdirSync(dir)){
      const match=file.match(/^(\d+|webui)([_.].*|\.md)$/);if(!match)continue
      const candidates=scopes.get(match[1]);if(candidates?.size!==1)continue
      const dest=join(dir,safeScopeName([...candidates][0])+match[2]);if(!existsSync(dest))copyFileSync(join(dir,file),dest)
    }
  }
  const result={version:'3.6.0',at:Date.now(),copied,ambiguous};writeJsonNow(marker,result);return result
}
