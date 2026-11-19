// Runs the real admission, debounce, lane, model and send pipeline with fake transport only.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const root=fs.mkdtempSync(path.resolve('.runtime-test-'));for(const [k,v] of Object.entries({WORKDIR:root,MEMORY_DIR:path.join(root,'memory'),SETTINGS_FILE:path.join(root,'settings.json'),CONTACTS_FILE:path.join(root,'memory/contacts.json'),LOG_DIR:path.join(root,'logs'),WEB_PORT:'3187',WEB_TOKEN:'synthetic-runtime-test',ONEBOT_WS:'ws://mock-only.invalid',ALLOW_USERS:'10001',ALLOW_GROUPS:'20001'}))process.env[k]=v;
const {save}=await import('./settings.mjs');save({botName:'肥鱼',ownerUsers:['10001'],allowUsers:['10001'],allowGroups:['20001'],atOnly:true,recordSilent:true,groupFollowUpEnabled:true,groupChimeInEnabled:false,proactiveEnabled:false,diaryEnabled:false,autoOrganize:false,embeddingProvider:'local',embeddingApiKey:'',debounceMs:600,debounceTypingGapMs:1500,debounceGroupMs:1500,debounceMaxWaitMs:5000,debounceSmart:false,chunkGapMs:0,ttsAutoProb:0,ttsAutoReplyProb:0,agentTools:false,llmProvider:'deepseek',deepseekApiKey:'synthetic-only',deepseekModel:'deepseek-chat',model:'deepseek-chat',apiProxy:''});
const sent=[],prompts=[];let socket;
class FakeSocket{constructor(){socket=this;this.readyState=0;this.listeners={};setImmediate(()=>{this.readyState=1;this.emit('open',{})})}addEventListener(t,fn){(this.listeners[t]??=[]).push(fn)}emit(t,data){for(const fn of this.listeners[t]||[])fn(data)}send(raw){const q=JSON.parse(raw);let data={};if(q.action==='get_login_info')data={user_id:99999,nickname:'肥鱼'};if(q.action==='get_friend_list')data=[{user_id:10001,nickname:'测试者'}];if(q.action==='get_group_list')data=[{group_id:20001,group_name:'模拟群'}];if(q.action==='get_group_info')data={group_id:20001,group_name:'模拟群'};if(q.action.startsWith('send_')){sent.push({at:Date.now(),...q});data={message_id:90000+sent.length}}setImmediate(()=>this.emit('message',{data:JSON.stringify({status:'ok',retcode:0,data,echo:q.echo})}))}close(){this.readyState=3;this.emit('close',{})}}
globalThis.WebSocket=FakeSocket;
globalThis.fetch=async(url,init)=>{assert.match(String(url),/chat\/completions$/);prompts.push(JSON.parse(init.body));return {ok:true,json:async()=>({choices:[{message:{role:'assistant',content:'可以，看看散热情况，你试完告诉我？'}}]})}};
await import('./onebot.mjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const waitFor=async(f,msg,ms=6500)=>{const end=Date.now()+ms;while(Date.now()<end){if(f())return;await sleep(60)}throw Error(msg)};
const event=(text,at=false,user=10001)=>socket.emit('message',{data:JSON.stringify({post_type:'message',message_type:'group',self_id:99999,user_id:user,group_id:20001,message_id:Date.now(),sender:{nickname:'测试'+user},message:[...(at?[{type:'at',data:{qq:'99999'}}]:[]),{type:'text',data:{text}}]})});
try{
 await waitFor(()=>socket.readyState===1,'fake transport failed');await sleep(80);socket.emit('message',{data:JSON.stringify({post_type:'notice',notice_type:'notify',sub_type:'poke'})});await sleep(50);const {recent}=await import('./logbus.mjs');assert.equal(recent(100).filter(x=>x.level==='error'&&/Cannot read properties of null/.test(x.msg||'')).length,0,'non-chat notice raised null error');const start=Date.now();event('我的 NAS 风扇今天有点吵',true);await sleep(700);event('温度大概五十度，刚看了日志');await sleep(950);assert.equal(sent.length,0,'replied before the typing gap ended');await waitFor(()=>sent.length===1,'merged reply missing');assert.ok(sent[0].at-start>=2100);const body=JSON.stringify(prompts[0]);assert.ok(body.includes('风扇今天有点吵')&&body.includes('温度大概五十度'),'fragments were not merged');
 const calls=prompts.length;event('我中午吃了拉面',false,10002);await sleep(1800);assert.equal(prompts.length,calls,'unrelated group member was admitted');event('那你说的散热，我已经检查完了');await waitFor(()=>sent.length===2,'same-person follow-up missing');assert.equal(prompts.length,calls+1);assert.equal(sent.filter(x=>x.action==='send_group_msg').length,2);
 const {runTask}=await import('./runner.mjs');save({modelFailureNotifyQQ:'10001'});
 globalThis.fetch=async()=>{throw new DOMException('simulated timeout','TimeoutError')};
 const checkFailure=()=>runTask('PRIVATE CHAT MARKER',{notifyModelFailure:true,ephemeral:true,disableTools:true});
 const failure=await checkFailure();assert.equal(failure.modelFailure,'timeout');
 await waitFor(()=>sent.length===3,'QQ failure notification missing');
 assert.equal(sent[2].action,'send_private_msg');assert.equal(sent[2].params.user_id,10001);
 assert.match(JSON.stringify(sent[2].params.message),/请求超时/);assert.doesNotMatch(JSON.stringify(sent[2]),/PRIVATE CHAT MARKER/);
 await checkFailure();await sleep(80);assert.equal(sent.length,3,'duplicate model alert sent');
 console.log('PASS failure notification: timeout, QQ owner only and duplicate suppression; fake transport');
 save({learnGroups:['20002']});
 const {listExpressionsForReview}=await import('./memory.mjs');
 const sample='现在杯面队长就是修完机器后大家用来庆祝的暗号';
 globalThis.fetch=async(_url,init)=>{
  const corpus=JSON.parse(JSON.parse(init.body).messages.at(-1).content);
  const source=corpus.find(row=>row.text===sample)?.key;
  assert.ok(source);assert.ok(corpus.every(row=>typeof row.speaker==='number'));
  const rules=[{ruleType:'meme',text:'杯面队长',scene:'机器恢复后的轻松庆祝',pattern:'先祝贺修好，之后可以顺势提到这个称呼',rationale:'暗号表示修理工作顺利收尾',avoid:'故障尚未解决时',keywords:['杯面队长'],source}];
  return {ok:true,json:async()=>({choices:[{message:{role:'assistant',content:JSON.stringify(rules)}}]})};
 };
 for(const [i,text] of ['新机器今天终于能开机了','排查过程花了一整个下午','我先再观察十分钟','所有灯都恢复正常啦','现在可以去吃晚饭了',sample].entries()){
  socket.emit('message',{data:JSON.stringify({post_type:'message',message_type:'group',self_id:99999,user_id:10001+i%2,group_id:20002,message_id:20000+i,sender:{nickname:'模拟群友'},message:[{type:'text',data:{text}}]})});
 }
 await waitFor(()=>listExpressionsForReview({status:'pending'}).items.some(row=>row.analyzed&&row.text==='杯面队长'),'learn-only group did not create a review candidate');
 assert.equal(sent.length,3,'learning-only group received a message');
 console.log('PASS group learning: real ingress, anonymized samples, pending rules, no chat response');
 console.log('PASS real runtime: delayed two-part merge, unrelated-speaker rejection, same-person unmentioned follow-up; no real network/messages');process.exit(0)
}catch(e){console.error(e);process.exit(1)}
