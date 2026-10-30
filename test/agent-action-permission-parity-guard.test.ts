/** ADR-0151 §7, review R16 (WP8): every agent action registry entry has a parity matrix declaration, and a
 * new entry without one fails CI. No database: this is the coverage guard; the role matrix itself runs in
 * test/agent-action-permission-parity.test.ts. */
import {describe,expect,it} from 'vitest';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {AGENT_ACTION_PARITY,ATTENDANCE_WORKFLOW_PARITY,PARITY_PENDING_CEILING,PARITY_PENDING_ORIGINAL,PARITY_ROLES,PROBED_ACTION_IDS,parityCoverageProblems,type ParityDeclaration} from './helpers/agent-action-parity-matrix';

const registry=AGENT_ACTIONS.map(action=>({id:action.id,store:action.store}));
const declarations:Readonly<Record<string,ParityDeclaration>>=AGENT_ACTION_PARITY;
const probed:ParityDeclaration={kind:'probed',screen:{employee:'allow',manager:'deny',assigned_approver:'deny',company_hr:'deny',group_hr:'deny',super_admin:'deny',payroll_partner:'deny',performance_comp_partner:'deny',performance_partner:'deny',another_company:'deny',another_tenant:'deny'}};

describe('WP8 parity matrix coverage of the agent action registry',()=>{
 it('requires routed delegate confirmation parity after the delegated-approvals fix',()=>{
  expect(ATTENDANCE_WORKFLOW_PARITY.screen.assigned_approver).toBe('allow');
  expect(ATTENDANCE_WORKFLOW_PARITY).not.toHaveProperty('narrowed');
 });

 it('declares every registry entry, and only registry entries',()=>{
  expect(parityCoverageProblems(registry,declarations)).toEqual([]);
  expect(Object.keys(AGENT_ACTION_PARITY).sort()).toEqual(registry.map(entry=>entry.id).sort());
 });

 it('names the actual native roles, including the tenant super administrator, with both performance partner roles',()=>{
  expect([...PARITY_ROLES]).toEqual(['employee','manager','assigned_approver','company_hr','group_hr','super_admin','payroll_partner','performance_comp_partner','performance_partner','another_company','another_tenant']);
 });

 it('has a real adapter for every human review action, with no remaining pending ceiling',()=>{
  const humanActions=[...PARITY_PENDING_ORIGINAL,'approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide','leave.adjustment.apply','employees.movement.transfer','toil.credit.grant','employees.qualification.maintain','employees.compensation.maintain','employees.emergency_contact.maintain','employees.draft.activate','employees.workforce_profile.maintain'];
  expect([...PROBED_ACTION_IDS].sort()).toEqual(humanActions.sort());
  expect(PROBED_ACTION_IDS).toHaveLength(humanActions.length);expect(PARITY_PENDING_CEILING.size).toBe(0);
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

 it('pins the frozen original pending set, and the ceiling is a subset no larger than it',()=>{
  expect(PARITY_PENDING_ORIGINAL).toHaveLength(23);
  expect(new Set(PARITY_PENDING_ORIGINAL).size).toBe(23);
  for(const id of PARITY_PENDING_CEILING)expect(PARITY_PENDING_ORIGINAL,id).toContain(id);
  expect(PARITY_PENDING_CEILING.size).toBeLessThanOrEqual(PARITY_PENDING_ORIGINAL.length);
  for(const id of PARITY_PENDING_ORIGINAL)expect(registry.map(entry=>entry.id),id).toContain(id);
 });

 it('refuses swapping an entry onto the ceiling, even when it predates the harness',()=>{
  const swapped=new Set([...PARITY_PENDING_CEILING].filter(id=>id!=='leave.apply'));swapped.add('approvals.claim.decide');
  const problems=parityCoverageProblems(registry,{...declarations,'leave.apply':probed,'approvals.claim.decide':{kind:'pending',reason:'swap'}},swapped);
  expect(problems).toContain('approvals.claim.decide: not in the frozen PARITY_PENDING_ORIGINAL; the pending ceiling can only lose entries, never gain or swap them');
  const grown=new Set([...PARITY_PENDING_ORIGINAL,'fictional.extra']);
  expect(parityCoverageProblems(registry,declarations,grown,PARITY_PENDING_ORIGINAL)).toEqual(expect.arrayContaining(['pending ceiling has 24 entries, more than the frozen 23']));
 });

 it('keeps the pending list a shrinking ratchet of pre-existing entries',()=>{
  const pending=Object.entries(declarations).filter(([,d])=>d.kind==='pending').map(([id])=>id).sort();
  // Exactly the ceiling: an adapter landing must remove its id here (the guard reports a stale ceiling entry).
  expect(pending).toEqual([...PARITY_PENDING_CEILING].sort());
  expect(PARITY_PENDING_CEILING.size).toBe(0);
  const stale=parityCoverageProblems(registry,declarations,new Set(['leave.apply']));
  expect(stale).toEqual(['leave.apply: has a probed declaration, so remove it from PARITY_PENDING_CEILING (the list only shrinks)']);
 });
});
