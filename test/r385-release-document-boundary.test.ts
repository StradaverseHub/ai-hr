import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {it,expect} from 'vitest';
import {deploymentRsyncArgs} from '../scripts/improve/release';

it('the actual deployment filter ships app changes while keeping internal records local and existing server records intact',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-r385-release-'));
 const source=join(root,'source'),destination=join(root,'server');
 try{
  for(const dir of [source,destination])mkdirSync(join(dir,'docs','adr'),{recursive:true});
  writeFileSync(join(source,'app.txt'),'synthetic new app source');
  writeFileSync(join(destination,'obsolete-app.txt'),'obsolete synthetic app source');
  writeFileSync(join(source,'docs','HANDOFF-HISTORY.md'),'synthetic local internal history');
  writeFileSync(join(source,'docs','adr','0091-private.md'),'synthetic local internal decision');
  writeFileSync(join(destination,'docs','HANDOFF-HISTORY.md'),'synthetic existing server history');
  writeFileSync(join(destination,'docs','adr','0090-existing.md'),'synthetic existing server decision');
  execFileSync('rsync',deploymentRsyncArgs(source,destination+'/'));
  expect(readFileSync(join(destination,'app.txt'),'utf8')).toBe('synthetic new app source');
  expect(existsSync(join(destination,'obsolete-app.txt'))).toBe(false);
  expect(readFileSync(join(destination,'docs','HANDOFF-HISTORY.md'),'utf8')).toBe('synthetic existing server history');
  expect(existsSync(join(destination,'docs','adr','0091-private.md'))).toBe(false);
  expect(readFileSync(join(destination,'docs','adr','0090-existing.md'),'utf8')).toBe('synthetic existing server decision');
 }finally{rmSync(root,{recursive:true,force:true});}
});
