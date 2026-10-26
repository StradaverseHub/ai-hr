/** Real detached candidate launcher, tiny private shell child; no app build/database/service. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const raw=await import(pathToFileURL(join(process.cwd(),'scripts/improve/release.ts')).href),official={...(raw.default??{}),...raw};
const sha='a'.repeat(40),baked='00000000-0000-4000-8000-000000000001',attempt='00000000-0000-4000-8000-000000000002';
test('actual canonical launcher selects separate install/baked UUIDs and preserves its legacy launch',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'ci-launch-'))),state=join(root,'state');mkdirSync(join(root,'deploy'));mkdirSync(state);
 try{
  writeFileSync(join(root,'deploy/deploy.sh'),'#!/usr/bin/env bash\nprintf "%s\\n" "$@" > received-args\n',{mode:0o700});
  const launch=official.buildLaunchCommand(sha,root,state,baked,attempt);
  const result=spawnSync('bash',['-c',launch],{encoding:'utf8',timeout:3000});assert.equal(result.status,0,result.stderr);
  const expected='--testing-build-record='+baked+'\n--ci-build='+attempt+'\n';
  const end=Date.now()+3000;while(Date.now()<end){if(existsSync(join(root,'received-args'))&&readFileSync(join(root,'received-args'),'utf8')===expected)break;await new Promise(done=>setTimeout(done,20));}
  assert.equal(readFileSync(join(root,'received-args'),'utf8'),'--testing-build-record='+baked+'\n--ci-build='+attempt+'\n');
  assert(!official.buildLaunchCommand(sha,root,state,baked).includes('--ci-build'));
  assert(!official.buildLaunchCommand(sha,root,state).includes('--testing-build-record'));
  assert.throws(()=>official.buildLaunchCommand(sha,root,state,undefined,attempt));
  assert.throws(()=>official.buildLaunchCommand(sha,root,state,baked,'invalid;command'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
