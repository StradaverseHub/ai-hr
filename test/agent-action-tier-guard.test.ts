import {describe,expect,it,vi,expectTypeOf} from 'vitest';
import {withAgentActionGuard} from '../core/assistant-actions/agent-action-guard';
import {assertAgentActionTier,assertHumanReviewedActionTier} from '../lib/ai/agent-action-tier-guard';
import {assertAgentTierPolicy,NEVER_AUTOMATIC_CATEGORIES,type AgentActionPolicy} from '../lib/ai/agent-action-tiers';
import {AGENT_ACTION_TIER_CEILING,AGENT_ACTION_CATEGORY} from '../lib/ai/agent-capability-inventory';

describe('runtime action tier enforcement (R17)',()=>{
 it('refuses unknown actions and handoffs, admitting only explicitly Automatic registry entries',()=>{
  expect(()=>assertAgentActionTier('unknown','confirm')).toThrow('tier unavailable');
  // Independent approved catalogue: a future Automatic entry needs its own reviewed expectation.
  expect(Object.keys(AGENT_ACTION_TIER_CEILING).filter(id=>AGENT_ACTION_TIER_CEILING[id as keyof typeof AGENT_ACTION_TIER_CEILING]==='automatic').sort()).toEqual(['approvals.attendance.chase','approvals.claim.chase','approvals.toil.chase','attendance.missing_clock.remind','employees.passport_expiry.remind','employees.review_overdue.remind','lifecycle.step.chase']);
  for(const id of Object.keys(AGENT_ACTION_TIER_CEILING) as (keyof typeof AGENT_ACTION_TIER_CEILING)[]){
   if(AGENT_ACTION_TIER_CEILING[id]==='automatic'){
    expect(['read','reminder','chaser']).toContain(AGENT_ACTION_CATEGORY[id]);
    expect(()=>assertAgentActionTier(id,'automatic'),id).not.toThrow();
   }else expect(()=>assertAgentActionTier(id,'automatic'),id).toThrow();
  }
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
import {createGenericAssignedReviewStore,type GenericAssignedReviewSpec} from '../core/assistant-actions/generic-assigned-review-store';

describe('prepare and confirm service boundary refusal',()=>{
 it('checks the ceiling on both commands before any subject read, transaction or effect',async()=>{
  const spec={action:'payroll.close'} as GenericOwnReviewSpec<{employmentId:string},unknown,unknown,unknown,unknown,unknown,unknown>;
  const store=createGenericOwnReviewStore(spec),ctx={tenantId:'tenant',userId:'human'} as SessionContext;
  await expect(store.prepare(ctx,{})).rejects.toThrow('tier unavailable');
  await expect(store.confirm(ctx,{actionId:'unused',reviewedDigest:'unused'})).rejects.toThrow('tier unavailable');
  expect(db.withTenant).not.toHaveBeenCalled();
 });
});

// Current canonical includes assigned approver decisions and HR-admin prepared actions.
describe('merged assigned-review tier boundaries',()=>{
 it.each(['employees.import','approvals.claim.decide','leave.adjustment.apply'])('refuses %s before assigned source or transaction access',async action=>{
  const spec={action} as unknown as GenericAssignedReviewSpec<{employmentId:string;subjectId:string},unknown,unknown,unknown,unknown,unknown,unknown>;
  const store=createGenericAssignedReviewStore(spec);
  const ctx={tenantId:'tenant',...(action==='employees.import'?{userId:'human'}:{})} as SessionContext;
  await expect(store.prepare(ctx,{})).rejects.toThrow('tier unavailable');
  await expect(store.confirm(ctx,{actionId:'unused',reviewedDigest:'unused'})).rejects.toThrow('tier unavailable');
  expect(db.withTenant).not.toHaveBeenCalled();
 });
});

describe('Automatic reminders have no human review adapter',()=>{
 it.each(['approvals.claim.chase','approvals.attendance.chase','approvals.toil.chase','employees.review_overdue.remind','attendance.missing_clock.remind','employees.passport_expiry.remind','lifecycle.step.chase'] as const)('refuses %s before transaction/native authority',async action=>{
  const tx={} as Parameters<typeof withAgentActionGuard>[0],ctx={tenantId:'tenant',userId:'human'} as SessionContext;
  await expect(withAgentActionGuard(tx,ctx,action)).rejects.toThrow('no human review adapter');
  expect(db.withTenant).not.toHaveBeenCalled();
 });
});
