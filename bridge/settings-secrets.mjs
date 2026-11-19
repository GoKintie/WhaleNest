import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const version = 'aes-256-gcm:v1'
export const isSecretKey = name => /(?:api[_-]?key|token|cookie|password|passwd|local[_-]?key|secret|credential|^cred)$/i.test(name)

export function settingsKeyPath(path) {
  const directory = path === '/workspace/settings.json' ? process.env.DSH_HOME || '/root/.dsh' : dirname(path)
  return process.env.SETTINGS_KEY_FILE || join(directory, '.whalenest-secrets', 'settings-master.key')
}

function writeNew(path, data) {
  writeFileSync(path, data, { mode: 0o600, flag: 'wx', flush: true })
}

function masterKey(file, create) {
  if (!existsSync(file)) {
    if (!create) throw Error('配置主密钥缺失，请恢复原来的主密钥文件')
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temp = file + '.' + randomUUID()
    writeNew(temp, randomBytes(32))
    try { linkSync(temp,file) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    finally { rmSync(temp,{force:true}) }
  }
  const key = readFileSync(file)
  if (key.length !== 32) throw Error('配置主密钥文件无效，请恢复原来的主密钥文件')
  return key
}

function transformSecrets(data, visit, path = []) {
  if (Array.isArray(data)) return data.map((item,index) => transformSecrets(item,visit,[...path,index]))
  if (!data || typeof data !== 'object') return data
  return Object.fromEntries(Object.entries(data).map(([name,value]) => {
    const field = [...path,name]
    return [name,isSecretKey(name) ? visit(value,field) : transformSecrets(value,visit,field)]
  }))
}

export function writeSettingsDocument(path, data, {keyFile = settingsKeyPath(path)} = {}) {
  let key
  const encoded = transformSecrets(data,(value,field) => {
    if (value === undefined || value === null || value === '') return value
    key ??= masterKey(keyFile,true)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm',key,iv)
    cipher.setAAD(Buffer.from(JSON.stringify(field)))
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()])
    return {$whaleSecret:version,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:bytes.toString('base64url')}
  })
  mkdirSync(dirname(path),{recursive:true})
  const temp = path + '.tmp-' + randomUUID()
  writeNew(temp,JSON.stringify(encoded,null,2)+'\n')
  try { renameSync(temp,path) }
  finally { rmSync(temp,{force:true}) }
}

export function readSettingsDocument(path, {migrate = false, keyFile = settingsKeyPath(path)} = {}) {
  let raw
  try { raw = readFileSync(path,'utf8') }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error }
  let data
  try { data = JSON.parse(raw.trim() || '{}') }
  catch { throw Error('配置文件不是有效 JSON，原文件已保留') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('配置文件格式不正确')
  let key
  let plaintext = false
  const decoded = transformSecrets(data,(value,field) => {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value,'$whaleSecret')) {
      if (value !== undefined && value !== null && value !== '') plaintext = true
      return value
    }
    if (value.$whaleSecret !== version) throw Error('配置凭据使用了不支持的加密版本')
    key ??= masterKey(keyFile,false)
    try {
      const decipher = createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64url'),{ authTagLength:16 })
      decipher.setAAD(Buffer.from(JSON.stringify(field)))
      decipher.setAuthTag(Buffer.from(value.tag,'base64url'))
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data,'base64url')),decipher.final()]).toString('utf8'))
    } catch { throw Error('配置凭据解密失败，请检查主密钥与配置文件是否配套') }
  })
  if (migrate && plaintext) writeSettingsDocument(path,decoded,{keyFile})
  return decoded
}
