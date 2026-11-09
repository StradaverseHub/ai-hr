import {describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {closeSync,copyFileSync,linkSync,mkdirSync,mkdtempSync,openSync,readFileSync,readSync,renameSync,rmSync,symlinkSync,unlinkSync,writeFileSync,writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtureNavigationActor,localNavigationHref,navigationExpectedText,NAVIGATION_CAPTURE_VERSION,NAVIGATION_HARNESS_ROOTS,NAVIGATION_SCENARIO_FILE,
 validateNavigationCapture,validateNavigationScenarioPlan,type NavigationScenarioPlan} from '../scripts/performance/navigation-protocol';
import {navigationSha256,navigationSourceIdentity} from '../scripts/performance/navigation-source';
const readPlan=()=>JSON.parse(readFileSync(new URL('../scripts/performance/navigation-scenarios.json',import.meta.url),'utf8'));
const expected={candidateSha:'a'.repeat(40),controllerSha:'b'.repeat(40),runId:123,harnessSha256:'c'.repeat(64),scenarioSha256:'d'.repeat(64),phase:'baseline' as 'baseline'|'loaded'};
const indices={groupHR:0,companyHR:1,manager:2,employee:4};
function capture(plan:NavigationScenarioPlan,phase:'baseline'|'loaded'='baseline'){
 return {schemaVersion:1,protocol:NAVIGATION_CAPTURE_VERSION,releaseAuthorized:false,fixture:plan.fixture,engine:plan.engine,...expected,phase,runAttempt:1,complete:true,
  observations:plan.scenarios.map(s=>({entry:s.entry??'canonical-link',scenarioId:s.id,destinationId:s.destinationId,role:s.role,actorIndex:indices[s.role],href:s.href,outcome:s.outcome,readiness:s.readiness,
   status:200,finalPath:s.outcome==='denied'?'/':s.href,internalSessionObserved:true,fixtureIdentityObserved:true,elapsedMs:120,
   checks:s.checks.map(c=>({id:c.id,passed:true,observedCount:c.kind==='count'||c.kind==='fixture-roster-rows'?c.minimum:1})),failures:{busy:0,unavailable:0,alerts:0,http500:0,pageErrors:0},
   ...(phase==='loaded'?{startedWith:{active:500,inSteadyWindow:true},usableWith:{active:500,inSteadyWindow:true}}:{})}))};
}
describe('closed source-reviewed navigation development protocol (not authenticated execution)',()=>{
 it('models actual role allocation across both fictional tenant cohorts',()=>{
  expect([0,1,2,4,50,250,251,252,254].map(i=>fixtureNavigationActor(i).role)).toEqual(['groupHR','companyHR','manager','employee','companyHR','groupHR','companyHR','manager','employee']);
  expect(()=>fixtureNavigationActor(500)).toThrow();expect(()=>fixtureNavigationActor(-1)).toThrow();
  expect(navigationExpectedText('$fixture.firstCompanyPersonName',299)).toBe('PERF Person 0250');
  expect(()=>navigationExpectedText('$fixture.unreviewed',1)).toThrow();
 });
 it('admits only same-origin local navigation addresses',()=>{
  expect(localNavigationHref('/leave/employee-balances')).toBe(true);
  for(const href of ['https://evil.invalid','//evil.invalid','/x\\y','/x#private','/x\n'])expect(localNavigationHref(href)).toBe(false);
 });
 it('keeps source scenarios explicitly partial and includes positive and denied native roles',()=>{
  const plan=validateNavigationScenarioPlan(readPlan());expect(plan.scenarios).toHaveLength(48);
  expect(new Set(plan.scenarios.map(s=>s.destinationId)).size).toBe(14);
  for(const id of new Set(plan.scenarios.map(s=>s.destinationId))){const cases=plan.scenarios.filter(s=>s.destinationId===id);expect(new Set(cases.map(s=>s.role)).size).toBe(cases[0].entry==='direct-route-content'||cases[0].entry==='shell-menu'?2:4);}
  expect(validateNavigationCapture(capture(plan),plan,expected).observations).toHaveLength(48);
  expect(validateNavigationCapture(capture(plan,'loaded'),plan,{...expected,phase:'loaded'}).phase).toBe('loaded');
 });
 it('rejects heading-only proof, URL query context not yet observed, unknown steps, and duplicate scenario IDs',()=>{
  for(const edit of [(p:any)=>p.scenarios[0].checks[0].selector='main h1',(p:any)=>p.scenarios[0].href+='?different=scope',
   (p:any)=>p.scenarios[0].steps[0].kind='submit',(p:any)=>p.scenarios.push(p.scenarios[0])]){
   const plan=readPlan();edit(plan);expect(()=>validateNavigationScenarioPlan(plan)).toThrow();
  }
 });
 it('refuses cross-source/role claims, missing checks, handled failures, and incomplete captures',()=>{
  const plan=validateNavigationScenarioPlan(readPlan());
  for(const edit of [(c:any)=>c.candidateSha='0'.repeat(40),(c:any)=>c.observations[0].actorIndex=4,(c:any)=>c.observations[0].checks.pop(),
   (c:any)=>c.observations[0].failures.busy=1,(c:any)=>delete c.observations[0].failures.pageErrors,(c:any)=>c.complete=false,
   (c:any)=>c.observations[0].checks[0].observedCount=0,(c:any)=>c.observations[0].fixtureIdentityObserved=false]){
   const value=capture(plan);edit(value);expect(()=>validateNavigationCapture(value,plan,expected)).toThrow();
  }
 });
 it('requires actual started and usable observations within steady 500-user traffic',()=>{
  const plan=validateNavigationScenarioPlan(readPlan());
  for(const edit of [(c:any)=>c.observations[0].startedWith.active=499,(c:any)=>c.observations[0].usableWith.inSteadyWindow=false,
   (c:any)=>delete c.observations[0].usableWith,(c:any)=>c.observations[0].usableWith.verified=true]){
   const value=capture(plan,'loaded');edit(value);expect(()=>validateNavigationCapture(value,plan,{...expected,phase:'loaded'})).toThrow();
  }
 });
});

const repo=fileURLToPath(new URL('../',import.meta.url));
const historyPins=()=>Array.from(readFileSync(new URL('../.github/ci/native-workload-navigation-source.py',import.meta.url),'utf8')
 .matchAll(/HistoryPin\('([^']+)', (\d+),\s*'([a-f0-9]{40})',\s*'([a-f0-9]{64})'\)/g),
 ([,path,size,blob,sha256])=>({path,size:Number(size),blob,sha256}));
const sourceGit=(root:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],
 {cwd:root,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},maxBuffer:2*1024*1024,timeout:2000});
