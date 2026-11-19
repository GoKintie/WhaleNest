import { constants, copyFileSync, mkdirSync } from 'node:fs'
import { isIPv6 } from 'node:net'
import { join, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { seedWorkspace } from './seed-workspace.mjs'

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 19)) throw new Error('需要 Node.js 22.19 或以上版本')

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const config = join(root, '.env.windows')
try {
  copyFileSync(join(root, '.env.windows.example'), config, constants.COPYFILE_EXCL)
  console.log('已创建 .env.windows。可以先进入 WebUI，再配置模型和 QQ。')
} catch (error) {
  if (error.code !== 'EEXIST') throw error
}
loadEnvFile(config)

const env = process.env
env.WORKDIR = resolve(env.WORKDIR || join(root, 'workspace'))
env.DSH_HOME = resolve(env.DSH_HOME || join(root, 'data'))
env.SETTINGS_KEY_FILE ||= join(env.DSH_HOME, '.whalenest-secrets', 'settings-master.key')
env.WHALENEST_CODE_DIR = join(root, 'bridge')
env.ONEBOT_WS ||= 'ws://127.0.0.1:3001'
env.WEB_LISTEN_HOST = env.WEB_BIND || '127.0.0.1'
const port = Number(env.WEB_PORT || 3081)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEB_PORT 必须在 1–65535 之间')
env.WEB_PORT = String(port)
const listenHost = env.WEB_LISTEN_HOST
const urlHost = isIPv6(listenHost) ? `[${listenHost}]` : listenHost
env.PUBLIC_BASE ||= `http://${listenHost === '0.0.0.0' || listenHost === '::' ? '127.0.0.1' : urlHost}:${port}`
env.PERMISSION_LEVEL ||= 'standard'

mkdirSync(env.DSH_HOME, { recursive: true })
seedWorkspace(join(root, 'workspace-seed'), env.WORKDIR)
console.log(`WebUI 监听 ${urlHost}:${port}。按 Ctrl+C 保存并停止。`)
console.log('首次登录可用 Get-Content .\\workspace\\.web-token 查看自动生成的令牌。')
await import('../bridge/onebot.mjs')
