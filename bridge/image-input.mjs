import {readFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
const cache=new Map()
export async function imageBufferForVision(file,{maxBytes=2*1024*1024}={}){
 let data;try{data=readFileSync(file)}catch{return null}
 if(!data.length||data.length>20*1024*1024)return null
 const sha1=createHash('sha1').update(data).digest('hex')
 const png=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=data[0]===255&&data[1]===216
 if((png||jpeg)&&data.length<=maxBytes)return {sha1,buffer:data,mime:png?'image/png':'image/jpeg'}
 if(cache.has(sha1))return cache.get(sha1)
 // Decode one frame, limit dimensions and time. Original GIF/WebP remains intact for sending.
 const normalized=await new Promise(resolve=>execFile(process.env.FFMPEG_BIN||'ffmpeg',['-hide_banner','-loglevel','error','-threads','1','-max_alloc','67108864','-i',file,'-frames:v','1','-vf',"scale='min(1600,iw)':'min(1600,ih)':force_original_aspect_ratio=decrease",'-f','image2pipe','-vcodec','png','pipe:1'],{timeout:10000,maxBuffer:6*1024*1024,encoding:'buffer',windowsHide:true},(err,stdout)=>resolve(err?null:stdout)))
 if(!normalized?.length||normalized.length>maxBytes)return null
 const result={sha1,buffer:normalized,mime:'image/png'};cache.set(sha1,result);while(cache.size>20)cache.delete(cache.keys().next().value);return result
}
