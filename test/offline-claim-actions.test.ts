/** Action-level wiring of the two offline attendance screens, with the services replaced: the HR review resolve action
 * passes the claim, decision, chosen instant and the trimmed reason to resolveOfflineClaim and turns every typed refusal
 * into a plain-words key; the settings action converts minutes to seconds inside 60..86400 before the service is
 * called. The services themselves are covered with the database by mobile-offline-claim-review and
 * mobile-offline-settings. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>{
 class OfflineClaimReviewError extends Error{constructor(readonly reason:string){super('Offline claim review unavailable');}}
 class OfflineClockingSettingsError extends Error{constructor(readonly reason:string){super('Offline clocking settings unavailable');}}
 class AttendancePayrollClosedError extends Error{}
 class ClockDataChangedError extends Error{}
 class AttendanceCorrectionPendingError extends Error{}
 class AttendanceCorrectionFutureDateError extends Error{}
 class AttendanceWorkflowError extends Error{}
 return {session:{tenantId:'tenant',userId:'hr'},resolve:vi.fn(),setPolicy:vi.fn(),revalidate:vi.fn(),
  OfflineClaimReviewError,OfflineClockingSettingsError,AttendancePayrollClosedError,ClockDataChangedError,AttendanceCorrectionPendingError,AttendanceCorrectionFutureDateError,AttendanceWorkflowError};
});
vi.mock('next/cache',()=>({revalidatePath:m.revalidate}));
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>({s:m.session,scopeIds:['company']})}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>m.session}));
vi.mock('../packs/attendance/mobile-offline-claim-review',()=>({resolveOfflineClaim:m.resolve,OfflineClaimReviewError:m.OfflineClaimReviewError}));
vi.mock('../packs/attendance/service',()=>({setOfflineClockingPolicy:m.setPolicy,OfflineClockingSettingsError:m.OfflineClockingSettingsError,
 AttendancePayrollClosedError:m.AttendancePayrollClosedError,ClockDataChangedError:m.ClockDataChangedError,AttendanceCorrectionPendingError:m.AttendanceCorrectionPendingError,
 AttendanceCorrectionFutureDateError:m.AttendanceCorrectionFutureDateError,AttendanceWorkflowError:m.AttendanceWorkflowError}));
import {resolveOfflineClaimAction} from '../app/(app)/attendance/application-history/offline-actions';
import {saveOfflineClockingAction} from '../app/(app)/admin/attendance-policy/offline-clocking-actions';

const CLAIM='0b6a3f3e-8d0e-4a51-9b7e-3c1f0c6f2a11',COMPANY='5d2c1b0a-7e6f-4a3b-8c9d-0e1f2a3b4c5d';
const form=(fields:Record<string,string>)=>{const data=new FormData();for(const [k,v] of Object.entries(fields))data.set(k,v);return data;};
beforeEach(()=>{vi.clearAllMocks();m.resolve.mockResolvedValue({claimId:CLAIM,status:'rejected'});m.setPolicy.mockResolvedValue({id:'row'});});

describe('resolveOfflineClaimAction',()=>{
 it('rejects through the service with the trimmed reason and no instant',async()=>{
  expect(await resolveOfflineClaimAction(null,form({claimId:CLAIM,decision:'rejected',effectiveAt:'1700000000000',reason:'  Employee was on leave  '}))).toEqual({ok:true,claimId:CLAIM,status:'rejected'});
  expect(m.resolve).toHaveBeenCalledTimes(1);
  expect(m.resolve).toHaveBeenCalledWith(m.session,{claimId:CLAIM,decision:'rejected',reason:'Employee was on leave'});
  expect(m.revalidate).toHaveBeenCalledWith('/attendance/application-history');
 });
 it('accepts through the service at the chosen whole instant with the reason, and returns the derived state',async()=>{
  m.resolve.mockResolvedValue({claimId:CLAIM,status:'pending'});
  const at=Math.floor(Date.now()/60000)*60000;
  expect(await resolveOfflineClaimAction(null,form({claimId:CLAIM,decision:'accepted',effectiveAt:String(at),reason:'Gate log confirms'}))).toEqual({ok:true,claimId:CLAIM,status:'pending'});
  expect(m.resolve).toHaveBeenCalledWith(m.session,{claimId:CLAIM,decision:'accepted',effectiveAt:at,reason:'Gate log confirms'});
 });
 it('refuses a missing reason, a missing time and an unknown decision without calling the service',async()=>{
  expect(await resolveOfflineClaimAction(null,form({claimId:CLAIM,decision:'rejected',reason:'   '}))).toEqual({ok:false,error:'reasonRequired'});
  expect(await resolveOfflineClaimAction(null,form({claimId:CLAIM,decision:'accepted',reason:'Seen'}))).toEqual({ok:false,error:'timeRequired'});
  expect(await resolveOfflineClaimAction(null,form({claimId:CLAIM,decision:'accepted',effectiveAt:'soon',reason:'Seen'}))).toEqual({ok:false,error:'timeRequired'});
  expect(await resolveOfflineClaimAction(null,form({claimId:CLAIM,decision:'approved',reason:'Seen'}))).toEqual({ok:false,error:'failed'});
  expect(m.resolve).not.toHaveBeenCalled();expect(m.revalidate).not.toHaveBeenCalled();
 });
 it('names every refusal in plain words and never passes driver text through',async()=>{
  const cases:[unknown,string][]=[[new m.AttendancePayrollClosedError('closed'),'payrollClosed'],[new m.ClockDataChangedError('changed'),'dayChanged'],
   [new m.AttendanceCorrectionPendingError('pending'),'correctionPending'],[new m.AttendanceCorrectionFutureDateError('future'),'futureDate'],[new m.AttendanceWorkflowError('stale'),'workflow'],
   [new m.OfflineClaimReviewError('photo_review_required'),'photoReview'],[new m.OfflineClaimReviewError('effective_time_invalid'),'timeInvalid'],
   [new m.OfflineClaimReviewError('self_resolution'),'self'],[new m.OfflineClaimReviewError('resolution_conflict'),'conflict'],[new m.OfflineClaimReviewError('not_resolvable'),'notResolvable'],
   [new m.OfflineClaimReviewError('employment_inactive'),'employmentInactive'],[new m.OfflineClaimReviewError('forbidden'),'forbidden'],[new m.OfflineClaimReviewError('not_found'),'notFound'],
   [new m.OfflineClaimReviewError('unavailable'),'failed'],[new Error('duplicate key value violates unique constraint "secret_idx"'),'failed']];
  for(const [error,key] of cases){
   m.resolve.mockRejectedValueOnce(error);
   expect(await resolveOfflineClaimAction(null,form({claimId:CLAIM,decision:'rejected',reason:'Checked'}))).toEqual({ok:false,error:key});
  }
  expect(m.resolve).toHaveBeenCalledTimes(cases.length);
 });
});

describe('saveOfflineClockingAction',()=>{
 it('stores minutes as seconds and passes the switch and company to the service',async()=>{
  const result=await saveOfflineClockingAction(null,form({companyId:COMPANY,enabled:'on',maxProvenWindowMinutes:'15',__attendanceSaveNonce:'a'.repeat(32)}));
  expect(result).toMatchObject({ok:true,savedReceipt:'a'.repeat(32)});
  expect(m.setPolicy).toHaveBeenCalledWith(m.session,{companyId:COMPANY,enabled:true,maxProvenWindowSeconds:900});
  await saveOfflineClockingAction(null,form({companyId:COMPANY,maxProvenWindowMinutes:'1440'}));
  expect(m.setPolicy).toHaveBeenLastCalledWith(m.session,{companyId:COMPANY,enabled:false,maxProvenWindowSeconds:86400});
  await saveOfflineClockingAction(null,form({companyId:COMPANY,maxProvenWindowMinutes:'1'}));
  expect(m.setPolicy).toHaveBeenLastCalledWith(m.session,{companyId:COMPANY,enabled:false,maxProvenWindowSeconds:60});
 });
 it('refuses anything outside 1 minute to 24 hours with the validation message and no write',async()=>{
  for(const minutes of ['','0','0.5','1441','-5','abc'])
   expect(await saveOfflineClockingAction(null,form({companyId:COMPANY,enabled:'on',maxProvenWindowMinutes:minutes}))).toEqual({ok:false,error:'minutesRange'});
  expect(m.setPolicy).not.toHaveBeenCalled();
 });
 it('turns the service refusals into the card\'s plain messages',async()=>{
  for(const [reason,key] of [['forbidden','forbidden'],['unavailable','unavailable'],['invalid_input','failed']]){
   m.setPolicy.mockRejectedValueOnce(new m.OfflineClockingSettingsError(reason));
   expect(await saveOfflineClockingAction(null,form({companyId:COMPANY,maxProvenWindowMinutes:'15'}))).toEqual({ok:false,error:key});
  }
  expect(m.revalidate).not.toHaveBeenCalled();
 });
});
