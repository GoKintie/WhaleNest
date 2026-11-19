import {statSync} from 'node:fs'
import {resolve,sep} from 'node:path'
import {isProtectedReadPath,resolveAuthorizedPath} from './permissions.mjs'
import {isOwner} from './action-policy.mjs'
export function canSendResource(path,parsed,options={}){
  if(!String(path||'').trim())return false
  const full=resolveAuthorizedPath(path)
  if(!full || isProtectedReadPath(full))return false
  try{if(!statSync(full).isFile())return false}catch{return false}
  if(isOwner(parsed))return true
  if(options.trustedArtifact===true)return true
  const root=resolve(process.env.GALLERY_DIR || resolve(process.env.WORKDIR||'/workspace','gallery'),'表情包')
  if(full.startsWith(root+sep))return true
  return (parsed.media||[]).some(m=>m._localPath && resolve(m._localPath)===full)
}
