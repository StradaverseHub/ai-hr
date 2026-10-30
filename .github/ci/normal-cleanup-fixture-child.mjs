/** Fictional hosted IPC fixture; no live runtime, SSH, grants or cleanup engine. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runNormalCleanupSession,RESULT_KIND} from './normal-cleanup-session.mjs';
import {readSingleCleanupCommit,durableCleanupRecord,acquireNormalCleanupLock} from './normal-cleanup-io.mjs';
import {join} from 'node:path';
import {installJson} from './ci-install-grant.mjs';
assert(process.argv.length===3);const directory=process.argv[2],grant=JSON.parse(readFileSync(join(directory,'grant.json'))),release=acquireNormalCleanupLock(join(directory,'normal-cleanup.lock'),{fixture:true});
try{
 const result=await runNormalCleanupSession({grant,retainAudit:async()=>durableCleanupRecord(join(directory,'audit.json'),{fictional:true}),fences:async()=>({source:'fictional',pid:'1',ledger:'unchanged'}),
  audit:async()=>({source:grant.source,healthStatus:200}),persist:async(name,value)=>durableCleanupRecord(join(directory,name+'.json'),value),
  consume:async ready=>durableCleanupRecord(join(directory,'consumed.json'),{nonce:ready.nonce}),authorize:async proof=>durableCleanupRecord(join(directory,'authority.json'),proof),
  removeOwned:async()=>{durableCleanupRecord(join(directory,'engine-observed.json'),{consumed:!!readFileSync(join(directory,'consumed.json'))});return {fictional:true};},
  io:{ready:async ready=>process.stdout.write(installJson(ready)+'\n'),commit:()=>readSingleCleanupCommit(process.stdin)}});
 process.stdout.write(installJson({format:1,kind:RESULT_KIND,result})+'\n');
}finally{release();}
