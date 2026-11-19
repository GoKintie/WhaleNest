import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs'
import {join} from 'node:path'
const root=process.env.WORKDIR||'/workspace'
// An explicitly configured password stays fixed. Generate a token only for an empty/example value.
const bad=new Set(['','change-me-to-a-random-string','change-me-please'])
export function webToken(){
  const configured=String(process.env.WEB_TOKEN||'').trim()
  if(!bad.has(configured))return configured
  const file=join(root,'.web-token')
  if(existsSync(file)){const stored=readFileSync(file,'utf8').trim();if(/^[a-f0-9]{64}$/.test(stored))return stored}
  mkdirSync(root,{recursive:true})
  const token=randomBytes(32).toString('hex'),tmp=file+'.tmp-'+process.pid;writeFileSync(tmp,token,{mode:0o600});renameSync(tmp,file);return token
}
const token=webToken()
const secret=randomBytes(32)
export const isWeakConfiguredToken=()=>bad.has(String(process.env.WEB_TOKEN||'').trim())
function signature(path,expires){return createHmac('sha256',secret).update(path+'\n'+expires).digest('hex')}
export function signedMediaQuery(path,ttlSeconds=1800){const expires=Math.floor(Date.now()/1000)+ttlSeconds;return `path=${encodeURIComponent(path)}&expires=${expires}&sig=${signature(path,expires)}`}
export function validSignedMedia(url){const p=url.searchParams.get('path')||'',e=Number(url.searchParams.get('expires')),sig=url.searchParams.get('sig')||'';if(!Number.isInteger(e)||e<Date.now()/1000||e>Date.now()/1000+3600||!/^[a-f0-9]{64}$/.test(sig))return false;return timingSafeEqual(Buffer.from(sig,'hex'),Buffer.from(signature(p,e),'hex'))}
export function sameToken(a,b){if(!a||!b)return false;const x=createHash('sha256').update(String(a)).digest(),y=createHash('sha256').update(String(b)).digest();return timingSafeEqual(x,y)}
export const activeWebToken=token
