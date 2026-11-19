import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path'
const root=fs.mkdtempSync(path.resolve('.flash-test-'));process.env.WORKDIR=root;process.env.SETTINGS_FILE=path.join(root,'settings.json');process.env.WEB_TOKEN='synthetic-test';
const settings=await import('./settings.mjs');const runner=await import('./runner.mjs');
settings.save({model:'deepseek-flash',deepseekModel:'deepseek-flash',llmProvider:'deepseek',deepseekApiKey:'test-key',apiProxy:''});settings.reload();
assert.equal(settings.current().model,'deepseek-flash');assert.equal(settings.current().deepseekModel,'deepseek-flash');assert.equal(runner.resolveProvider().model,'deepseek-flash');
assert.equal(runner.resolveProvider({llmProvider:'deepseek',deepseekApiKey:'k',model:'deepseek-v4-pro',deepseekModel:'deepseek-v4-pro'}).model,'deepseek-v4-pro');
assert.equal(runner.resolveProvider({llmProvider:'deepseek',deepseekApiKey:'k',model:'deepseek-flash',deepseekModel:'deepseek-reasoner'}).model,'deepseek-flash');
let sent;globalThis.fetch=async (_url,init)=>{sent=JSON.parse(init.body);return {ok:true,json:async()=>({choices:[{message:{content:'ok'}}]})}};
await runner.testDeepseekConnection();assert.equal(sent.model,'deepseek-flash');console.log('PASS: persisted model, provider resolution, test request use deepseek-flash; other models preserved');
