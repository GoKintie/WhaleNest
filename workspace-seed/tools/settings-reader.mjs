import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const mounted = '/opt/hand/settings-secrets.mjs'
const source = process.env.WHALENEST_CODE_DIR
  ? pathToFileURL(join(process.env.WHALENEST_CODE_DIR, 'settings-secrets.mjs'))
  : new URL('../../bridge/settings-secrets.mjs',import.meta.url)
const { readSettingsDocument, writeSettingsDocument, settingsKeyPath } = await import(existsSync(source) ? source : mounted)
const settingsFile = process.env.SETTINGS_FILE || join(process.env.WORKDIR || '/workspace','settings.json')

export function readSettings() {
  return readSettingsDocument(settingsFile)
}

export function readToolCredentials(path) {
  return readSettingsDocument(path,{keyFile:settingsKeyPath(settingsFile)})
}

export function writeToolCredentials(path,data) {
  writeSettingsDocument(path,data,{keyFile:settingsKeyPath(settingsFile)})
}
