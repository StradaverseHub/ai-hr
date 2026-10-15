import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {overtimeBrowserTarget} from '../scripts/overtime-browser-target.mjs';
import {validateOvertimeResumeReceipts} from '../scripts/overtime-browser-resume.mjs';
const root='/fictional/worktree/',today='2026-10-16',prepared='a'.repeat(40),prior='b'.repeat(40);
function receipts(){
 const target=overtimeBrowserTarget(['--attempt=b2','--resume'],{allowResume:true});
 const fixture={root,database:target.database,namespace:target.namespace,port:3210,date:today,setupOnly:true,batch:{id:'55555555-5555-4555-8555-555555555555',status:'draft',employmentIds:['66666666-6666-4666-8666-666666666666']},tenantId:'22222222-2222-4222-8222-222222222222',foreignTenant:{id:'33333333-3333-4333-8333-333333333333',name:'Overtime16 fictional foreign tenant'},people:{HR:{userId:'44444444-4444-4444-8444-444444444444',tenantId:'22222222-2222-4222-8222-222222222222'}}};
 const browser={root,database:target.database,namespace:target.namespace,port:3210,candidate:prepared,fixtureRuns:2,fixture:structuredClone(fixture)};
 const stopped={candidate:prepared,database:target.database,port:3210,ownedServerStopped:true,stoppedAt:today+'T00:00:00.000Z'};
 return {target,fixture,browser,stopped,root,today};
}
describe('explicit OT browser resume boundary',()=>{
 it('accepts only explicitly allowed resume, preserving the same closed target and fixture-only child arguments',()=>{
  const resumed=overtimeBrowserTarget(['--attempt=b2','--resume','--held-lock-worker'],{allowResume:true,allowWorker:true});
  expect(resumed).toMatchObject({resume:true,heldLockWorker:true,database:'ai_hr_board16_ot_b2',namespace:'board16ot_b2',scratchpad:'scratchpad/board16-overtime-b2',port:'3210',childArgs:['--attempt=b2']});
  expect(overtimeBrowserTarget([])).toMatchObject({resume:false,database:'ai_hr_board16_overtime_browser'});
  for(const args of [['--resume'],['--attempt=b2','--resume'],['--held-lock-worker']])expect(()=>overtimeBrowserTarget(args)).toThrow();
  expect(()=>overtimeBrowserTarget(['--resume','--resume'],{allowResume:true})).toThrow();
 });
 it('binds an original owned stop without relabelling preparation as the new candidate',()=>{
  expect(validateOvertimeResumeReceipts(receipts())).toEqual({preparationCandidate:prepared,resumedFromCandidate:prepared,date:today});
 });
 it.each(['root','database','namespace','port','date','receiptFacts','fixtureRuns','setupOnly','tenant','hr','stopCandidate','stopDatabase','stopPort','notStopped','missingStopTime'] as const)('refuses %s receipt drift before database or server work',kind=>{
  const r=receipts();
  if(kind==='root')r.fixture.root='/another/';if(kind==='database')r.fixture.database='other';if(kind==='namespace')r.fixture.namespace='other';if(kind==='port')r.fixture.port=3191;if(kind==='date')r.fixture.date='2026-10-15';
  if(kind==='receiptFacts')r.browser.fixture.people.HR.userId='55555555-5555-4555-8555-555555555555';if(kind==='fixtureRuns')r.browser.fixtureRuns=0;if(kind==='setupOnly')r.fixture.setupOnly=false;if(kind==='tenant')r.fixture.foreignTenant.id=r.fixture.tenantId;if(kind==='hr')r.fixture.people.HR.tenantId='other';
  if(kind==='stopCandidate')r.stopped.candidate=prior;if(kind==='stopDatabase')r.stopped.database='other';if(kind==='stopPort')r.stopped.port=3191;if(kind==='notStopped')r.stopped.ownedServerStopped=false;if(kind==='missingStopTime')r.stopped.stoppedAt='';
  expect(()=>validateOvertimeResumeReceipts(r)).toThrow();
 });
 it('requires the previous separate resume receipt for a later stopped candidate and rejects path substitution',()=>{
  const r=receipts(),name='browser-resume-'+prior+'-1792108800000.json';
  const stopped={...r.stopped,candidate:prior,resumeReceipt:name,root,namespace:r.target.namespace,date:today,preparationCandidate:prepared,cleanupSucceeded:true,outcome:'stopped',exitCode:0,serverPid:4321};
  const previousResume={root,database:r.target.database,namespace:r.target.namespace,port:3210,date:today,candidate:prior,preparationCandidate:prepared,resumedFromCandidate:prepared,priorStoppedReceipt:structuredClone(r.stopped),fixtureRunsThisCandidate:0,preparationManifest:'browser-manifest.json'};
  expect(validateOvertimeResumeReceipts({...r,stopped,resumeRecords:{[name]:previousResume}})).toEqual({preparationCandidate:prepared,resumedFromCandidate:prior,date:today});
  expect(()=>validateOvertimeResumeReceipts({...r,stopped})).toThrow();
  expect(()=>validateOvertimeResumeReceipts({...r,stopped:{...stopped,resumeReceipt:'../'+name},resumeRecords:{[name]:previousResume}})).toThrow();
  expect(()=>validateOvertimeResumeReceipts({...r,stopped,resumeRecords:{[name]:{...previousResume,fixtureRunsThisCandidate:2}}})).toThrow();
 });
 it('refuses the prepareA → resumeB failure when only A has a stopped receipt, even if B process is dead',()=>{
  const r=receipts(),name='browser-resume-'+prior+'-1792108800000.json';
  const orphan={root,database:r.target.database,namespace:r.target.namespace,port:3210,date:today,candidate:prior,preparationCandidate:prepared,resumedFromCandidate:prepared,priorStoppedReceipt:structuredClone(r.stopped),fixtureRunsThisCandidate:0,preparationManifest:'browser-manifest.json'};
  expect(()=>validateOvertimeResumeReceipts({...r,resumeRecords:{[name]:orphan}})).toThrow();
 });
 it('accepts explicit failed-B cleanup as current provenance without claiming acceptance or skipping B',()=>{
  const r=receipts(),name='browser-resume-'+prior+'-1792108800000.json';
  const resume={root,database:r.target.database,namespace:r.target.namespace,port:3210,date:today,candidate:prior,preparationCandidate:prepared,resumedFromCandidate:prepared,priorStoppedReceipt:structuredClone(r.stopped),fixtureRunsThisCandidate:0,preparationManifest:'browser-manifest.json'};
  const stopped={...r.stopped,root,namespace:r.target.namespace,date:today,preparationCandidate:prepared,candidate:prior,resumeReceipt:name,serverPid:4321,cleanupSucceeded:true,outcome:'failed',exitCode:1};
  expect(validateOvertimeResumeReceipts({...r,stopped,resumeRecords:{[name]:resume}})).toEqual({preparationCandidate:prepared,resumedFromCandidate:prior,date:today});
  for(const changed of [{...stopped,cleanupSucceeded:false},{...stopped,exitCode:0},{...stopped,outcome:undefined},{...stopped,serverPid:undefined}])expect(()=>validateOvertimeResumeReceipts({...r,stopped:changed,resumeRecords:{[name]:resume}})).toThrow();
  for(const changed of [{...resume,resumedFromCandidate:'c'.repeat(40)},{...resume,priorStoppedReceipt:null},{...resume,priorStoppedReceipt:{...r.stopped,ownedServerStopped:false}},{...resume,priorStoppedReceipt:stopped,resumedFromCandidate:prior}])expect(()=>validateOvertimeResumeReceipts({...r,stopped,resumeRecords:{[name]:changed}})).toThrow();
 });
 it('separates resume from setup and keeps owned cleanup before shared-lock release',()=>{
  const source=readFileSync(new URL('../scripts/dev-browser-overtime-patterns.mjs',import.meta.url),'utf8'),start=source.indexOf('    if(target.resume) {'),end=source.indexOf('    } else {',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);const resume=source.slice(start,end);expect(resume.length).toBeGreaterThan(1000);
  expect(resume).not.toContain('CREATE DATABASE');expect(resume).not.toContain("await run(");expect(resume).not.toContain('dev-fixture-overtime-patterns');expect(resume).not.toContain("writeFileSync(path.join(out,'browser-manifest.json')");
  expect(resume).toContain("'db/migrations','packs/catalog.ts','db/schema.ts'");expect(resume).toContain('proveStoppedGroup(stopped)');expect(resume).toContain('fixtureRunsThisCandidate:0');expect(source).toContain("...(target.resume?['--resume']:[])");
  const finalStart=source.lastIndexOf('  finally {');expect(finalStart).toBeGreaterThan(end);const final=source.slice(finalStart);
  const stop=final.indexOf('await stopOwned(activeJob);await stopOwned(server)'),handles=final.indexOf('if(postgresApp)await postgresApp.end()'),publish=final.indexOf('fs.writeFileSync(temporary');
  expect(stop).toBeGreaterThan(0);expect(handles).toBeGreaterThan(stop);expect(publish).toBeGreaterThan(handles);
  expect(final).toContain("outcome:runFailed?'failed':'stopped'");expect(final).toContain('cleanupSucceeded:true');expect(final).toContain("fs.renameSync(temporary,path.join(out,'browser-stopped.json'))");
  expect(source.slice(0,finalStart)).not.toContain("writeFileSync(path.join(out,'browser-stopped.json')");
 });
});
