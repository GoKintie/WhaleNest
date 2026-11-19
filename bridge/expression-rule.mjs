import { isGroupScope } from './context-scope.mjs'

const line = (value, limit) => typeof value === 'string' ? value.trim().replace(/\s+/g,' ').slice(0,limit) : ''

export function expressionRule(input = {}) {
  const type = input.ruleType === 'meme' ? 'meme' : 'expression'
  const keywords = [...new Set((Array.isArray(input.keywords) ? input.keywords : []).map(k => line(k,24)).filter(k => k.length >= 2))].slice(0,8)
  return {ruleType:type, text:line(input.text,50), scene:line(input.scene,120), pattern:line(input.pattern,240),
    rationale:line(input.rationale,180), avoid:line(input.avoid,120), keywords}
}

export function expressionAvailable(item, scope) {
  if (item.status !== 'approved') return false
  if (item.analyzed === true) return item.sourceScope === scope || (item.shareScopes || []).includes(scope)
  return item.chat === 'seed' || item.chat === 'webui'
}

export function matchMeme(rules, text, minLength = 2) {
  const hay = String(text || '').normalize('NFKC').toLowerCase()
  if (!hay) return null
  return rules.flatMap(rule => [rule.text, ...(rule.keywords || [])].map(term => ({rule,term:String(term).normalize('NFKC').toLowerCase()})))
    .filter(({term}) => term.length >= minLength && (hay === term || (term.length >= 4 && hay.includes(term))))
    .sort((a,b) => b.term.length-a.term.length)[0]?.rule || null
}

export function validExpressionRule(rule, sourceScope) {
  return isGroupScope(sourceScope) && !!(rule.text && rule.scene && rule.pattern && rule.rationale && rule.avoid && rule.keywords.length) &&
    ![rule.text,rule.scene,rule.pattern,rule.rationale,rule.avoid,...rule.keywords].some(value => /\[\[|https?:\/\//i.test(value))
}

export function copiesSample(rule,text) {
  const normalize = s => String(s || '').replace(/[\p{P}\s]/gu,'')
  const sample = normalize(text)
  return [rule.scene,rule.pattern,rule.rationale,rule.avoid,rule.ruleType==='expression' ? rule.text : ''].some(value => {
    const field = normalize(value)
    return (sample.length >= 8 && field.includes(sample)) || (field.length >= 10 && sample.includes(field))
  })
}
