/** ADR-0151 §7, review R16 (WP8): every agent action registry entry has a parity matrix declaration, and a
 * new entry without one fails CI. No database: this is the coverage guard; the role matrix itself runs in
 * test/agent-action-permission-parity.test.ts. */
import {describe,expect,it} from 'vitest';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {AGENT_ACTION_PARITY,PARITY_PENDING_CEILING,PARITY_ROLES,PROBED_ACTION_IDS,parityCoverageProblems,type ParityDeclaration} from './helpers/agent-action-parity-matrix';

const registry=AGENT_ACTIONS.map(action=>({id:action.id,store:action.store}));
const declarations:Readonly<Record<string,ParityDeclaration>>=AGENT_ACTION_PARITY;
const probed:ParityDeclaration={kind:'probed',screen:{employee:'allow',manager:'deny',assigned_approver:'deny',company_hr:'deny',group_hr:'deny',payroll_partner:'deny',performance_comp_partner:'deny',performance_partner:'deny',another_company:'deny',another_tenant:'deny'}};

describe('WP8 parity matrix coverage of the agent action registry',()=>{
 it('declares every registry entry, and only registry entries',()=>{
  expect(parityCoverageProblems(registry,declarations)).toEqual([]);
  expect(Object.keys(AGENT_ACTION_PARITY).sort()).toEqual(registry.map(entry=>entry.id).sort());
 });

 it('names the nine review roles, with both performance partner roles',()=>{
  expect([...PARITY_ROLES]).toEqual(['employee','manager','assigned_approver','company_hr','group_hr','payroll_partner','performance_comp_partner','performance_partner','another_company','another_tenant']);
 });

 it('probes the wave 1 and 1b generic families, and every probed entry has an agent store',()=>{
  expect([...PROBED_ACTION_IDS].sort()).toEqual(['approvals.attendance.decide','approvals.claim.decide','approvals.toil.decide','attendance.overtime.request','claims.cancel','employees.movement.transfer','leave.adjustment.apply','leave.cancel','leave.edit','toil.credit.grant']);
  for(const id of PROBED_ACTION_IDS)expect(AGENT_ACTIONS.find(action=>action.id===id)?.store,id).not.toBe('human_workflow_only');
 });

 it('fails a new registry entry that arrives without matrix fixtures',()=>{
  const added=[...registry,{id:'fictional.new_action',store:'generic_own'}];
  expect(parityCoverageProblems(added,declarations)).toEqual(['fictional.new_action: no parity matrix declaration (add a probed declaration and a DB adapter)']);
 });

 it('refuses to let a new entry hide on the pending list',()=>{
  const added=[...registry,{id:'fictional.new_action',store:'generic_own'}];
  expect(parityCoverageProblems(added,{...declarations,'fictional.new_action':{kind:'pending',reason:'later'}})).toEqual(['fictional.new_action: a new entry cannot be pending; it needs a probed declaration and a DB adapter']);
 });

 it('accepts the new entry once it carries a complete probed declaration',()=>{
  const added=[...registry,{id:'fictional.new_action',store:'generic_own'}];
  expect(parityCoverageProblems(added,{...declarations,'fictional.new_action':probed})).toEqual([]);
 });

 it('refuses incomplete, wider-than-screen, cross-company and vacuous declarations',()=>{
  const added=[...registry,{id:'fictional.new_action',store:'generic_own'}];
  const check=(d:unknown)=>parityCoverageProblems(added,{...declarations,'fictional.new_action':d as ParityDeclaration});
  const screen=(probed as Extract<ParityDeclaration,{kind:'probed'}>).screen;
  const missing=Object.fromEntries(Object.entries(screen).filter(([role])=>role!=='manager'));
  expect(check({kind:'probed',screen:missing})).toEqual(['fictional.new_action: no screen outcome for manager']);
  expect(check({kind:'probed',screen:{...screen,another_company:'allow'}})).toEqual(['fictional.new_action: another_company must be refused']);
  expect(check({kind:'probed',screen:{...screen,another_tenant:'allow'}})).toEqual(['fictional.new_action: another_tenant must be refused']);
  expect(check({kind:'probed',screen,narrowed:{manager:'agent refuses'}})).toEqual(['fictional.new_action: narrowing manager is meaningless (the screen refuses it); the agent may never be wider']);
  expect(check({kind:'probed',screen,narrowed:{employee:'agent refuses'}})).toEqual(['fictional.new_action: no role is allowed by both the screen and the agent, so the matrix proves nothing']);
  expect(check({kind:'probed',screen:{...screen,employee:'deny'}})).toEqual(['fictional.new_action: no role is allowed by both the screen and the agent, so the matrix proves nothing']);
  expect(check({kind:'human_workflow_only',reason:'hand-off'})).toEqual(['fictional.new_action: human_workflow_only declaration must match the registry store (generic_own)']);
 });

 it('keeps the pending list a shrinking ratchet of pre-existing entries',()=>{
  const pending=Object.entries(AGENT_ACTION_PARITY).filter(([,d])=>d.kind==='pending').map(([id])=>id).sort();
  // Exactly the ceiling: an adapter landing must remove its id here (the guard reports a stale ceiling entry).
  expect(pending).toEqual([...PARITY_PENDING_CEILING].sort());
  expect(PARITY_PENDING_CEILING.size).toBeLessThanOrEqual(19);
  const stale=parityCoverageProblems(registry,{...declarations,'leave.apply':probed});
  expect(stale).toEqual(['leave.apply: has a probed declaration, so remove it from PARITY_PENDING_CEILING (the list only shrinks)']);
 });
});
