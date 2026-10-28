import {describe,expect,it,vi,expectTypeOf} from 'vitest';
import {assertAgentActionTier,assertHumanReviewedActionTier} from '../lib/ai/agent-action-tier-guard';
import {assertAgentTierPolicy,NEVER_AUTOMATIC_CATEGORIES,type AgentActionPolicy} from '../lib/ai/agent-action-tiers';
import {AGENT_ACTION_TIER_CEILING,AGENT_ACTION_CATEGORY} from '../lib/ai/agent-capability-inventory';

describe('runtime action tier enforcement (R17)',()=>{
 it('refuses unknown actions, handoffs, and every currently registered action in an Automatic executor',()=>{
  expect(()=>assertAgentActionTier('unknown','confirm')).toThrow('tier unavailable');
  for(const id of Object.keys(AGENT_ACTION_TIER_CEILING))expect(()=>assertAgentActionTier(id,'automatic'),id).toThrow();
  expect(()=>assertAgentActionTier('employees.import','confirm')).toThrow();
 });
 it('refuses Confirm execution of Approve entries but preserves human approval and stricter review',()=>{
  expect(()=>assertAgentActionTier('payroll.close','confirm')).toThrow();
  expect(()=>assertAgentActionTier('payroll.close','approve')).not.toThrow();
  expect(()=>assertAgentActionTier('leave.apply','confirm')).not.toThrow();
  expect(()=>assertAgentActionTier('leave.apply','approve')).not.toThrow();
 });
 it('refuses fabricated Automatic policies in every never-Automatic category, at runtime and by type',()=>{
  for(const category of NEVER_AUTOMATIC_CATEGORIES){
   expect(()=>assertAgentTierPolicy({category,tier:'automatic'} as unknown as AgentActionPolicy,'automatic')).toThrow();
   expect(()=>assertAgentTierPolicy({category,tier:'automatic'} as unknown as AgentActionPolicy,'confirm')).toThrow();
  }
  expectTypeOf<{category:'payroll';tier:'automatic'}>().not.toExtend<AgentActionPolicy>();
  for(const id of Object.keys(AGENT_ACTION_CATEGORY) as (keyof typeof AGENT_ACTION_CATEGORY)[]){
   if((NEVER_AUTOMATIC_CATEGORIES as readonly string[]).includes(AGENT_ACTION_CATEGORY[id]))expect(AGENT_ACTION_TIER_CEILING[id]).not.toBe('automatic');
  }
 });
 it('allows only explicitly classified read/reminder/chaser Automatic policies and rejects malformed tiers',()=>{
  for(const category of ['read','reminder','chaser'] as const)expect(()=>assertAgentTierPolicy({category,tier:'automatic'},'automatic')).not.toThrow();
  expect(()=>assertAgentTierPolicy({category:'own_work',tier:'automatic'} as unknown as AgentActionPolicy,'automatic')).toThrow();
  expect(()=>assertAgentTierPolicy({category:'read',tier:'bogus'} as unknown as AgentActionPolicy,'automatic')).toThrow();
 });
 it('refuses a no-login scheduled actor before the human command service can run',()=>{
  expect(()=>assertHumanReviewedActionTier({},'leave.apply','confirm')).toThrow();
  expect(()=>assertHumanReviewedActionTier({userId:'human'},'approvals.leave.decide','approve')).not.toThrow();
 });
});

// Exercise the real generic prepare/confirm boundaries: no fixture database or effect can be touched.
const db=vi.hoisted(()=>({withTenant:vi.fn()}));
vi.mock('../db/client',()=>db);
import {createGenericOwnReviewStore,type GenericOwnReviewSpec} from '../core/assistant-actions/generic-own-review-store';
import type {SessionContext} from '../db/client';

describe('prepare and confirm service boundary refusal',()=>{
 it('checks the ceiling on both commands before any subject read, transaction or effect',async()=>{
  const spec={action:'payroll.close'} as GenericOwnReviewSpec<{employmentId:string},unknown,unknown,unknown,unknown,unknown,unknown>;
  const store=createGenericOwnReviewStore(spec),ctx={tenantId:'tenant',userId:'human'} as SessionContext;
  await expect(store.prepare(ctx,{})).rejects.toThrow('tier unavailable');
  await expect(store.confirm(ctx,{actionId:'unused',reviewedDigest:'unused'})).rejects.toThrow('tier unavailable');
  expect(db.withTenant).not.toHaveBeenCalled();
 });
});
