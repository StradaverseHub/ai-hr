import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {reportAcceptanceMode} from '../scripts/managed-report-acceptance-model';
import {RESIDUAL_PREDECESSOR,RESIDUAL_SOURCE,RESIDUAL_DATE,RESIDUAL_PINNED_FILES,residualPredecessorManifest,assertResidualFailure,residualCaseInventory,runManagedReportResidualCases} from '../scripts/managed-report-residual';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const cases=[{kind:'oversized',reportId:id(1),scheduleId:id(2)},{kind:'consent',reportId:id(3),scheduleId:id(4)}];
const manifest=()=>({version:1,runId:RESIDUAL_PREDECESSOR,candidateSha:RESIDUAL_SOURCE,date:RESIDUAL_DATE,files:{...RESIDUAL_PINNED_FILES}});
const failure=()=>({status:'FAILED',stage:'budget20',error:{name:'Error',messageSha256:'17a2d39b142d9066bc35e170f73f087b09842b83e132569c7d3853c6ab52347b',messageBytesHashed:48,truncated:false}});
describe('closed residual acceptance contract',()=>{
 it('accepts one closed mode, never arbitrary arguments',()=>{expect(reportAcceptanceMode(['verify-residual'])).toBe('verify-residual');for(const args of [[],['residual'],['verify-residual','--resume']])expect(()=>reportAcceptanceMode(args)).toThrow();});
 it('binds the exact predecessor/source/date and pinned failure/configuration/memory bytes',()=>{
  expect(residualPredecessorManifest.parse(manifest())).toEqual(manifest());
  for(const key of ['runId','candidateSha','date'] as const)expect(()=>residualPredecessorManifest.parse({...manifest(),[key]:'foreign'})).toThrow();
  for(const name of Object.keys(RESIDUAL_PINNED_FILES))expect(()=>residualPredecessorManifest.parse({...manifest(),files:{...manifest().files,[name]:'a'.repeat(64)}})).toThrow();
 });
 it('rejects success evidence, unknown frontier, altered fingerprint and path escapes',()=>{
  expect(()=>assertResidualFailure(failure())).not.toThrow();
  for(const value of [{...failure(),status:'VERIFIED'},{...failure(),stage:'oversized'},{...failure(),error:{...failure().error,messageBytesHashed:47}},{...failure(),error:{...failure().error,messageSha256:'a'.repeat(64)}}])expect(()=>assertResidualFailure(value)).toThrow();
  for(const name of ['verification.json','PASS','../escape','..'])expect(()=>residualPredecessorManifest.parse({...manifest(),files:{...manifest().files,[name]:'a'.repeat(64)}})).toThrow();
 });
 it('admits exactly two fresh distinct case identities in order',()=>{
  expect(()=>residualCaseInventory.parse(cases)).not.toThrow();
  for(const value of [cases.slice(0,1),[...cases,{kind:'extra',reportId:id(5),scheduleId:id(6)}],[cases[1],cases[0]],[cases[0],{...cases[1],reportId:id(1)}]])expect(()=>residualCaseInventory.parse(value)).toThrow();
 });
 function course(){const events:string[]=[];return {events,d:{cases,oversized:vi.fn(async()=>{events.push('oversized');return {reason:'attachmentTooLarge'};}),consent:vi.fn(async()=>{events.push('consent');return {reason:'notEligible'};}),memory:vi.fn(async()=>{events.push('memory');return {oom:0};}),checkpoint:vi.fn(async(name:string)=>{events.push('checkpoint '+name);}),cleanup:vi.fn(async()=>{events.push('cleanup');})}};}
 it('persists each new check immediately and cleans before a residual result can return',async()=>{const f=course();const receipt=await runManagedReportResidualCases(f.d);expect(f.events).toEqual(['oversized','checkpoint oversized','consent','checkpoint consent','memory','checkpoint memory','cleanup']);expect(receipt.kind).toContain('not a full verification');expect(Object.keys(receipt.checks)).toEqual(['oversized','consent','memory']);});
 it('retains the first checkpoint and cleans if consent fails; no memory or final receipt',async()=>{const f=course();f.d.consent.mockRejectedValue(new Error('human deadline'));await expect(runManagedReportResidualCases(f.d)).rejects.toThrow('human deadline');expect(f.events).toEqual(['oversized','checkpoint oversized','cleanup']);expect(f.d.memory).not.toHaveBeenCalled();});
 it('does not run consent after oversized refusal fails, and cleans',async()=>{const f=course();f.d.oversized.mockRejectedValue(new Error('generationFailed'));await expect(runManagedReportResidualCases(f.d)).rejects.toThrow('generationFailed');expect(f.events).toEqual(['cleanup']);expect(f.d.consent).not.toHaveBeenCalled();expect(f.d.checkpoint).not.toHaveBeenCalled();});
 it('refuses final receipt if checkpoint or canonical cleanup fails',async()=>{for(const step of ['checkpoint','cleanup'] as const){const f=course();f.d[step].mockRejectedValue(new Error(step));await expect(runManagedReportResidualCases(f.d)).rejects.toThrow(step);expect(f.d.cleanup).toHaveBeenCalledTimes(1);}});
 it('connects the real residual branch to canonical owned cleanup and separate output, actual ticks before residual cases and no Family inserts',()=>{
  const source=readFileSync(new URL('../scripts/dev-managed-report-acceptance.ts',import.meta.url),'utf8'),start=source.indexOf(" if(mode==='verify-residual'){"),end=source.indexOf(" const human=reportAcceptanceHumanReady.parse(await privateJson(out+'/human-ready.json')),configured=",start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start+1000);const branch=source.slice(start,end);
  expect(branch).toContain('await humanReadback()');expect(branch).toContain('familyBefore.length===1000');expect(branch).toContain('runManagedReportResidualCases');expect(branch).toContain('checkpoint:async');expect(branch).toContain('},cleanup,');expect(branch).toContain("path:out+'/residual-verification.json'");expect(branch).toContain('await predecessorFiles()');
  expect(branch).not.toContain('addDependent');const actualTicks=branch.indexOf('await runManagedReportActualTicks({'),residualCases=branch.indexOf("for(const kind of ['oversized','consent'] as const)");expect(actualTicks).toBeGreaterThan(0);expect(residualCases).toBeGreaterThan(actualTicks);expect(branch.slice(actualTicks,residualCases)).toContain("[SCHEDULE,'--activate',marker.webUnit,inventoryBefore!]");expect(branch.slice(actualTicks,residualCases)).toContain("['start','cron.service']");expect(branch.slice(actualTicks,residualCases)).toContain("[SCHEDULE,'--rollback',scheduleInstallation]");expect(branch).not.toContain("path:out+'/verification.json'");expect(branch).not.toMatch(/update\s+custom_report_(?:schedule|occurrence)/i);
 });
 it('runs the actual installed isolation probe in the owned mode before status and schedule writes, then binds its private receipt',()=>{
  const source=readFileSync(new URL('../scripts/dev-managed-report-acceptance.ts',import.meta.url),'utf8'),start=source.indexOf(" if(mode==='verify-residual'){"),end=source.indexOf(" const human=reportAcceptanceHumanReady.parse(await privateJson(out+'/human-ready.json')),configured=",start);
  expect(start).toBeGreaterThan(0);expect(end-start).toBeGreaterThan(1000);const branch=source.slice(start,end);
  const managed=branch.indexOf('managedUsed=true;'),probe=branch.indexOf("await run('/usr/bin/python3',['-I','/usr/local/lib/aihr-identity-email/verify-internal-report-isolation.py','--web-unit',marker.webUnit],60_000)"),receipt=branch.indexOf("await fs.writeFile(out+'/residual-isolation.json'"),status=branch.indexOf("await delivery({op:'status'})"),schedule=branch.indexOf('await saveEmployeeMasterSchedule(');
  expect(managed).toBeGreaterThan(0);expect(probe).toBeGreaterThan(managed);expect(receipt).toBeGreaterThan(probe);expect(status).toBeGreaterThan(receipt);expect(schedule).toBeGreaterThan(status);
  expect(branch.slice(probe,receipt)).toContain("status:'VERIFIED',outputSha256:hash(isolationOutput)");expect(branch.slice(receipt,status)).toContain("{mode:0o600,flag:'wx'}");expect(branch.slice(receipt,status)).toContain('isolationReceiptSha256=hash(isolationBytes)');expect(branch).toContain('runId:marker.runId,isolationReceiptSha256,predecessorObservation:');
 });
});
