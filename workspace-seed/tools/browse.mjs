#!/usr/bin/env node
// 看网页：node /workspace/tools/browse.mjs <url> [--text] [--shot out.png] [--wait 3000] [--width 1280]
// 依赖 /workspace/tools/node_modules/playwright + /workspace/tools/pw 里的 chromium

process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/workspace/tools/pw'
const { chromium } = await import('playwright')
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const args = process.argv.slice(2)
const url = args.find((a) => /^https?:\/\//.test(a))
if (!url) {
  console.error('用法: node browse.mjs <url> [--text] [--shot out.png] [--wait ms] [--width px]')
  process.exit(2)
}
const opt = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const wait = Number(opt('--wait', 2500))
const width = Number(opt('--width', 1280))
const shot = opt('--shot', '')
const wantText = args.includes('--text') || !shot

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(wait)

  const info = await page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)?.innerText?.trim() || ''
    return {
      title: document.title,
      h1: t('h1'),
      text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim(),
      links: [...document.querySelectorAll('a[href]')].slice(0, 30).map((a) => `${(a.innerText || '').trim().slice(0, 40)} -> ${a.href}`),
    }
  })

  if (shot) {
    mkdirSync(dirname(shot), { recursive: true })
    await page.screenshot({ path: shot, fullPage: false })
  }

  console.log(`# ${info.title}`)
  if (info.h1) console.log(`H1: ${info.h1}`)
  if (wantText) console.log('\n' + info.text.slice(0, 6000))
  if (info.links.length) console.log('\n## 链接\n' + info.links.join('\n'))
  if (shot) console.log(`\n[截图] ${shot}`)
} finally {
  await browser.close()
}
