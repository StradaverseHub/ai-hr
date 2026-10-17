/** Fixture lifecycle contract only; broker/renderer/SQL/Linux behavior has separate owner evidence. */
import {describe,it,expect,vi} from 'vitest';
import {assertManagedReportAuthorityRefusal,type ManagedReportAuthorityProof} from '../scripts/managed-report-authority-evidence';
import {XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE} from '../lib/email-attachment';
function fixture(){
 let clock=1_000,messages=0,authority=true,artifactExists=false,row={status:'pending',reason:null as string|null};
 const events:string[]=[],request:ManagedReportAuthorityProof['request']={phase:'start',occurrenceId:'00000000-0000-4000-8000-000000000001',leaseToken:'00000000-0000-4000-8000-000000000002',inspectionProof:'OriginalProof',expectedArtifact:{sha256:'a'.repeat(64),byteLength:123,contentType:XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE}};
 const d={
  prepare:vi.fn(async():Promise<ManagedReportAuthorityProof>=>{events.push('inspect/render/fingerprint');if(artifactExists)throw new Error('EEXIST');artifactExists=true;return {request,validUntil:61_000};}),
  change:vi.fn(async(_deadline:number)=>{events.push('change');authority=false;}),
  liveLease:vi.fn(async()=>{events.push('live lease');if(row.status!=='pending')throw new Error('Lease unavailable');}),
  start:vi.fn(async(value:ManagedReportAuthorityProof['request']):Promise<unknown>=>{events.push('start');expect(value).toBe(request);expect(authority).toBe(false);return {ok:false,reason:'notEligible'};}),
  deliver:vi.fn(async():Promise<{outcome:string}>=>{events.push('whole sender');try{await d.prepare();}catch{row={status:'failed',reason:'generationFailed'};return {outcome:'failed'};}messages++;row={status:'sent',reason:null};return {outcome:'sent'};}),
  finishSkipped:vi.fn(async()=>{events.push('finish skipped');row={status:'skipped',reason:'notEligible'};}),
  outcome:vi.fn(async()=>({...row})),smtpCount:()=>messages,now:()=>clock,
 };
 return {d,events,request,set clock(value:number){clock=value;},set row(value:typeof row){row=value;},smtp(){messages++;}};
}
describe('controlled post-generation authority boundary',()=>{
 it.each(['permission','report revision','own consent'])('uses one original proof/artifact after %s changes, without re-entering delivery',async()=>{
  const f=fixture();await assertManagedReportAuthorityRefusal(f.d);
  expect(f.events).toEqual(['inspect/render/fingerprint','change','live lease','start','finish skipped']);
  expect(f.d.prepare).toHaveBeenCalledTimes(1);expect(f.d.deliver).not.toHaveBeenCalled();expect(f.d.start).toHaveBeenCalledWith(f.request);expect(await f.d.outcome()).toEqual({status:'skipped',reason:'notEligible'});
 });
 it.each(['generationFailed','unavailable','busy'])('does not turn %s into authority proof or finish skipped',async reason=>{
  const f=fixture();f.d.start.mockResolvedValue({ok:false,reason});await expect(assertManagedReportAuthorityRefusal(f.d)).rejects.toThrow();expect(f.d.finishSkipped).not.toHaveBeenCalled();
 });
 it('refuses success or malformed responses rather than discarding a start/relay',async()=>{
  for(const response of [{ok:true,phase:'start'},{ok:false,reason:'notEligible',extra:true},null]){const f=fixture();f.d.start.mockResolvedValue(response);await expect(assertManagedReportAuthorityRefusal(f.d)).rejects.toThrow();expect(f.d.finishSkipped).not.toHaveBeenCalled();}
 });
 it('does not count proof expiry before or during the actual broker call as an authority refusal',async()=>{
  const before=fixture();before.d.change.mockImplementation(async()=>{before.clock=51_000;});await expect(assertManagedReportAuthorityRefusal(before.d)).rejects.toThrow();expect(before.d.start).not.toHaveBeenCalled();
  const during=fixture();during.d.start.mockImplementation(async()=>{during.clock=61_000;return {ok:false,reason:'notEligible'};});await expect(assertManagedReportAuthorityRefusal(during.d)).rejects.toThrow();expect(during.d.finishSkipped).not.toHaveBeenCalled();
 });
 it('requires still-pending canonical state and unchanged SMTP before finishing',async()=>{
  for(const drift of ['state','smtp']){const f=fixture();f.d.start.mockImplementation(async()=>{if(drift==='state')f.row={status:'failed',reason:'generationFailed'};else f.smtp();return {ok:false,reason:'notEligible'};});await expect(assertManagedReportAuthorityRefusal(f.d)).rejects.toThrow();expect(f.d.finishSkipped).not.toHaveBeenCalled();}
 });
 it('checks acknowledged skipped/notEligible and SMTP again after the finish owner',async()=>{
  for(const drift of ['reason','smtp']){const f=fixture();f.d.finishSkipped.mockImplementation(async()=>{f.row={status:'skipped',reason:drift==='reason'?'generationFailed':'notEligible'};if(drift==='smtp')f.smtp();});await expect(assertManagedReportAuthorityRefusal(f.d)).rejects.toThrow();}
 });
});
