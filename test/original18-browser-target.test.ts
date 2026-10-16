import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {todayInKualaLumpur} from '../lib/hr-date';
import {original18BrowserTarget,original18FixtureFacts,original18FixtureFromLog,original18FixtureIdentities,original18ResumeReceiptName,validateOriginal18Resume,PERSONNEL_PREPARATION} from '../scripts/original18-browser-target.mjs';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const root='/fictional/owned-worktree/',prepared='a'.repeat(40),later='b'.repeat(40),date=todayInKualaLumpur();
type Bag={root:string;scenario:string;fixture:Record<string,unknown>;browser:Record<string,unknown>;stopped:Record<string,unknown>;resumeRecords:Record<string,Record<string,unknown>>};
function facts(scenario:string):Record<string,unknown>{
 if(scenario==='schedules')return {companyId:id(1),groups:[{id:id(2)},{id:id(3)}],shifts:[{id:id(4)},{id:id(5)}],logins:['hr','manager','fixed','flexi'].map((key,i)=>({key,id:id(10+i),...(key==='hr'?{}:{employmentId:id(20+i)})})),attendanceDate:date,memberships:[]};
 if(scenario==='holidays'){const scenarios=['A','B','C','REVIEW','EMPTY'].map((key,i)=>({key,companyId:id(1+i),...(key==='EMPTY'?{}:{employmentId:id(20+i),userId:id(10+i)})}));return {scenarios,logins:[{key:'hr',id:id(30)},{key:'scoped-hr',id:id(31)},...scenarios.filter(row=>row.userId).map(row=>({key:row.key.toLowerCase(),id:row.userId,employmentId:row.employmentId}))],allocations:[]};}
 if(scenario==='approval')return {companies:{Main:id(1),Empty:id(2),Foreign:id(3)},people:Object.fromEntries(['D','D2','A','Arjun','Daniel','HR','OtherHR','NoSuperior','ForeignHR'].map((key,i)=>[key,{userId:id(10+i),personId:id(30+i),employmentId:id(50+i),login:'approval15-fixture:'+key}]))};
 if(scenario==='inquiry')return {companies:{A:id(1),B:id(2),Hidden:id(3),Empty:id(4)},people:['hr','manager',...Array.from({length:28},(_,i)=>'employee-'+String(i).padStart(2,'0'))].map((key,i)=>({key,personId:id(30+i),employmentId:id(70+i)})),users:['hr','manager','employee-00'].map((key,i)=>({userId:id(10+i),login:'inquiry15-fixture:'+key}))};
 return {companies:{Main:id(1),Foreign:id(2)},people:Object.fromEntries(['HR','Manager','Employee','Other','Inactive','Foreign'].map((key,i)=>[key,{userId:id(10+i),personId:id(30+i),employmentId:id(50+i),login:'personnel15-fixture:'+key,employeeCode:'PR15-'+key.toUpperCase(),companyId:id(key==='Foreign'?2:1)}]))};
}
function receipts(scenario='schedules'):Bag{
 const target=original18BrowserTarget(['--scenario='+scenario,...(scenario==='personnel'?['--resume']:[])]),bound={root,scenario,database:target.database,namespace:target.namespace,port:target.port},data=facts(scenario),identities=original18FixtureIdentities(scenario,data);
 const fixture:Record<string,unknown>=scenario==='personnel'?{root,database:target.database,namespace:target.namespace,port:target.port,tenantId:'11111111-1111-1111-1111-111111111111',...data}:{...bound,tenantId:'11111111-1111-1111-1111-111111111111',date,facts:data,identities,principals:identities.actors.map((actor:{id:string;personId?:string},i:number)=>({id:actor.id,personId:actor.personId??id(200+i)}))};
 const candidate=scenario==='personnel'?PERSONNEL_PREPARATION.candidate:prepared;
 return {root,scenario,fixture,browser:{...bound,candidate,fixtureRuns:2,fixture:structuredClone(fixture)},stopped:scenario==='personnel'?{candidate,database:target.database,port:target.port,ownedServerStopped:true,stoppedAt:PERSONNEL_PREPARATION.stoppedAt}:{...bound,candidate,preparationCandidate:candidate,serverPid:4321,ownedServerStopped:true,cleanupSucceeded:true,outcome:'stopped',exitCode:0,stoppedAt:new Date().toISOString()},resumeRecords:{}};
}
function resume(r:Bag,candidate=later,stamp='1792117812536',failed=false):Bag{
 const binding=validateOriginal18Resume(r),target=original18BrowserTarget(['--scenario='+r.scenario,'--resume']),bound={root,scenario:r.scenario,database:target.database,namespace:target.namespace,port:target.port},name='browser-resume-'+candidate+'-'+stamp+'.json';
 const receipt={candidate,...binding,...bound,preparationManifest:'browser-manifest.json',priorStoppedReceipt:structuredClone(r.stopped),fixtureRunsThisCandidate:0,migrationRunsThisCandidate:0,seedRunsThisCandidate:0,resumedAt:new Date().toISOString(),applicationAcceptance:'UNVERIFIED'};
 return {...r,resumeRecords:{...r.resumeRecords,[name]:receipt},stopped:{...bound,candidate,preparationCandidate:binding.preparationCandidate,resumeReceipt:name,serverPid:5432,ownedServerStopped:true,cleanupSucceeded:true,outcome:failed?'failed':'stopped',exitCode:failed?1:0,stoppedAt:new Date().toISOString()}};
}
describe('original18 closed local browser lifecycle',()=>{
 it.each([['schedules','ai_hr_board15schedules_browser',3192,'board15schedules'],['holidays','ai_hr_board15holiday_browser',3193,'board15holidays'],['approval','ai_hr_board15_approval_browser',3195,'board15approval'],['inquiry','ai_hr_board15_inquiry_browser',3196,'board15inquiry']] as const)('binds %s to its exact allocated target and worker arguments', (scenario,database,port,namespace)=>{
  expect(original18BrowserTarget(['--scenario='+scenario])).toMatchObject({scenario,database,port,namespace,resume:false,heldLockWorker:false});expect(original18BrowserTarget(['--scenario='+scenario,'--resume','--held-lock-worker'],{allowWorker:true})).toMatchObject({resume:true,heldLockWorker:true});
 });
 it('refuses arbitrary targets, duplicate flags, direct workers and Personnel setup',()=>{
  for(const args of [[],['--scenario=other'],['--scenario=../../'],['--scenario=schedules','--scenario=approval'],['--scenario=schedules','--resume','--resume'],['--scenario=schedules','--held-lock-worker'],['--scenario=schedules','--port=3192'],['--scenario=schedules','--database=postgres'],['--scenario=personnel'],['--scenario=personnel','--seed'],['--scenario=personnel','--resume=true']])expect(()=>original18BrowserTarget(args)).toThrow();
  expect(original18BrowserTarget(['--scenario=personnel','--resume'])).toMatchObject({database:'ai_hr_board15_personnel_browser',port:3203,namespace:'board15personnelregisters',fixture:null,resumeOnly:true,scratchpad:'scratchpad/board15-personnel-registers'});
 });
 it('normalizes only reused/sweep diagnostics and refuses corrupt or ambiguous fixture logs',()=>{
  const value={...facts('schedules'),reused:false,sweep:{changed:3}},again={...value,reused:true,sweep:{changed:0}};expect(original18FixtureFacts(value)).toEqual(original18FixtureFacts(again));
  expect(original18FixtureFromLog('notice\n'+JSON.stringify(value,null,2)+'\n')).toEqual(original18FixtureFacts(value));
  expect(()=>original18FixtureFromLog('{}\n{}')).toThrow();expect(()=>original18FixtureFromLog('not JSON')).toThrow();expect(()=>original18FixtureFromLog(JSON.stringify(value)+'\ntrailing error')).toThrow();
  expect(original18FixtureFacts({...value,attendanceDate:'changed'})).not.toEqual(original18FixtureFacts(value));
 });
 it.each(['schedules','holidays','approval','inquiry'])('binds %s preparation and failed-stop chains without pretending to run setup again',scenario=>{
  const r=receipts(scenario);expect(validateOriginal18Resume(r)).toMatchObject({preparationCandidate:prepared,resumedFromCandidate:prepared});const next=resume(resume(r), 'c'.repeat(40),'1792117812537',true);expect(validateOriginal18Resume(next)).toMatchObject({preparationCandidate:prepared,resumedFromCandidate:'c'.repeat(40)});
 });
 it('refuses changed scope, identities, incomplete cleanup, setup claims, orphaned newer runs and stale chain provenance',()=>{
  for(const patch of [{root:'/elsewhere/'},{namespace:'other'},{port:3193},{database:'postgres'},{fixtureRuns:0}]){const r=receipts();Object.assign(r.browser,patch);expect(()=>validateOriginal18Resume(r)).toThrow();}
  for(const patch of [{ownedServerStopped:false},{cleanupSucceeded:false},{serverPid:undefined},{outcome:'PASS'},{exitCode:1}]){const r=receipts();Object.assign(r.stopped,patch);expect(()=>validateOriginal18Resume(r)).toThrow();}
  const r=resume(receipts()),name=String(r.stopped.resumeReceipt);for(const patch of [{fixtureRunsThisCandidate:2},{migrationRunsThisCandidate:1},{seedRunsThisCandidate:1},{preparationFixtureDigest:'0'.repeat(64)},{resumedFromCandidate:'f'.repeat(40)},{applicationAcceptance:'PASS'}])expect(()=>validateOriginal18Resume({...r,resumeRecords:{[name]:{...r.resumeRecords[name],...patch}}})).toThrow();
  expect(()=>validateOriginal18Resume({...r,stopped:receipts().stopped})).toThrow();expect(original18ResumeReceiptName('../browser-resume-'+later+'-1792117812536.json',later)).toBe(false);
  const changed=receipts();(changed.fixture.principals as {id:string}[])[0].id=id(999);changed.browser.fixture=structuredClone(changed.fixture);expect(()=>validateOriginal18Resume(changed)).toThrow();
 });
 it('allows only the reviewed exact legacy Personnel stop shape and retains it unchanged inside new provenance',()=>{
  const r=receipts('personnel'),original=structuredClone(r.stopped);expect(validateOriginal18Resume(r).preparationCandidate).toBe(PERSONNEL_PREPARATION.candidate);expect(r.stopped).not.toHaveProperty('cleanupSucceeded');const next=resume(r);expect(validateOriginal18Resume(next).resumedFromCandidate).toBe(later);expect(next.resumeRecords[String(next.stopped.resumeReceipt)].priorStoppedReceipt).toEqual(original);
  for(const patch of [{candidate:prepared},{stoppedAt:new Date().toISOString()},{root},{cleanupSucceeded:true},{ownedServerStopped:false}])expect(()=>validateOriginal18Resume({...r,stopped:{...r.stopped,...patch}})).toThrow();
 });
 it('keeps resume setup-free and cleanup before atomic stop publication/lock release, with no target resets',()=>{
  const source=readFileSync(new URL('../scripts/dev-browser-original18.mjs',import.meta.url),'utf8'),start=source.indexOf('    if(options.resume) {'),end=source.indexOf('    } else {',start);expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);const branch=source.slice(start,end);expect(branch.length).toBeGreaterThan(1500);
  for(const forbidden of ['CREATE DATABASE','await run(','drizzle-kit','db/seed.ts','scripts/dev-fixture'])expect(branch).not.toContain(forbidden);
  for(const required of ['proveStoppedGroup(stopped)','proveRoles()','proveTenants()','proveIdentities(',"'db/migrations','packs/catalog.ts','db/schema.ts'",'fixtureRunsThisCandidate:0,migrationRunsThisCandidate:0,seedRunsThisCandidate:0','PERSONNEL_PREPARATION.runnerBytes','PERSONNEL_PREPARATION.fixtureBytes'])expect(branch).toContain(required);
  const final=source.slice(source.lastIndexOf('  finally {'));expect(final.indexOf('await stopOwned(activeJob);await stopOwned(server)')).toBeLessThan(final.indexOf('if(postgresApp)await postgresApp.end()'));expect(final.indexOf('if(postgresTarget)await postgresTarget.end()')).toBeLessThan(final.indexOf("writeNew('browser-stop-'"));expect(final).toContain("fs.renameSync(temporary,path.join(out,'browser-stopped.json'))");
  expect(source).toContain('ancestors.has(pid)');expect(source).toContain('watchdog=setTimeout(requestStop,45*60*1000)');expect(source).toContain('for(const pid of [Number(raw),-Number(raw)])');expect(source).toContain('no clean-twice claim');expect(source).not.toMatch(/DROP DATABASE|TRUNCATE|kill.*lsof/);
 });
});
