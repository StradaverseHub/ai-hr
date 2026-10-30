import {describe,it,expect} from 'vitest';
import {OffboardingStepUndoHuman as Human,OffboardingStepUndoPrepared as Prepared} from '../lib/assistant-actions/offboarding-step-undo-contract';
const id='00000000-0000-4000-8000-000000000001';
const content={caseId:id,caseNumber:'OFB-0001',stepKey:'resign_submit',reason:null,confirmUndo:true,acceptCaseReopening:false};
const review={caseId:id,caseNumber:'OFB-0001',companyId:id,stepKey:'resign_submit',stepLabel:'Submission',resignationDate:'2026-10-01',lastWorkingDay:null,before:{done:true,caseStatus:'in_progress',reference:'retained',notes:'retained notes'},after:{done:false,caseStatus:'in_progress',reference:'retained',notes:'retained notes'},reopensCase:false,reason:null};
describe('bounded offboarding step undo contract',()=>{
 it('preserves optional native reason and retained step metadata',()=>{expect(Prepared.safeParse({content,review,reviewedDigest:'a'.repeat(64)}).success).toBe(true);expect(Prepared.safeParse({content,review:{...review,after:{...review.after,notes:null}},reviewedDigest:'a'.repeat(64)}).success).toBe(false);});
 it('requires separate acceptance of actual derived case reopening',()=>{const reopened={...review,before:{...review.before,caseStatus:'completed'},reopensCase:true};expect(Prepared.safeParse({content,review:reopened,reviewedDigest:'a'.repeat(64)}).success).toBe(false);expect(Prepared.safeParse({content:{...content,acceptCaseReopening:true},review:reopened,reviewedDigest:'a'.repeat(64)}).success).toBe(true);});
 it.each(['actorUserId','effectiveDate','doneAt','companyId','delegatedBy','grant'])('refuses supplied authority/date %s',key=>{expect(Human.safeParse({...content,[key]:'untrusted'}).success).toBe(false);});
 it('excludes outcome controls, absent consent and excessive reasons',()=>{for(const patch of [{stepKey:'resign_outcome'},{confirmUndo:false},{reason:'x'.repeat(501)}])expect(Human.safeParse({...content,...patch}).success).toBe(false);});
 it('binds the exact case/step/reason visible in review',()=>{for(const patch of [{caseNumber:'OFB-0002'},{stepKey:'different'},{reason:'unreviewed'}])expect(Prepared.safeParse({content,review:{...review,...patch},reviewedDigest:'a'.repeat(64)}).success).toBe(false);});
});
