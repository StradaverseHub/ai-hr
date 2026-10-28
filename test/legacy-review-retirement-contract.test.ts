/** Authored UNRUN pure closed-envelope checks; no DB fixture or runtime claim. */
import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import * as c from '../lib/assistant-actions/module-action-review-contract';
import {OwnLeaveConfirmation,OwnLeaveRetirement,OwnLeaveRetirementRequest} from '../lib/assistant-actions/own-leave-contract';
const cases=[
 ['leave.apply',OwnLeaveConfirmation,OwnLeaveRetirement,OwnLeaveRetirementRequest],
 ['notifications.email_preferences.save',c.ModuleActionConfirmation,c.ModuleActionRetirement,c.ModuleActionRetirementRequest],
 ['ess.profile.request',c.ProfileModuleActionConfirmation,c.ProfileModuleActionRetirement,c.ProfileModuleActionRetirementRequest],
 ['claims.draft.save',c.ClaimModuleActionConfirmation,c.ClaimModuleActionRetirement,c.ClaimModuleActionRetirementRequest],
 ['claims.submit',c.ClaimSubmissionModuleActionConfirmation,c.ClaimSubmissionModuleActionRetirement,c.ClaimSubmissionModuleActionRetirementRequest],
 ['performance.review.acknowledge',c.ReviewModuleActionConfirmation,c.ReviewModuleActionRetirement,c.ReviewModuleActionRetirementRequest],
 ['performance.onehr.plan.acknowledge',c.OnehrModuleActionConfirmation,c.OnehrModuleActionRetirement,c.OnehrModuleActionRetirementRequest],
 ['system_testing.execution.save',c.TestingModuleActionConfirmation,c.TestingModuleActionRetirement,c.TestingModuleActionRetirementRequest],
] as const;
describe('closed privacy retirement and unchanged human effect confirmation',()=>{
 it.each(cases)('%s accepts digest-free retirement and the old envelope while effect confirmation still requires its digest',(action,confirmation,retirement,request)=>{const p={...(action==='leave.apply'?{}:{action}),contractVersion:1,actionId:randomUUID()},old={...p,reviewedDigest:'a'.repeat(64)};expect(retirement.safeParse(p).success).toBe(true);expect(request.safeParse(p).success).toBe(true);expect(request.safeParse(old).success).toBe(true);expect(confirmation.safeParse(p).success).toBe(false);expect(confirmation.safeParse(old).success).toBe(true);for(const extra of [{reviewedDigest:'malformed'},{employmentId:randomUUID()},{actorId:randomUUID()},{execute:true},{content:'PRIVATE'}])expect(request.safeParse({...p,...extra}).success).toBe(false);expect(retirement.safeParse(old).success).toBe(false);});
 it('keeps OwnLeave retirement action-free and forbids version/identity/kind substitution',()=>{const p={contractVersion:1,actionId:randomUUID()};expect(OwnLeaveRetirementRequest.safeParse({...p,action:'leave.apply'}).success).toBe(false);expect(OwnLeaveRetirementRequest.safeParse({...p,contractVersion:2}).success).toBe(false);expect(c.ModuleActionRetirementRequest.safeParse({...p,action:'claims.submit'}).success).toBe(false);expect(c.TestingModuleActionRetirementRequest.safeParse({...p,action:'system_testing.execution.save',personId:null}).success).toBe(false);});
});
