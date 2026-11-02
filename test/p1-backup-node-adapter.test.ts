/** Retain the genuine standalone TLS/argv/restore suite under the approved hosted Vitest selector. */
import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
it('runs the real isolated PostgreSQL Node backup security suite without skips',()=>{
 const result=spawnSync(process.execPath,['--test','test/backup-credential-errors.node.test.mjs','test/backup-security.node.test.mjs'],{encoding:'utf8',timeout:240_000,env:process.env,maxBuffer:8*1024*1024});
 expect(result.error).toBeUndefined();expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stdout).toMatch(/# fail 0\b/);expect(result.stdout).toMatch(/# skipped 0\b/);expect(result.stdout).toMatch(/# tests [1-9]\d*\b/);
},250_000);
