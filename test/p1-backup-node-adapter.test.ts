/** Retain the genuine standalone TLS/argv/restore suite under the approved hosted Vitest selector. */
import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
it('runs the real isolated PostgreSQL Node backup security suite without skips',()=>{
 const result=spawnSync(process.execPath,['--test','test/backup-credential-errors.node.test.mjs','test/backup-security.node.test.mjs'],{encoding:'utf8',timeout:240_000,env:process.env,maxBuffer:8*1024*1024});
 if(process.env.RUNNER_TEMP){
  const out=process.env.AIHR_FOCUSED_EVIDENCE_DIR??join(process.env.RUNNER_TEMP,'aihr-ci');mkdirSync(out,{recursive:true});
  const attempt=mkdtempSync(join(out,'backup-node-attempt-'));
  writeFileSync(join(attempt,'stdout.tap'),result.stdout??'',{flag:'wx',mode:0o600});
  writeFileSync(join(attempt,'stderr.log'),result.stderr??'',{flag:'wx',mode:0o600});
  writeFileSync(join(attempt,'process.json'),JSON.stringify({source:process.env.AIHR_CI_HEAD,status:result.status,signal:result.signal,error:result.error?.message,releaseAuthorized:false}),{flag:'wx',mode:0o600});
 }
 expect(result.error).toBeUndefined();expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stdout).toMatch(/# fail 0\b/);expect(result.stdout).toMatch(/# skipped 0\b/);expect(result.stdout).toMatch(/# tests [1-9]\d*\b/);
},250_000);
