import {describe,it,expect} from 'vitest';
import {OffboardingCaseCancelHuman as Human,OffboardingCaseCancelPrepared as Prepared,OffboardingCaseCancelNativeReference as Native} from '../lib/assistant-actions/offboarding-case-cancel-contract';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const content={caseId:id,caseNumber:'OFB-0001',reason:'Case opened in error',confirmCaseCancellation:true};
const review={caseId:id,caseNumber:'OFB-0001',companyId:id,resignationDate:'2026-10-01',lastWorkingDay:null,before:{status:'in_progress',cancelReason:null},after:{status:'cancelled',cancelReason:content.reason}};
describe('bounded offboarding cancellation contract',()=>{
 it('requires a nonblank bounded human reason and explicit case attestation',()=>{expect(Human.parse({...content,reason:'  Correction  '}).reason).toBe('Correction');for(const patch of [{reason:' '},{reason:'x'.repeat(501)},{confirmCaseCancellation:false}])expect(Human.safeParse({...content,...patch}).success).toBe(false);});
 it('binds the exact case number, identity and reviewed cancellation reason',()=>{expect(Prepared.safeParse({content,review,reviewedDigest:'a'.repeat(64)}).success).toBe(true);for(const patch of [{caseId:other},{caseNumber:'OFB-0002'},{after:{...review.after,cancelReason:'Different decision'}}])expect(Prepared.safeParse({content,review:{...review,...patch},reviewedDigest:'a'.repeat(64)}).success).toBe(false);});
 it.each(['actor','companyId','personId','employmentId','effectiveDate','cancelReturn','outcome','delegate'])('refuses posted authority/composite effect %s',key=>{expect(Human.safeParse({...content,[key]:id}).success).toBe(false);});
 it('refuses completed/cancelled source variants and an unchanged-event pseudo-receipt',()=>{for(const status of ['completed','cancelled'])expect(Prepared.safeParse({content,review:{...review,before:{...review.before,status}},reviewedDigest:'a'.repeat(64)}).success).toBe(false);expect(Native.safeParse({caseId:id,status:'cancelled',eventId:null}).success).toBe(false);expect(Native.safeParse({caseId:id,status:'in_progress',eventId:other}).success).toBe(false);});
});
