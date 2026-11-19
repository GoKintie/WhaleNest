import { randomUUID } from 'node:crypto'
import { getActivePersonaPreset, defaultReplyStyle, defaultResponseExamples } from './persona.mjs'

const fields = ['personalityText','behaviorStyleText','replyStyleText','responseExamples']

export function readPersonaProfiles(s) {
  if (Array.isArray(s.personaProfiles) && s.personaProfiles.length) {
    return {profiles:s.personaProfiles, active:s.activePersonaProfile}
  }
  const preset = getActivePersonaPreset(s)
  return {active:'current', profiles:[{
    id:'current', name:'当前人设', personalityText:s.personalityText || preset.identity,
    behaviorStyleText:s.behaviorStyleText || '', replyStyleText:s.replyStyleText || defaultReplyStyle(s.speakingStyle),
    responseExamples:s.responseExamples || defaultResponseExamples,
  }]}
}

export function changePersonaProfiles(s, input) {
  let {profiles, active} = readPersonaProfiles(s)
  const existing = profiles.find(p => p.id === input.id)
  if (input.action === 'save') {
    if (input.id && !existing) throw Error('人设已不存在')
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 60) throw Error('人设名称需为 1 到 60 字')
    if (profiles.some(p => p.id !== input.id && p.name === name)) throw Error('已有同名人设')
    const profile = {id:existing?.id || randomUUID(), name}
    for (const field of fields) {
      if (typeof input[field] !== 'string' || input[field].length > 12000) throw Error('每段设定最多 12000 字')
      profile[field] = input[field].trim()
    }
    profiles = existing ? profiles.map(p => p.id === profile.id ? profile : p) : [...profiles,profile]
    if (input.activate === true) active = profile.id
  } else if (input.action === 'activate') {
    if (!existing) throw Error('人设已不存在')
    active = existing.id
  } else if (input.action === 'delete') {
    if (!existing || existing.id === active) throw Error('请先切换到其他人设，再删除当前人设')
    profiles = profiles.filter(p => p.id !== existing.id)
  } else {
    throw Error('未知人设操作')
  }
  const selected = profiles.find(p => p.id === active)
  return {personaProfiles:profiles, activePersonaProfile:active,
    ...Object.fromEntries(fields.map(field => [field, selected[field]]))}
}
