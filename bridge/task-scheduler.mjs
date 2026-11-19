// All model work shares a concurrency limit; every conversation shares one lane.
const lanes = new Map()
let active = 0
const waiting = []
async function acquire() {
  const limit = Math.max(1, Number(process.env.MAX_CONCURRENT_TASKS || 3))
  if(active<limit){active++;return}
  await new Promise(resolve=>waiting.push(resolve))
}
function release(){const next=waiting.shift();if(next)next();else active--}
export async function scheduled(key, run) {
  const previous = lanes.get(key) || Promise.resolve()
  let unlock
  const done = new Promise(resolve => { unlock = resolve })
  const chain = previous.catch(()=>{}).then(()=>done)
  lanes.set(key, chain)
  await previous.catch(()=>{})
  await acquire()
  try { return await run() } finally {
    release(); unlock()
    if (lanes.get(key) === chain) lanes.delete(key)
  }
}
export const schedulerState = () => ({active,waiting:waiting.length,lanes:lanes.size})
export async function drainTasks(timeoutMs = 12000) {
  let timer
  await Promise.race([Promise.allSettled([...lanes.values()]),new Promise(r=>{timer=setTimeout(r,timeoutMs)})])
  clearTimeout(timer)
}
