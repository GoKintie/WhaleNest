import {conversationKey} from './context-scope.mjs'
import { current } from './settings.mjs'
const ADMIN = new Set(['run_shell','read_file','write_file','list_dir','read_config','post_qzone','phone_control','write_diary','observe_world','skland_sign'])
export const DIRECTIVE_TOOL = { send:'send_message',remind:'set_reminder',tts:'send_voice',voice:'send_voice',image:'send_image',emoji:'send_sticker',file:'send_file',phone:'phone_control',adb:'phone_control',qzone:'post_qzone',diary:'write_diary',world:'observe_world',humanworld:'observe_world',search:'search_web',draw:'draw_image',like:'send_like' }
export function isOwner(p = {}, s = current()) {
  if(p.adminSession===true)return true
  if (p.kind === 'webui' || p.platform === 'webui') return true
  const id = String(p.userId || (p.kind === 'private' ? p.chatId : '') || '')
  const owners = Array.isArray(s.ownerUsers) ? s.ownerUsers : []
  return (!p.platform || p.platform === 'qq') && owners.map(String).includes(id)
}
export function canRunShell(p = {}, s = current()) {
  const privateQQ = p.kind === 'private' && (!p.platform || p.platform === 'qq')
  const webui = p.kind === 'webui' && (!p.platform || p.platform === 'webui')
  return s.permissionLevel === 'unrestricted' && (privateQQ || webui) && isOwner(p, s)
}
export function authorizeAction(name, args = {}, p = {}, s = current(), options = {}) {
  if (options.disabled || (s.agentTools === false && !options.manual)) return { ok:false, error:'动作执行已关闭' }
  if (s.paused && !options.manual) return { ok:false, error:'系统已暂停' }
  if (ADMIN.has(name) && !isOwner(p,s)) return { ok:false, error:'这项能力仅向管理员开放' }
  if (name === 'run_shell' && !canRunShell(p, s)) {
    return { ok: false, error: '通用 Shell 需要完全放权，仅限管理员 QQ 私聊或 Web 对话' }
  }
  const switches = {phone_control:'pluginPhoneEnabled',send_voice:'pluginTtsEnabled',post_qzone:'pluginQzoneEnabled',search_web:'websearchEnabled',draw_image:'pluginDrawEnabled'}
  if (switches[name] && s[switches[name]] === false) return {ok:false,error:'这项能力的开关已关闭'}
  const target = String(args.target || 'self')
  const isSelf = /^(?:self|me|here|当前|我|自己|本群)$/i.test(target) || target === String(p.chatId) || target===conversationKey(p)
  if (['send_message','set_reminder','send_voice','send_image','send_sticker','send_file'].includes(name) && !isSelf) {
    if (s.crossWindowEnabled === false) return {ok:false,error:'跨窗口发送已关闭'}
    if (!isOwner(p,s) && s.crossWindowAnyone !== true) return {ok:false,error:'跨窗口发送需要管理员权限'}
  }
  return {ok:true}
}
export function authorizedTarget(target, source, s = current()) {
  if (target.kind === source.kind && String(target.chatId) === String(source.chatId) && (target.platform || 'qq') === (source.platform || 'qq')) return true
  if (s.crossWindowEnabled === false) return false
  if(s.crossWindowAnyone === true && target.known === true) return true
  if (!isOwner(source,s)) return false
  if (target.platform === 'wechat') return (target.kind === 'group' ? s.allowWechatGroups : s.allowWechatUsers)?.map(String).includes(String(target.chatId)) || false
  return (target.kind === 'group' ? s.allowGroups : s.allowUsers)?.map(String).includes(String(target.chatId)) || false
}
