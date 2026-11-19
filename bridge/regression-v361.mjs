import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import './assets/access-token.js'
import {normalizeWechatContacts,addWechatThreads,migrateWechatSelection} from './channel-contacts.mjs'
const {normalize,error}=globalThis.WhaleAuth
test('fixed passwords and pasted connection links normalize without inventing passwords',()=>{
 assert.equal(normalize(' 访问密码： `fixed-test-2026` '),'fixed-test-2026')
 assert.equal(normalize('http://nas:3081/?t=fixed-test-2026'),'fixed-test-2026')
 assert.equal(normalize('\u200bfixed-test-2026\ufeff'),'fixed-test-2026')
 assert.equal(error('fixed-test-2026'),'')
 for(const value of ['c2a8…ef0a','c2a8...ef0a','中文fixed-test','fixed\n-test',''])assert.ok(error(value),value)
 assert.equal(normalize('中文fixed-test'),'中文fixed-test')
})
test('explicit old password wins over persisted random token; empty config remains stable',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-auth-'))
 try{
  fs.writeFileSync(path.join(root,'.web-token'),'a'.repeat(64))
  const code="import {webToken} from './bridge/web-auth.mjs'; process.stdout.write(webToken())"
  for(const configured of ['fixed-test-2026','old-fixed-password','']){
   const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,WORKDIR:root,WEB_TOKEN:configured},encoding:'utf8'})
   assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,configured||'a'.repeat(64))
  }
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
test('QQ and WeChat identities never collide, allowed contacts appear before first message',()=>{
 const contacts=normalizeWechatContacts([{user_id:'123',legacy_user_id:100009,nickname:'微信好友'}],[{group_id:'room@chatroom',group_name:'微信群'}])
 assert.equal(contacts.friends[0].legacyId,'100009')
 const map=new Map([['qq:private:123',{peer:'QQ好友'}],['wechat:private:old',{peer:'旧历史'}]])
 const settings={allowUsers:['123'],allowWechatUsers:['123'],allowWechatGroups:['room@chatroom']}
 addWechatThreads(map,contacts,settings)
 assert.equal(map.get('qq:private:123').peer,'QQ好友')
 assert.equal(map.get('wechat:private:123').peer,'微信好友')
 assert.equal(map.get('wechat:group:room@chatroom').kind,'group')
 assert.equal(map.get('wechat:private:old').peer,'旧历史')
 assert.deepEqual(settings.allowUsers,['123'])
 const blocked=new Map();addWechatThreads(blocked,contacts,{allowUsers:['123'],allowWechatUsers:[]});assert.equal(blocked.size,0)
})
test('legacy WeChat selections migrate once without changing QQ or dropping unknown contacts',()=>{
 const s={allowUsers:['100009'],allowWechatUsers:['100009','unknown'],targets:{'100009':{note:'QQ'},'wechat:private:100009':{note:'微信'},'wechat:private:alias':{prompt:'保留新配置'}}}
 const contacts=normalizeWechatContacts([{user_id:'alias',legacy_user_id:100009,nickname:'好友'}])
 const patch=migrateWechatSelection(s,contacts)
 assert.deepEqual(patch.allowWechatUsers,['alias','unknown']);assert.equal(patch.targets['100009'].note,'QQ');assert.equal(patch.targets['wechat:private:alias'].note,'微信');assert.equal(patch.targets['wechat:private:alias'].prompt,'保留新配置');assert.equal(patch.targets['wechat:private:100009'],undefined)
 assert.deepEqual(s.allowWechatUsers,['100009','unknown']);assert.equal(migrateWechatSelection({...s,...patch},contacts),null)
})
