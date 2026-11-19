import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJson } from './store.mjs'

const workspaceTool = join(process.env.WORKDIR || '/workspace','tools','memewiki.mjs')
const seed = await import(existsSync(workspaceTool) ? pathToFileURL(workspaceTool).href : '../workspace-seed/tools/memewiki.mjs')
  .then(module => module.DEFAULT_MEME_ENTRIES || []).catch(() => [])

export function publicMemes(root) {
  const items = readJson(join(root,'style','memewiki.json'),seed)
  const seedNames = new Set(seed.map(item => item.term))
  const curated = (Array.isArray(items) ? items : []).filter(item => item?.public === true || seedNames.has(item?.term))
  return (curated.length ? curated : seed).map(item => ({text:item.term,keywords:item.aliases || [],
    scene:'群聊轻松交流时理解词义',rationale:item.meaning,pattern:item.usage,ruleType:'meme'}))
}
