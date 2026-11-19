// 连通性自检：连 NapCat 的 OneBot WS，发一条测试消息，打印服务端回执
// 用法：docker exec -e TO=你的QQ dsh-onebot node /opt/hand/probe.mjs
const WS_URL = process.env.ONEBOT_WS || 'ws://napcat:3001'
const TOKEN = process.env.ONEBOT_TOKEN || ''
const TO = process.env.TO || ''
const TEXT = process.env.TEXT || '【部署自检】链路已通，收到这条说明发送没问题。'

if (!TO) {
  console.error('缺少 TO=<QQ号>')
  process.exit(2)
}

const ws = new WebSocket(WS_URL, TOKEN ? { headers: { authorization: `Bearer ${TOKEN}` } } : undefined)
let done = false

const finish = (code) => {
  if (done) return
  done = true
  try { ws.close() } catch {}
  setTimeout(() => process.exit(code), 100)
}

ws.addEventListener('open', () => {
  console.log('connected', WS_URL)
  ws.send(JSON.stringify({
    action: 'send_private_msg',
    params: { user_id: Number(TO), message: TEXT },
    echo: 'probe-1',
  }))
})

ws.addEventListener('message', (e) => {
  let data
  try { data = JSON.parse(String(e.data)) } catch { return }
  if (data.post_type === 'meta_event') return
  if (data.echo !== 'probe-1') return
  console.log('reply', JSON.stringify(data).slice(0, 300))
  finish(data.retcode === 0 ? 0 : 1)
})

ws.addEventListener('error', (e) => {
  console.error('error', e?.message || 'unknown')
  finish(1)
})

setTimeout(() => {
  console.error('timeout 15s')
  finish(3)
}, 15000)
