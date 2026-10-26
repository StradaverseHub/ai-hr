import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
test('affected maintenance phase, source-custody, archive and terminal wrapper controls',()=>{
 const path=fileURLToPath(new URL('./test_maintenance_agent.py',import.meta.url));
 const result=spawnSync('python3',['-B',path],{encoding:'utf8',timeout:30000,maxBuffer:1024**2,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',LANG:'C.UTF-8'}});
 process.stdout.write(result.stderr??'');
 assert.equal(result.status,0);assert.equal(result.stdout,'');
});
test('generated operator programs parse on the actual Linux Node22 toolchain',()=>{
 const programs=JSON.parse(readFileSync(new URL('./program-syntax-fixture.json',import.meta.url)));
 for(const [name,program]of Object.entries(programs)){
  execFileSync(process.execPath,['--input-type=module','--check'],{input:program,encoding:'utf8',timeout:5000,stdio:['pipe','pipe','pipe']});
  assert(name.endsWith('Program'));
 }
});
