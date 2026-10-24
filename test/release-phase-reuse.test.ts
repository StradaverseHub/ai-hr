import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {artifactManifest,readArtifacts,validateRepairDelta,validatePhaseReuse,phaseReusePlan,HOME_REPAIR,BOOTSTRAP_FILES,BASELINE_ARTIFACTS,type PhaseReuseReceipt} from '../scripts/gate-phase-reuse-evidence';
import {environmentHash} from '../scripts/gate-impact-git';
import {digest} from '../scripts/gate-phase-reuse';
import {decideReleaseGate} from '../scripts/improve/release-gate';

const owner=process.cwd(),scratch=mkdtempSync(join(tmpdir(),'aihr-phase-proof-')),cwd=join(scratch,'repo'),archive=join(scratch,'archive'),state=join(scratch,'state');
let originalState:string|undefined,receipt:PhaseReuseReceipt,base:string,head:string;
const put=(root:string,p:string,s:string)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),s);};
const shell=(args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const commit=()=>{shell(['add','.']);shell(['-c','user.name=Phase proof','-c','user.email=proof@example.invalid','commit','-qm','synthetic evidence fixture']);return shell(['rev-parse','HEAD']);};
const passing=(files:number)=>`\n Test Files  ${files} passed (${files})\n Tests  ${files*2} passed (${files*2})\n Duration  1s\n`;
const rehash=()=>receipt.artifacts=artifactManifest(archive,receipt.artifacts.map(x=>x.path));
beforeAll(()=>{
 originalState=process.env.AIHR_IMPACT_STATE_DIR;process.env.AIHR_IMPACT_STATE_DIR=state;
 mkdirSync(cwd);mkdirSync(archive);shell(['init','-q']);put(cwd,'.gitignore','.gate-receipt.json\n.env.local\n');
 // These tiny files and logs are synthetic validator fixtures, never application test evidence.
 for(let i=0;i<947;i++)put(cwd,`test/n${String(i).padStart(3,'0')}.test.ts`,'export {};\n');
 for(let i=0;i<8;i++)put(cwd,`test/db${i}.test.ts`,"import {readFileSync} from 'node:fs'; // migrate"+'TestDb(\n');
 const old=execFileSync('git',['show','65ee43f2632f7e63a3780e57e22e52a83a9ac614:'+HOME_REPAIR.path],{cwd:owner,encoding:'utf8'});
 expect(digest(old)).toBe(HOME_REPAIR.before);put(cwd,HOME_REPAIR.path,old);
 put(cwd,'scripts/gate-impact-git.ts','export {};');
 put(cwd,'app/page.ts','export {};');put(cwd,'core/employee-home.ts','export {};');
 // The classifier requires a resolvable local path even for mocked product imports.
 put(cwd,'lib/scope.ts','export {};');put(cwd,'lib/authz.ts','export {};');put(cwd,'core/read.ts','export {};');put(cwd,'core/assistant-grant.ts','export {};');put(cwd,'components/employee-home/personal-home.tsx','export {};');
 base=commit();
 const all=shell(['ls-files','test']).split('\n').sort(),db=all.filter(p=>p.startsWith('test/db')),nodb=all.filter(p=>!db.includes(p));
 expect(nodb.length).toBe(948);
 for(const p of BOOTSTRAP_FILES)put(cwd,p,readFileSync(join(owner,p),'utf8'));
 put(cwd,HOME_REPAIR.path,readFileSync(join(owner,HOME_REPAIR.path),'utf8'));head=commit();
 const plan=phaseReusePlan(base,head,cwd),env=environmentHash(cwd),at=new Date().toISOString();
 const originalPlan={sha:base,base,deployed:base,environmentHash:env,plan:{synthetic:true}};
 const learning={sha:base,base,environmentHash:env,tier:'full',result:'FAIL',failed:[HOME_REPAIR.path],at,id:base+'.synthetic',plan:originalPlan.plan,fullReceipt:{sha:base,tier:'full',result:'FAIL'}};
 put(state,'gates/'+learning.id+'.json',JSON.stringify(learning));
 for(const name of BASELINE_ARTIFACTS)put(archive,name,'synthetic provenance\n');
 put(archive,'plan.json',JSON.stringify(originalPlan));put(archive,'learning.json',JSON.stringify(learning));
 put(archive,'all-files.txt',all.join('\n')+'\n');put(archive,'db-files.txt',db.join('\n')+'\n');put(archive,'nodb-files.txt',nodb.join('\n')+'\n');
 put(archive,'classify.tsv',[...db.map(p=>'DB\t'+p+'\tfixture'),...nodb.map(p=>'NODB\t'+p+'\tfixture')].join('\n'));
 put(archive,'full-controller.log',db.map((_,i)=>`════ part (b) chunk ${i+1}/8 — 1 DB files ════\nexit=0 peak-disk=1% wall=1s (rebuild+migrate+vitest)\n${passing(1)}`).join('')+'════ FINAL ════\n'+db.map((_,i)=>`chunk ${i+1}: exit=0 Test Files 1 passed (1)\n`).join('')+`runs: 9 files counted: 956 of 956 in the suite (948 no-DB + 8 DB)\n`);
 for(let i=1;i<=8;i++)put(archive,`chunk${i}.log`,passing(1));
 put(archive,'nodb.log',`FAIL ${HOME_REPAIR.path}\n Test Files 1 failed | 947 passed (948)\n Tests 3 failed | 12338 passed (12341)\n Duration 1s\n`);
 put(archive,'impact-gate-5433.log',base);
 const fixture={systemIdentifier:'synthetic',databases:[{name:'fictional',oid:'1'}],logicalDatabaseHashes:{fictional:'abc'}};
 for(const prefix of ['','fresh-']){
  put(archive,prefix+'fixture-5433-before.json',JSON.stringify(fixture));put(archive,prefix+'fixture-5433-after.json',JSON.stringify(fixture));
  put(archive,prefix+'port-handover-result.json',JSON.stringify({candidate:prefix?head:base,gateExit:prefix?0:1,nextBuildExit:null,currentOwnedFixtureClusterRestoredAndLogicallyUnchanged:true,productionChanged:false}));
 }
 put(archive,'fresh-nodb.log',passing(plan.nodb.length));
 const batches=Array.from({length:Math.ceil(plan.affected.length/64)},(_,i)=>plan.affected.slice(i*64,(i+1)*64));
 const database=batches.map((files,i)=>{const log=`fresh-db-${i+1}.log`;put(archive,log,passing(files.length));return {files,log,exit:0};});
 const names=[...BASELINE_ARTIFACTS,'fresh-fixture-5433-before.json','fresh-fixture-5433-after.json','fresh-port-handover-result.json','fresh-nodb.log',...database.map(r=>r.log)];
 receipt={sha:head,result:'PASS',tier:'phase-reuse',base,deployedBase:base,environmentHash:env,policyVersion:1,at,archive,artifacts:artifactManifest(archive,names),nodb:{files:plan.nodb,log:'fresh-nodb.log',exit:0},database,planFingerprint:plan.impact.fingerprint};
},120000);
afterAll(()=>{if(originalState===undefined)delete process.env.AIHR_IMPACT_STATE_DIR;else process.env.AIHR_IMPACT_STATE_DIR=originalState;rmSync(scratch,{recursive:true,force:true});});
const check=(r=receipt)=>validatePhaseReuse(r,{head,deployedRef:base,worktree:cwd});
describe('real filesystem, committed source and release provenance',()=>{
 it('accepts all eight original phases plus the complete fresh partitions and restored fixtures',()=>{
  const x=check();expect(x.base.counted).toEqual({files:8,tests:16});expect(x.freshNodb.files).toBe(receipt.nodb.files.length);
  expect(x.plan.affected.length).toBeGreaterThan(0);expect(x.base.learning.result).toBe('FAIL');
 });
 it.each([
  ['wrong SHA',(r:PhaseReuseReceipt)=>r.sha='0'.repeat(40)],
  ['wrong tier',(r:PhaseReuseReceipt)=>(r as {tier:string}).tier='full'],
  ['failed result',(r:PhaseReuseReceipt)=>r.result='FAIL'],
  ['environment change',(r:PhaseReuseReceipt)=>r.environmentHash='bad'],
  ['production moved',(r:PhaseReuseReceipt)=>r.deployedBase='0'.repeat(40)],
  ['policy change',(r:PhaseReuseReceipt)=>r.policyVersion=0],
  ['graph change',(r:PhaseReuseReceipt)=>r.planFingerprint='bad'],
  ['missing fresh no-DB file',(r:PhaseReuseReceipt)=>r.nodb.files.pop()],
  ['failed fresh no-DB exit',(r:PhaseReuseReceipt)=>r.nodb.exit=1],
  ['missing fresh DB batch',(r:PhaseReuseReceipt)=>r.database.pop()],
  ['failed fresh DB exit',(r:PhaseReuseReceipt)=>r.database[0].exit=1],
  ['duplicate fresh DB batch',(r:PhaseReuseReceipt)=>r.database.push(r.database[0])],
  ['missing artifact',(r:PhaseReuseReceipt)=>r.artifacts=r.artifacts.filter(a=>a.path!=='chunk8.log')],
  ['altered artifact hash',(r:PhaseReuseReceipt)=>r.artifacts[0].sha256='0'.repeat(64)],
  ['duplicate artifact',(r:PhaseReuseReceipt)=>r.artifacts.push(r.artifacts[0])],
 ] as [string,(r:PhaseReuseReceipt)=>void][])('refuses %s',(_,mutate)=>{const r=structuredClone(receipt);mutate(r);expect(()=>check(r)).toThrow();});
 it('refuses missing mandatory release revalidation and carries its refusal',()=>{
  const p={receipt,head,deployedVerdict:()=>({error:'must not call'})};
  expect(decideReleaseGate(p).ok).toBe(false);
  expect(decideReleaseGate({...p,phaseReuseVerdict:()=>({ok:false,lines:['tampered evidence']})})).toEqual({ok:false,lines:['tampered evidence']});
  expect(decideReleaseGate({...p,phaseReuseVerdict:()=>{check();return {ok:true,lines:['validated']};}})).toEqual({ok:true,tier:'phase-reuse',lines:['validated']});
 });
 it.each(['app/page.ts','core/shared-fixture.ts','test/db0.test.ts','vitest.config.ts','pnpm-lock.yaml'])('refuses committed product/config/helper/DB-test delta %s',(path)=>{
  const before=shell(['rev-parse','HEAD']);put(cwd,path,'// unauthorized delta');const changed=commit();
  try{expect(()=>validateRepairDelta(base,changed,cwd)).toThrow(/unapproved/);}finally{shell(['reset','--hard',before]);}
 });
 it('refuses dirty current source',()=>{put(cwd,'app/page.ts','// dirty');try{expect(()=>check()).toThrow(/dirty/);}finally{shell(['restore','app/page.ts']);}});
 it('refuses a missing artifact, a changed raw file and a symlink',()=>{
  const p=join(archive,'chunk1.log'),old=readFileSync(p,'utf8');
  rmSync(p);expect(()=>readArtifacts(archive,receipt.artifacts)).toThrow();
  writeFileSync(p,old+'tampered');expect(()=>readArtifacts(archive,receipt.artifacts)).toThrow(/tampered/);
  rmSync(p);symlinkSync(join(archive,'chunk2.log'),p);expect(()=>readArtifacts(archive,receipt.artifacts)).toThrow(/regular/);
  rmSync(p);writeFileSync(p,old);
 });
 it.each(['port-handover-result.json','fresh-port-handover-result.json','fixture-5433-after.json','fresh-fixture-5433-after.json'])('refuses changed restoration even with updated hashes: %s',name=>{
  const old=readFileSync(join(archive,name),'utf8'),oldManifest=receipt.artifacts;
  put(archive,name,JSON.stringify({candidate:head,currentOwnedFixtureClusterRestoredAndLogicallyUnchanged:false}));rehash();
  try{expect(()=>check()).toThrow();}finally{put(archive,name,old);receipt.artifacts=oldManifest;}
 });
 it('refuses stale baseline age',()=>expect(()=>validatePhaseReuse(receipt,{head,deployedRef:base,worktree:cwd,now:Date.now()+8*86400000})).toThrow(/expired/));
 it('refuses a changed environment file even when ignored by Git',()=>{put(cwd,'.env.local','CHANGED=true');try{expect(()=>check()).toThrow(/environment/);}finally{rmSync(join(cwd,'.env.local'));}});
 it('refuses any assertion weakening in the fingerprinted Home repair',()=>{const before=shell(['rev-parse','HEAD']);put(cwd,HOME_REPAIR.path,'// removed assertions');const changed=commit();try{expect(()=>validateRepairDelta(base,changed,cwd)).toThrow(/reviewed additive repair/);}finally{shell(['reset','--hard',before]);}});
 it('refuses changed saved original observation',()=>{
  const path=join(state,'gates',base+'.synthetic.json'),old=readFileSync(path,'utf8');writeFileSync(path,'{}');
  try{expect(()=>check()).toThrow(/observation/);}finally{writeFileSync(path,old);}
 });
});

describe('the actual finalization CLI',()=>{
 it('finalizes only after restoration, rechecks pinned bytes, and invalidates prior PASS on failure',()=>{
  const names=['port-handover-result.json','fixture-5433-before.json','fixture-5433-after.json'];
  const fresh=names.map(n=>[n,readFileSync(join(archive,'fresh-'+n),'utf8')] as const);
  for(const [name,bytes]of fresh){put(scratch,name,bytes);rmSync(join(archive,'fresh-'+name));}
  const pending={...structuredClone(receipt),result:'FAIL',artifacts:receipt.artifacts.filter(a=>!a.path.startsWith('fresh-fixture')&&a.path!=='fresh-port-handover-result.json')};
  put(scratch,'pending.json',JSON.stringify(pending));
  const bin=join(scratch,'bin');put(bin,'ssh',`#!/bin/sh\nprintf 'state=ok\nref=${base}\nbuilt_ref=${base}\nstale_build=0\n'\n`);chmodSync(join(bin,'ssh'),0o700);
  const invoke=()=>execFileSync(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),join(owner,'scripts/gate-phase-reuse-run.ts'),'--reuse-db',scratch,scratch,'--finalize'],{cwd,env:{...process.env,PATH:bin+':'+process.env.PATH},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000});
  try{
   expect(invoke()).toContain('PASS tier=phase-reuse');
   const issued=JSON.parse(readFileSync(join(cwd,'.gate-receipt.json'),'utf8'));expect(issued.result).toBe('PASS');expect(issued.tier).toBe('phase-reuse');
   const log=join(archive,'chunk8.log'),old=readFileSync(log,'utf8');writeFileSync(log,old+'tampered');
   try{expect(invoke).toThrow();expect(JSON.parse(readFileSync(join(cwd,'.gate-receipt.json'),'utf8')).result).toBe('FAIL');}finally{writeFileSync(log,old);}
  }finally{for(const [name,bytes]of fresh)put(archive,'fresh-'+name,bytes);}
 });
});
