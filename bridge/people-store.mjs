import {existsSync,mkdirSync,readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {readJson,writeJsonNow} from './store.mjs'
import {safeScopeName} from './context-scope.mjs'
const norm=t=>String(t||'').replace(/[\p{P}\p{Z}\s]/gu,'').toLowerCase()
const profilePath=(root,id,scope)=>join(root,'profiles',safeScopeName(scope||'legacy'),safeScopeName(id)+'.json')
export function getPerson(root,id,scope='') {
  const p=readJson(profilePath(root,id,scope),null)
  return p || {id:String(id),scope,name:String(id),summary:'',facts:[],versions:[]}
}
export function updatePerson(root,{id,name,scope,summary,sourceIds=[]}) {
  const old=getPerson(root,id,scope),now=Date.now()
  const fingerprint=createHash('sha256').update(JSON.stringify([summary,[...sourceIds].sort()])).digest('hex')
  if(old.fingerprint===fingerprint) return old
  const facts=[...(old.facts||[])]
  for(const line of String(summary||'').split('\n').map(x=>x.replace(/^[-*•]\s*/,'').trim()).filter(Boolean)) {
    const hit=facts.find(x=>norm(x.text)===norm(line))
    if(hit) {hit.lastSeen=now;hit.sourceIds=[...new Set([...(hit.sourceIds||[]),...sourceIds])]}
    else facts.push({id:createHash('sha1').update(line).digest('hex').slice(0,16),text:line,createdAt:now,lastSeen:now,sourceIds})
  }
  const version={at:now,summary,sourceIds,fingerprint}
  const profile={...old,id:String(id),name:name||old.name,scope,summary,facts,versions:[...(old.versions||[]),version],fingerprint,updatedAt:now}
  writeJsonNow(profilePath(root,id,scope),profile)
  return profile
}
export function listPeople(root) {
  const base=join(root,'profiles'),items=[]
  if(existsSync(base)) for(const scope of readdirSync(base,{withFileTypes:true}).filter(x=>x.isDirectory())) for(const f of readdirSync(join(base,scope.name)).filter(x=>x.endsWith('.json'))) {
    const p=readJson(join(base,scope.name,f),null);if(p)items.push(p)
  }
  // Historical summaries remain visible to the administrator, never silently reclassified as public.
  const legacy=join(root,'people')
  if(existsSync(legacy)) for(const f of readdirSync(legacy).filter(x=>x.endsWith('.md')&&!x.startsWith('group_'))) {
    const id=f.slice(0,-3)
    if(items.some(x=>x.id===id))continue
    const summary=readFileSync(join(legacy,f),'utf8')
    items.push({id,name:summary.split('\n')[0].replace(/^#+\s*/,''),scope:'legacy',summary,facts:[],versions:[],legacy:true})
  }
  return items
}
