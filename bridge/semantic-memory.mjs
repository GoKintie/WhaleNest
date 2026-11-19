import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {current} from './settings.mjs'
import {readJson,writeJsonSoon} from './store.mjs'
const sessions=new Map()
const hash=t=>createHash('sha256').update(String(t)).digest('hex')
export function embeddingConfig(s=current()) {
  const enabled=s.embeddingEnabled!==false
  const base=String(s.embeddingBaseUrl||'').trim().replace(/\/+$/,'')
  const model=String(s.embeddingModel||'').trim()
  const remote=enabled && s.embeddingProvider!=='local' && Boolean(s.embeddingApiKey && base && model)
  const batchSize=/^qwen3\.7-text-embedding(?:-flash)?$/i.test(model) ? 20 : 24
  return {enabled,remote,key:s.embeddingApiKey,model,batchSize,endpoint:base.endsWith('/embeddings')?base:base+'/embeddings',signature:hash(base+'|'+model)}
}

export async function requestEmbeddings(cfg,input,fetchFn=globalThis.fetch) {
  const res=await fetchFn(cfg.endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+cfg.key},
    body:JSON.stringify({model:cfg.model,input}),signal:AbortSignal.timeout(8000)})
  if(!res.ok)throw new Error(`Embedding HTTP ${res.status}`)
  const data=await res.json()
  const batch=(data.data||[]).slice().sort((a,b)=>a.index-b.index).map(x=>x.embedding)
  const dimension=batch[0]?.length
  if(batch.length!==input.length || !dimension || batch.some(v=>!Array.isArray(v)||v.length!==dimension||v.some(x=>!Number.isFinite(x)))) {
    throw new Error('Embedding 返回维度或条目不正确')
  }
  return batch
}
function cache(root,cfg=embeddingConfig()){
  const key=root+':'+cfg.signature
  if(!sessions.has(key))sessions.set(key,{cfg,records:readJson(join(root,'remote-vectors-'+cfg.signature.slice(0,12)+'.json'),{}),queries:new Map(),error:'',failedUntil:0,pending:null})
  return sessions.get(key)
}
function cosine(a,b){if(!a||!b||a.length!==b.length)return 0;let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i]}return aa&&bb?dot/Math.sqrt(aa*bb):0}
export function remoteSimilarity(root,query,nodeId,text){const cfg=embeddingConfig();if(!cfg.remote)return null;const c=cache(root,cfg),v=c.records[nodeId];return v?.hash===hash(text)&&c.queries.has(query)?cosine(c.queries.get(query),v.vector):null}
export async function prepareRemoteRecall(root,query,candidates,options={}){
  const cfg=embeddingConfig(options.settings||current())
  if(!cfg.remote || !query)return {engine:cfg.enabled?'local':'disabled'}
  const c=cache(root,cfg)
  if(Date.now()<c.failedUntil)return {engine:'local',error:c.error}
  // Serialize cache updates without holding a model scheduler slot indefinitely.
  if(c.pending)return {engine:'local',pending:true}
  c.pending=(async()=>{
    const needed=candidates.filter(n=>c.records[n.id]?.hash!==hash(n.text)).slice(0,96)
    const input=[...(!c.queries.has(query)?[query]:[]),...needed.map(n=>n.text)]
    if(!input.length)return {engine:'remote',cached:true}
    try{
      const vectors=[]
      for(let i=0;i<input.length;i+=cfg.batchSize){
        const batch=await requestEmbeddings(cfg,input.slice(i,i+cfg.batchSize),options.fetch)
        vectors.push(...batch)
      }
      let offset=0
      if(!c.queries.has(query)){c.queries.set(query,vectors[0]);offset=1}
      for(let i=0;i<needed.length;i++)c.records[needed[i].id]={hash:hash(needed[i].text),vector:vectors[i+offset]}
      while(c.queries.size>100)c.queries.delete(c.queries.keys().next().value)
      writeJsonSoon(join(root,'remote-vectors-'+cfg.signature.slice(0,12)+'.json'),c.records)
      c.error='';return {engine:'remote',embedded:needed.length,model:cfg.model}
    }catch(e){c.error=e.message;c.failedUntil=Date.now()+60000;return {engine:'local',error:e.message}}
  })()
  try{return await c.pending}finally{c.pending=null}
}
export function semanticStatus(root){const cfg=embeddingConfig(),c=cache(root,cfg);return {enabled:cfg.enabled,engine:cfg.remote?'remote+local':cfg.enabled?'local':'disabled',model:cfg.remote?cfg.model:'128维本地语义簇',cached:Object.keys(c.records).length,error:c.error}}
