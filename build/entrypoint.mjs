import {existsSync,symlinkSync} from 'node:fs';import {join} from 'node:path';
import {seedWorkspace} from './seed-workspace.mjs'
const root=process.env.WORKDIR||'/workspace';
seedWorkspace('/opt/workspace-seed',root);
const modules=join(root,'tools','node_modules');if(!existsSync(modules))symlinkSync('/opt/node_modules',modules,'dir');
await import('/opt/hand/onebot.mjs');