const currentSource=(root:string)=>sourceGit(root,'rev-parse','HEAD').toString().trim();

describe('development navigation source identity',()=>{
 it('streams the four exact protected-history objects into the original ordered digest',()=>{
  const revision=currentSource(repo),pins=historyPins();
  expect(pins).toHaveLength(4);
  expect(pins.reduce((total,pin)=>total+pin.size,0)).toBe(73_681_717);
  const records=sourceGit(repo,'ls-tree','-r','-z','--full-tree',revision,'--',...NAVIGATION_HARNESS_ROOTS).toString().split('\0').filter(Boolean);
  const expected=records.map(row=>{
   const [metadata,path]=row.split('\t'),[mode,,blob]=metadata.split(' ');
   const pin=pins.find(member=>member.path===path);
   if(pin){
    expect({mode,blob}).toEqual({mode:'100644',blob:pin.blob});
    expect(sourceGit(repo,'cat-file','-s',blob).toString().trim()).toBe(String(pin.size));
   }
   return {path,mode,sha256:pin?.sha256??navigationSha256(sourceGit(repo,'show',revision+':'+path))};
  }).sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const actual=navigationSourceIdentity(repo,revision);
  expect(actual.files).toEqual(expected);
  expect(actual.harnessSha256).toBe(navigationSha256(JSON.stringify(expected)));
  expect(actual.scenarioSha256).toBe(navigationSha256(sourceGit(repo,'show',revision+':'+NAVIGATION_SCENARIO_FILE)));
 },15000);

 it('refuses linked, mutated, executable, and unrecognized large history while retaining older ordinary bytes',()=>{
  const root=mkdtempSync(join(tmpdir(),'navigation-fixed-history-'));
  const pin=historyPins()[0];
  const history=join(root,pin.path),backup=join(root,'history-backup');
  const commit=()=>{
   sourceGit(root,'-c','user.name=Navigation Model','-c','user.email=fixture@example.invalid','commit','-qm','source fixture');
   return currentSource(root);
  };
  try{
   sourceGit(root,'init','-q');
   mkdirSync(join(root,'scripts/performance'),{recursive:true});
   mkdirSync(join(root,'deploy/admission'),{recursive:true});
   copyFileSync(join(repo,pin.path),history);
   copyFileSync(join(repo,NAVIGATION_SCENARIO_FILE),join(root,NAVIGATION_SCENARIO_FILE));
   writeFileSync(join(root,'scripts/performance/navigation-browser-capture.ts'),'export {};\n');
   sourceGit(root,'add','--','scripts/performance','deploy/admission');
   const original=commit();
   expect(navigationSourceIdentity(root,original).files).toContainEqual({path:pin.path,mode:'100644',sha256:pin.sha256});

   renameSync(history,backup);
   symlinkSync(backup,history);
   expect(()=>navigationSourceIdentity(root,original)).toThrow('Fixed navigation history link refused');
   unlinkSync(history);
   linkSync(backup,history);
   expect(()=>navigationSourceIdentity(root,original)).toThrow('Fixed navigation history checkout metadata differs');
   unlinkSync(history);
   renameSync(backup,history);

   sourceGit(root,'update-index','--chmod=+x','--',pin.path);
   const executable=commit();
   expect(()=>navigationSourceIdentity(root,executable)).toThrow('Fixed navigation history Git metadata differs');

   const fd=openSync(history,'r+'),byte=Buffer.alloc(1);
   try{
    expect(readSync(fd,byte,0,1,0)).toBe(1);
    byte[0]^=1;
    expect(writeSync(fd,byte,0,1,0)).toBe(1);
   }finally{closeSync(fd);}
   expect(()=>navigationSourceIdentity(root,original)).toThrow('Fixed navigation history bytes differ');
   sourceGit(root,'add','--',pin.path);
   const unrecognized=commit();
   expect(()=>navigationSourceIdentity(root,unrecognized)).toThrow('Navigation harness source exceeds bounds');

   const oldBytes='{}\n';
   writeFileSync(history,oldBytes);
   sourceGit(root,'add','--',pin.path);
   const older=commit();
   expect(navigationSourceIdentity(root,older).files).toContainEqual({path:pin.path,mode:'100644',sha256:navigationSha256(oldBytes)});
  }finally{rmSync(root,{recursive:true,force:true});}
 });
});
