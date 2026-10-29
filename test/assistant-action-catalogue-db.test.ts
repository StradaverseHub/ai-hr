/** Review R6 against the real database: the actual assistantProposalCallerTx (real app.ai_action_unpaused in a
 * savepoint, nothing mocked) and the actual reopen path (loadAiWorkspace replaying a sealed proposal exchange in
 * its read-only transaction). Fictional fixtures; no provider request. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {loadAiWorkspace} from '../core/ai-workspace';
import {grantAssistant} from '../core/assistant-grant';
import {setAiFeature} from '../core/ai-management';
import {hireEmployee} from '../core/org';
import {assistantProposalCallerTx} from '../core/assistant-action-catalogue';
import {assistantProposalCatalogue} from '../lib/ai/assistant-action-catalogue';
import {sealAssistantDisclosure} from '../lib/ai/assistant-disclosure';
import type {AssistantAnswerPlan} from '../lib/ai/assistant-answer-plan';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let base:Base,group:SessionContext;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-catalogue-disclosure-only');await resetDb();base=await seedBase();
 await setModule(base.tenantId,'assistant','active');await setModule(base.tenantId,'leave','active');
 group={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
});
afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});

/** A linked person with an Assistant grant, and one sealed proposal exchange of theirs. */
async function callerWithSealedProposal(){
 await grantAssistant(group,{appUserId:group.userId!});
 const hired=await hireEmployee(group,{person:{fullName:'Fictional Proposal Caller',primaryEmail:`${randomUUID()}@fixture.test`},
  companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,'hr_admin');await grantAssistant(group,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(base),userId,personId:hired.personId};
 const plan:AssistantAnswerPlan={version:1,mode:'propose',action:'leave.cancel',hints:{startDate:'2026-11-03'}};
 const id=randomUUID(),question='Cancel my pending leave on 3 November',answer=JSON.stringify(plan);
 const receipt=sealAssistantDisclosure({tenantId:base.tenantId,userId,exchangeId:id,question,answer},[],plan);expect(receipt).toBeTruthy();
 await owner.db.insert(schema.assistantExchange).values({id,tenantId:base.tenantId,appUserId:userId,question,answer,disclosureReceipt:receipt,stop:'end',toolCalls:[]});
 return {ctx,id,plan};
}
const reopened=async(ctx:SessionContext,id:string)=>{
 const workspace=await loadAiWorkspace(ctx,{selectedExchangeId:id,includeGovernance:false});
 expect(workspace.access).toEqual({allowed:true});
 const row=workspace.history.find(item=>item.id===id);expect(row).toBeDefined();return row!.grounded?.conversation;
};

describe('real caller facts and the real reopen path',()=>{
 it('nothing paused: the action is offered and the reopened proposal is current, not stale',async()=>{
  const {ctx,id,plan}=await callerWithSealedProposal();
  const caller=await withTenant(ctx,tx=>assistantProposalCallerTx(tx,ctx));
  expect(caller.pausedKeys).toEqual([]);expect(caller.actors).toContain('self');expect(caller.readableModules).toContain('leave');
  expect(assistantProposalCatalogue(caller)).toContain('leave.cancel');
  const conversation=await reopened(ctx,id);
  expect(conversation).toEqual({plan,facts:[]});expect(conversation).not.toHaveProperty('proposalStale');expect(conversation).not.toHaveProperty('proposalUnverified');
 });
 it('a real hr_assistant pause: nothing is offered and the reopened proposal is stale (refused, never preparable)',async()=>{
  const {ctx,id,plan}=await callerWithSealedProposal();
  await setAiFeature(group,'hr_assistant',false);
  expect(await owner.db.select().from(schema.aiControlPolicy)).toContainEqual(expect.objectContaining({tenantId:base.tenantId,kind:'feature',featureId:'hr_assistant',enabled:false}));
  const caller=await withTenant(ctx,tx=>assistantProposalCallerTx(tx,ctx));
  expect(caller.pausedKeys).toEqual(['hr_assistant']);expect(assistantProposalCatalogue(caller)).toEqual([]);
  const conversation=await reopened(ctx,id);
  expect(conversation).toEqual({plan,proposalStale:true,facts:[]});
  // Resuming makes the same sealed proposal current again: stale reflects the live control, not the record.
  await setAiFeature(group,'hr_assistant',true);
  expect(await reopened(ctx,id)).toEqual({plan,facts:[]});
 });
});
