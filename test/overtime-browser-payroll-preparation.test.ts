import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {overtimeBrowserTarget,validateOvertimePayrollPreparation} from '../scripts/overtime-browser-target.mjs';
import {validateOvertimeResumeReceipts} from '../scripts/overtime-browser-resume.mjs';
const employee='66666666-6666-4666-8666-666666666666',batch='55555555-5555-4555-8555-555555555555';
const prepared={batch:{id:batch,status:'draft',employmentIds:[employee]}};
const deferred={payrollPreparation:'deferred',batch:{status:'not-created',employmentIds:[employee]}};
function deferredReceipts(){
 const target=overtimeBrowserTarget(['--attempt=b3','--defer-payroll','--resume'],{allowResume:true});
 const root='/fictional/worktree/',today='2026-10-16',candidate='a'.repeat(40);
 const fixture={...structuredClone(deferred),root,database:target.database,namespace:target.namespace,port:3210,date:today,setupOnly:true,tenantId:'22222222-2222-4222-8222-222222222222',foreignTenant:{id:'33333333-3333-4333-8333-333333333333',name:'Overtime16 fictional foreign tenant'},people:{HR:{userId:'44444444-4444-4444-8444-444444444444',tenantId:'22222222-2222-4222-8222-222222222222'}}};
 const browser={root,database:target.database,namespace:target.namespace,port:3210,candidate,fixtureRuns:2,payrollPreparation:'deferred',fixture:structuredClone(fixture)};
 const stopped={candidate,root,database:target.database,namespace:target.namespace,port:3210,date:today,payrollPreparation:'deferred',ownedServerStopped:true,stoppedAt:today+'T00:00:00Z'};
 return {target,fixture,browser,stopped,root,today};
}
describe('explicit deferred Payroll preparation',()=>{
 it('requires a bounded attempt, carries only setup arguments to each child and leaves the default unchanged',()=>{
  const target=overtimeBrowserTarget(['--attempt=b3','--defer-payroll','--held-lock-worker'],{allowWorker:true});
  expect(target).toMatchObject({database:'ai_hr_board16_ot_b3',namespace:'board16ot_b3',scratchpad:'scratchpad/board16-overtime-b3',port:'3210',deferPayroll:true,childArgs:['--attempt=b3','--defer-payroll']});
  expect(overtimeBrowserTarget([])).toMatchObject({deferPayroll:false,childArgs:[],database:'ai_hr_board16_overtime_browser'});
  expect(overtimeBrowserTarget(['--attempt=b2'])).toMatchObject({deferPayroll:false,childArgs:['--attempt=b2']});
  for(const args of [['--defer-payroll'],['--attempt=b3','--defer-payroll','--defer-payroll'],['--attempt=b3','--payroll=deferred'],['--attempt=b3','--defer-payroll=true'],['--attempt=../b3','--defer-payroll'],['--attempt=b3','--attempt=b4','--defer-payroll'],['--attempt=b3','--defer-payroll','--resume']])expect(()=>overtimeBrowserTarget(args)).toThrow();
 });
 it('binds legacy/default versus deferred preparation and forbids invented batch IDs or empty/duplicate scopes',()=>{
  const normal=overtimeBrowserTarget(['--attempt=b2']),target=overtimeBrowserTarget(['--attempt=b3','--defer-payroll']);
  expect(()=>validateOvertimePayrollPreparation(prepared,normal)).not.toThrow();
  expect(()=>validateOvertimePayrollPreparation(deferred,target)).not.toThrow();
  expect(Object.prototype.hasOwnProperty.call(deferred.batch,'id')).toBe(false);
  expect(()=>validateOvertimePayrollPreparation(prepared,target)).toThrow();
  expect(()=>validateOvertimePayrollPreparation(deferred,normal)).toThrow();
  for(const fixture of [{...deferred,payrollPreparation:'unknown'},{...deferred,batch:{...deferred.batch,id:batch}},{...deferred,batch:{...deferred.batch,id:undefined}},{...deferred,batch:{...deferred.batch,status:'draft'}},{...deferred,batch:{...deferred.batch,employmentIds:[]}},{...deferred,batch:{...deferred.batch,employmentIds:[employee,employee]}},{...deferred,batch:{...deferred.batch,employmentIds:['fabricated']}},{...prepared,batch:{...prepared.batch,id:undefined}}])expect(()=>validateOvertimePayrollPreparation(fixture,fixture.payrollPreparation==='deferred'?target:normal)).toThrow();
 });
 it('binds resume to original mode without requiring its later business run to remain absent',()=>{
  const r=deferredReceipts();
  expect(validateOvertimeResumeReceipts(r).preparationCandidate).toBe(r.browser.candidate);
  expect(()=>validateOvertimeResumeReceipts({...r,target:{...r.target,deferPayroll:false}})).toThrow();
  expect(()=>validateOvertimeResumeReceipts({...r,browser:{...r.browser,payrollPreparation:undefined}})).toThrow();
  expect(()=>validateOvertimeResumeReceipts({...r,stopped:{...r.stopped,payrollPreparation:undefined}})).toThrow();
  const prior='b'.repeat(40),name='browser-resume-'+prior+'-1792108800000.json';
  const resume={...r.browser,candidate:prior,preparationCandidate:r.browser.candidate,resumedFromCandidate:r.stopped.candidate,priorStoppedReceipt:r.stopped,fixtureRunsThisCandidate:0,preparationManifest:'browser-manifest.json',date:r.today};
  const stopped={...r.stopped,candidate:prior,resumeReceipt:name,preparationCandidate:r.browser.candidate,serverPid:4321,cleanupSucceeded:true,outcome:'stopped',exitCode:0};
  expect(()=>validateOvertimeResumeReceipts({...r,stopped,resumeRecords:{[name]:resume}})).not.toThrow();
  expect(()=>validateOvertimeResumeReceipts({...r,stopped,resumeRecords:{[name]:{...resume,payrollPreparation:undefined}}})).toThrow();
  expect(()=>validateOvertimeResumeReceipts({...r,stopped,resumeRecords:{[name]:{...resume,priorStoppedReceipt:{...r.stopped,payrollPreparation:undefined}}}})).toThrow();
 });
 it('checks existing receipt mode before setup and skips only initial canonical createBatch in the deferred branch',()=>{
  const fixture=readFileSync(new URL('../scripts/dev-fixture-overtime-patterns.mts',import.meta.url),'utf8');
  expect(fixture.indexOf('if(previous)validateOvertimePayrollPreparation(previous,target)')).toBeLessThan(fixture.indexOf('const primary=await provisionedAdmin('));
  const start=fixture.indexOf(' if(target.deferPayroll) {'),end=fixture.indexOf(' } else {',start),branch=fixture.slice(start,end);
  expect(start).toBeGreaterThan(0);expect(branch).toContain("if(batch)throw");expect(branch).toContain("status:'not-created'");expect(branch).not.toContain('createBatch(');
  expect(fixture.slice(end)).toContain('await createBatch(hr,');expect(fixture).toContain('...payrollPreparation,batch:batchPreparation');
  const coordinator=readFileSync(new URL('../scripts/dev-browser-overtime-patterns.mjs',import.meta.url),'utf8');
  const check=coordinator.indexOf("if(fs.existsSync(path.join(out,'fixture-manifest.json')))validateOvertimePayrollPreparation");
  expect(check).toBeGreaterThan(0);expect(check).toBeLessThan(coordinator.indexOf('CREATE DATABASE'));expect(check).toBeLessThan(coordinator.indexOf("'drizzle-kit','migrate'"));
  expect(coordinator).toContain('...target.childArgs');
 });
});
