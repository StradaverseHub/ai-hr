import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {retainedSourceIdentity} from './source-proof.mjs';
import {fileURLToPath} from 'node:url';
test('affected maintenance phase, source-custody, archive and terminal wrapper controls',()=>{
 const path=fileURLToPath(new URL('./test_maintenance_agent.py',import.meta.url));
 const result=spawnSync('python3',['-B',path],{encoding:'utf8',timeout:30000,maxBuffer:1024**2,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',LANG:'C.UTF-8'}});
 process.stdout.write(result.stderr??'');
 assert.equal(result.status,0);assert.equal(result.stdout,'');
});
test('wrong-ref or dirty retained source refuses even if remote markers/checksum would match',()=>{
 const directory=mkdtempSync(join(tmpdir(),'aihr-retained-source-fixture-'));
 const git=(...args)=>execFileSync('git',args,{cwd:directory,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
 try{
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  git('remote','add','origin','https://github.com/StradaverseHub/ai-hr.git');
  writeFileSync(join(directory,'app.js'),'original');git('add','app.js');git('-c','commit.gpgsign=false','commit','-qm','old baseline');
  const baseline=git('rev-parse','HEAD');
  assert.equal(retainedSourceIdentity(directory,baseline).retainedSourceRef,baseline);
  writeFileSync(join(directory,'app.js'),'different source, same remote markers');git('add','app.js');git('-c','commit.gpgsign=false','commit','-qm','different candidate');
  assert.throws(()=>retainedSourceIdentity(directory,baseline),/Exact clean retained baseline/);
  const wrong=git('rev-parse','HEAD');writeFileSync(join(directory,'app.js'),'uncommitted drift');
  assert.throws(()=>retainedSourceIdentity(directory,wrong),/Exact clean retained baseline/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('generated operator programs parse on the actual Linux Node22 toolchain',()=>{
 const programs=JSON.parse(readFileSync(new URL('./program-syntax-fixture.json',import.meta.url)));
 for(const [name,program]of Object.entries(programs)){
  execFileSync(process.execPath,['--input-type=module','--check'],{input:program,encoding:'utf8',timeout:5000,stdio:['pipe','pipe','pipe']});
  assert(name.endsWith('Program'));
 }
});
