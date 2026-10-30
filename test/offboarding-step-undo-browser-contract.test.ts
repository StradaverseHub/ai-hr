import {describe,it,expect} from 'vitest';
import {OffboardingStepUndoPacket,parseOffboardingStepUndoResult} from '../lib/assistant-actions/offboarding-step-undo-browser-contract';
import {OffboardingStepUndo as C} from '../lib/assistant-actions/offboarding-step-undo-contract';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const packet=OffboardingStepUndoPacket.parse({action:C.action,operation:'confirm',confirmation:{action:C.action,contractVersion:1,actionId:id,reviewedDigest:'a'.repeat(64)}});
describe('offboarding browser transport correspondence',()=>{
 it('refuses operation confusion and substituted review identities',()=>{
  const receipt={action:C.action,contractVersion:1,actionId:id,state:'completed',receipt:{caseId:id,stepKey:'resign_submit',status:'in_progress',stepEventId:other,reopeningEventId:null}};
  expect(parseOffboardingStepUndoResult(packet,{kind:'completed',receipt})).toEqual({kind:'completed',receipt});
  expect(()=>parseOffboardingStepUndoResult(packet,{kind:'completed',receipt:{...receipt,actionId:other}})).toThrow();
  expect(()=>parseOffboardingStepUndoResult(packet,{kind:'offboarding_step_undo_review_index',reviews:[]})).toThrow();
 });
 it.each(['actor','session','scope','companyId','sourceDigest','delegate','eventId'])('rejects posted transport authority %s',key=>{
  expect(OffboardingStepUndoPacket.safeParse({...packet,[key]:id}).success).toBe(false);
 });
 it('rejects outcome action and arbitrary API operation',()=>{
  expect(OffboardingStepUndoPacket.safeParse({action:C.action,operation:'set_outcome',outcome:'accepted'}).success).toBe(false);
  expect(OffboardingStepUndoPacket.safeParse({action:'lifecycle.offboarding.outcome',operation:'list'}).success).toBe(false);
 });
});
