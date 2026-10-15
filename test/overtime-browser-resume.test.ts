import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {overtimeBrowserTarget} from '../scripts/overtime-browser-target.mjs';
import {validateOvertimeResumeReceipts} from '../scripts/overtime-browser-resume.mjs';
const root='/fictional/worktree/',today='2026-10-16',prepared='a'.repeat(40),prior='b'.repeat(40);
function receipts(){
 const target=overtimeBrowserTarget(['--attempt=b2','--resume'],{allowResume:true});
 const fixture={root,database:target.database,namespace:target.namespace,port:3210,date:today,setupOnly:true,tenantId:'22222222-2222-4222-8222-222222222222',foreignTenant:{id:'33333333-3333-4333-8333-333333333333',name:'Overtime16 fictional foreign tenant'},people:{HR:{userId:'44444444-4444-4444-8444-444444444444',tenantId:'22222222-2222-4222-8222-222222222222'}}};
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
  const stopped={...r.stopped,candidate:prior,resumeReceipt:name,root,namespace:r.target.namespace,date:today,preparationCandidate:prepared};
  const previousResume={root,database:r.target.database,namespace:r.target.namespace,port:3210,date:today,candidate:prior,preparationCandidate:prepared,resumedFromCandidate:prepared,fixtureRunsThisCandidate:0,preparationManifest:'browser-manifest.json'};
  expect(validateOvertimeResumeReceipts({...r,stopped,previousResume})).toEqual({preparationCandidate:prepared,resumedFromCandidate:prior,date:today});
  expect(()=>validateOvertimeResumeReceipts({...r,stopped})).toThrow();
  expect(()=>validateOvertimeResumeReceipts({...r,stopped:{...stopped,resumeReceipt:'../'+name},previousResume})).toThrow();
  expect(()=>validateOvertimeResumeReceipts({...r,stopped,previousResume:{...previousResume,fixtureRunsThisCandidate:2}})).toThrow();
 });
 it('separates resume from setup and keeps owned cleanup before shared-lock release',()=>{
  const source=readFileSync(new URL('../scripts/dev-browser-overtime-patterns.mjs',import.meta.url),'utf8'),start=source.indexOf('    if(target.resume) {'),end=source.indexOf('    } else {',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);const resume=source.slice(start,end);expect(resume.length).toBeGreaterThan(1000);
  expect(resume).not.toContain('CREATE DATABASE');expect(resume).not.toContain("await run(");expect(resume).not.toContain('dev-fixture-overtime-patterns');expect(resume).not.toContain("writeFileSync(path.join(out,'browser-manifest.json')");
  expect(resume).toContain("'db/migrations','packs/catalog.ts','db/schema.ts'");expect(resume).toContain('proveStoppedGroup()');expect(resume).toContain('fixtureRunsThisCandidate:0');expect(source).toContain("...(target.resume?['--resume']:[])");
  expect(source).toContain('await stopOwned(activeJob);await stopOwned(server)');expect(source).toContain('if(postgresApp)await postgresApp.end()');
 });
});
