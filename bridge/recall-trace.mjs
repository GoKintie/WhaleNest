import {join} from 'node:path'
import {readJson,writeJsonSoon} from './store.mjs'
export function recordRecallTrace(root,scope,entry) {
  const file=join(root,'recall-trace.json'),all=readJson(file,{})
  all[scope]=[...(all[scope]||[]),{...entry,at:Date.now()}].slice(-40)
  writeJsonSoon(file,all)
}
export const readRecallTrace=(root,scope)=>{const all=readJson(join(root,'recall-trace.json'),{});return scope?(all[scope]||[]):Object.entries(all).flatMap(([scope,list])=>list.map(x=>({...x,scope}))).sort((a,b)=>b.at-a.at).slice(0,100)}
