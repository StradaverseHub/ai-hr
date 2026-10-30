import {describe,it,expect} from 'vitest';
import {OffboardingStepCompletionHuman as Human,OffboardingStepCompletionPreparedSource as Prepared,OffboardingStepCompletionNativeReference as Native} from '../lib/assistant-actions/offboarding-step-completion-contract';
const id='00000000-0000-4000-8000-000000000001',event='00000000-0000-4000-8000-000000000002';
const human={caseId:id,caseNumber:'OFB-0001',stepKey:'resign_submit',reference:null,notes:null,confirmStepCompletion:true,acceptDerivedCaseCompletion:false};
const review={caseId:id,caseNumber:'OFB-0001',companyId:id,stepKey:'resign_submit',stepLabel:'Resignation submitted',resignationDate:'2026-10-01',lastWorkingDay:'2026-10-31',before:{done:false,caseStatus:'in_progress'},after:{done:true,caseStatus:'in_progress'},reference:null,notes:null};
describe('bounded offboarding step contract',()=>{
 it('binds human selections to the displayed native review',()=>{
  expect(Prepared.safeParse({content:human,review,reviewedDigest:'a'.repeat(64)}).success).toBe(true);
  for(const patch of [{caseId:event},{caseNumber:'OFB-0002'},{stepKey:'other'},{reference:'unreviewed'},{notes:'unreviewed'}])
   expect(Prepared.safeParse({content:human,review:{...review,...patch},reviewedDigest:'a'.repeat(64)}).success).toBe(false);
 });
 it('requires separate consent for native derived case completion',()=>{
  const completed={...review,after:{done:true,caseStatus:'completed'}};
  expect(Prepared.safeParse({content:human,review:completed,reviewedDigest:'a'.repeat(64)}).success).toBe(false);
  expect(Prepared.safeParse({content:{...human,acceptDerivedCaseCompletion:true},review:completed,reviewedDigest:'a'.repeat(64)}).success).toBe(true);
 });
 it.each(['outcome','employmentId','effectiveDate','doneAt','delegatedBy','actorUserId','companyId','grant'])('refuses model-supplied %s',key=>{
  expect(Human.safeParse({...human,[key]:'untrusted'}).success).toBe(false);
 });
 it('excludes outcome controls, absent consent and oversized native fields',()=>{
  for(const patch of [{stepKey:'resign_outcome'},{confirmStepCompletion:false},{reference:'x'.repeat(101)},{notes:'x'.repeat(2001)}])expect(Human.safeParse({...human,...patch}).success).toBe(false);
 });
 it('requires distinct native event references for derived completion',()=>{
  const reference={caseId:id,stepKey:'resign_submit',status:'in_progress',stepEventId:event,completionEventId:null};
  expect(Native.safeParse(reference).success).toBe(true);
  expect(Native.safeParse({...reference,status:'completed'}).success).toBe(false);
  expect(Native.safeParse({...reference,status:'completed',completionEventId:event}).success).toBe(false);
  expect(Native.safeParse({...reference,status:'completed',completionEventId:id}).success).toBe(true);
 });
});
