import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

it('the legacy cleanroom entry uses canonical full admission and preserves foreign resources on refusal',()=>{
 const dir=mkdtempSync(join(tmpdir(),'aihr-cleanroom-entry-'));
 try {
  mkdirSync(join(dir,'scripts'));copyFileSync(resolve('cleanroom-verify.sh'),join(dir,'cleanroom-verify.sh'));
  writeFileSync(join(dir,'.env.local'),'FOREIGN_ENV=untouched\n');writeFileSync(join(dir,'.env.local.cleanroom.bak'),'FOREIGN_BACKUP=untouched\n');
  writeFileSync(join(dir,'scripts/gate.sh'),'#!/bin/bash\nprintf "%s\\n" "$@" > forwarded\nexit 23\n');
  const result=spawnSync('bash',[join(dir,'cleanroom-verify.sh'),'--proof-context'],{cwd:dir,encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH??'',NODE_ENV:'test' as const}});
  expect(result.error).toBeUndefined();expect(result.status).toBe(23);
  expect(readFileSync(join(dir,'forwarded'),'utf8').trim().split('\n')).toEqual(['--full','--proof-context']);
  expect(readFileSync(join(dir,'.env.local'),'utf8')).toBe('FOREIGN_ENV=untouched\n');
  expect(readFileSync(join(dir,'.env.local.cleanroom.bak'),'utf8')).toBe('FOREIGN_BACKUP=untouched\n');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
