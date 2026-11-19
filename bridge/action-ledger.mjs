import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {readJson,writeJsonNow} from './store.mjs'
const file=join(process.env.WORKDIR || '/workspace','actions.json')
const EFFECTS=new Set(['send_message','set_reminder','send_voice','send_image','send_sticker','post_qzone','phone_control','write_file','write_diary','observe_world','skland_sign','draw_tarot','run_shell'])
function stable(v) { return v && typeof v==='object' ? Array.isArray(v) ? v.map(stable) : Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])) : v }
export async function recordedAction(runId,name,args,execute,{effectful=false}={}) {
  if(!runId || (!effectful && !EFFECTS.has(name))) return execute()
  const key=createHash('sha256').update(JSON.stringify([runId,name,stable(args)])).digest('hex')
  const rows=readJson(file,{})
  if(rows[key]?.state==='complete') return {...rows[key].result,replayed:true}
  if(rows[key]?.state==='started') return {ok:false,error:'上次操作结果不明，请先核对实际结果，已阻止自动重复执行',unknown:true}
  const started={runId,name,state:'started',at:Date.now()}
  rows[key]=started;writeJsonNow(file,rows)
  const finish=entry=>{
    const current=readJson(file,{})
    current[key]={...started,...entry,finishedAt:Date.now()}
    // Keep recent operations without dropping unresolved actions.
    for(const [id,r] of Object.entries(current)) if(r.state!=='started' && Date.now()-r.at>30*86400000) delete current[id]
    writeJsonNow(file,current)
  }
  let result
  try{result=await execute()}catch(e){if(!e.unknown && !effectful)finish({state:'failed',error:e.message});throw e}
  finish({state:result.ok?'complete':result.unknown?'started':'failed',result})
  return result
}
