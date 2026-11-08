/** Nonroot disposable CLI/source controls, never actual dependency or Next boot acceptance. */
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url);
const probe=require('../deploy/admission/next_dependency_probe.cjs') as {
 STAGES:readonly string[];failure:(stage:unknown)=>string;progress:(stage:unknown)=>string;
 admit:(facts:{platform:string;getuid:()=>number;argv:string[];env:Record<string,string>;cwd:()=>string})=>string;
};
const stages=['admission','next-version','sharp-image','font-layout','next-config','executable-maps'];
const environment=()=>({NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',HOME:'/var/empty/aihr',PATH:'/usr/bin:/bin'});

it('emits only the six closed owned stages and refuses private or unknown diagnostic values',()=>{
 expect(probe.STAGES).toEqual(stages);
 for(const stage of stages){
  expect(probe.failure(stage)).toBe(JSON.stringify({version:1,kind:'NATIVE_DEPENDENCY_PROBE_REFUSAL',stage})+'\n');
  expect(probe.progress(stage)).toBe(JSON.stringify({version:1,kind:'NATIVE_DEPENDENCY_PROBE_STAGE_ENTERED',stage})+'\n');
 }
 for(const value of ['/private/TOKEN=fictional',null,{},'unknown'])for(const method of [probe.failure,probe.progress]){
  expect(()=>method(value)).toThrow('Unknown native dependency probe stage');
 }
});
it('admits the physical copied root and refuses original or foreign cwd before application dependencies',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'aihr-probe-cwd-')));
 try{
  const facts={platform:'linux',getuid:()=>1001,argv:['node','probe',root],env:environment(),cwd:()=>root};
  expect(probe.admit(facts)).toBe(root);
  for(const cwd of [process.cwd(),'/foreign/runtime'])expect(()=>probe.admit({...facts,cwd:()=>cwd})).toThrow('copied runtime');
  expect(()=>probe.admit({...facts,argv:['node','probe',root+'/../outside']})).toThrow();
 }finally{rmSync(root,{recursive:true});}
});
it('retains root-user, private-HOME and ambient database/token denial at the admission boundary',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'aihr-probe-admission-')));
 try{
  const facts={platform:'linux',getuid:()=>1001,argv:['node','probe',root],env:environment(),cwd:()=>root};
  expect(()=>probe.admit({...facts,getuid:()=>0})).toThrow();
  expect(()=>probe.admit({...facts,env:{...environment(),HOME:'/nonexistent'}})).toThrow();
  for(const key of ['DATABASE_URL','ACTIONS_RUNTIME_TOKEN','NODE_OPTIONS','NODE_PATH','SSH_AUTH_SOCK']){
   expect(()=>probe.admit({...facts,env:{...environment(),[key]:'fictional-private-value'}})).toThrow();
  }
 }finally{rmSync(root,{recursive:true});}
});
it('executes the real nonroot CLI and distinguishes rejected checkout cwd from an admitted empty runtime',()=>{
 expect(process.platform).toBe('linux');expect(process.getuid!()).toBeGreaterThan(0);
 const root=realpathSync(mkdtempSync(join(tmpdir(),'aihr-probe-cli-')));
 const helper=resolve('deploy/admission/next_dependency_probe.cjs');
 try{
  for(const [cwd,expected]of [[process.cwd(),'admission'],[root,'next-version']]){
   const result=spawnSync(process.execPath,['--max-old-space-size=256',helper,root],{cwd,env:environment(),encoding:'utf8',timeout:10000});
   expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status).toBe(1);expect(result.stdout).toBe('');
   const entered=stages.slice(0,stages.indexOf(expected)+1).map(probe.progress).join('');
   expect(result.stderr).toBe(entered+probe.failure(expected));
   expect(result.stderr).not.toContain(root);expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
  }
 }finally{rmSync(root,{recursive:true});}
});
it('the real CLI refuses a same-version ambient dependency before its executable fallback can run',()=>{
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'aihr-probe-ambient-'))),root=join(parent,'runtime'),marker=join(parent,'unowned-executed');
 mkdirSync(root);mkdirSync(join(parent,'node_modules/next'),{recursive:true});mkdirSync(join(parent,'node_modules/sharp'),{recursive:true});
 writeFileSync(join(parent,'node_modules/next/package.json'),' {"name":"next","version":"16.4.1"}');
 writeFileSync(join(parent,'node_modules/sharp/index.js'),'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"unowned");throw Error("fictional private content");');
 try{
  const result=spawnSync(process.execPath,['--max-old-space-size=256',resolve('deploy/admission/next_dependency_probe.cjs'),root],
   {cwd:root,env:environment(),encoding:'utf8',timeout:10000});
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status).toBe(1);
  expect(result.stderr).toBe(stages.slice(0,2).map(probe.progress).join('')+probe.failure('next-version'));
  expect(result.stdout).toBe('');expect(existsSync(marker)).toBe(false);
 }finally{rmSync(parent,{recursive:true});}
});
