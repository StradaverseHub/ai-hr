/** Assistant native-action shortcuts: which ones a session is OFFERED. Pure floors are pinned against the
 * gates they mirror; live-scope answers are stubbed at their source to prove fail-closed behaviour. No
 * database: the target actions' own refusals are proved by their own suites. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const source=vi.hoisted(()=>({companies:vi.fn(),assigned:vi.fn()}));
vi.mock('../core/workforce-access',()=>({workforceCompanies:source.companies}));
vi.mock('../core/assistant-actions/module-action-server',()=>({readAssignedLeaveModuleActionChoices:source.assigned}));
import type {SessionContext} from '../db/client';
import {MODULE_ACTION_ENTRIES,MODULE_ACTION_ENTRY_OF,moduleActionEntryRoleFloor} from '../lib/assistant-actions/module-action-entries';
import {moduleActionEntryAccess,allowedModuleActionEntries} from '../core/assistant-actions/module-action-entries';
import {canAuthor} from '../core/knowledge-base';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
const ctxOf=(role:string)=>({tenantId:'t',userId:'u',roles:[role],grants:[{role,companyId:null}]}) as SessionContext;
const task={leaveRequestId:'10000000-0000-4000-8000-000000000002',currentStepId:null,stepIndex:null,applicantLabel:'Fictional applicant',createdAt:'2026-10-27T00:00:00Z'};
beforeEach(()=>{vi.clearAllMocks();source.companies.mockResolvedValue([]);source.assigned.mockResolvedValue({kind:'choices',truncated:false,tasks:[]});});
describe('role floors mirror the target gates',()=>{
 it('mirrors each target gate: admin-only floors refuse employees and managers, payroll floors admit the payroll partner only where the target does',()=>{
  const ctxOf=(role:string)=>({tenantId:'t',userId:'u',roles:[role],grants:[{role,companyId:null}]}) as SessionContext;
  for(const role of ['employee','manager']){const s=ctxOf(role);for(const entry of ['employee_import','knowledge','pay_component','payroll_close','multi_cycle_run','country_statutory'] as const)expect(moduleActionEntryRoleFloor(s,entry)).toBe(false);}
  for(const role of ['hr_admin','super_admin']){const s=ctxOf(role);for(const entry of ['employee_import','knowledge','pay_component','payroll_close','multi_cycle_run','country_statutory'] as const)expect(moduleActionEntryRoleFloor(s,entry)).toBe(true);}
  const partner=ctxOf('payroll_partner');expect(moduleActionEntryRoleFloor(partner,'payroll_close')).toBe(true);expect(moduleActionEntryRoleFloor(partner,'multi_cycle_run')).toBe(false);expect(moduleActionEntryRoleFloor(partner,'pay_component')).toBe(false);
  // The Knowledge Base floor IS the author gate, not a copy that can drift from it.
  for(const role of ['employee','manager','hr_admin','super_admin','payroll_partner'])expect(moduleActionEntryRoleFloor(ctxOf(role),'knowledge')).toBe(canAuthor(ctxOf(role)));
  for(const entry of ['org','assigned_leave'] as const)expect(moduleActionEntryRoleFloor(ctxOf('hr_admin'),entry)).toBeNull();
  expect(new Set(Object.values(MODULE_ACTION_ENTRY_OF))).toEqual(new Set(MODULE_ACTION_ENTRIES));
 });
});
describe('live-scope shortcuts fail closed',()=>{
 it('offers reporting-line changes only with current workforce maintenance scope',async()=>{
  expect(await moduleActionEntryAccess(ctxOf('employee'),'org')).toBe('refused');expect(source.companies).toHaveBeenCalledWith(expect.objectContaining({userId:'u'}),'maintain');
  source.companies.mockResolvedValueOnce(['company']);expect(await moduleActionEntryAccess(ctxOf('hr_admin'),'org')).toBe('allowed');
  source.companies.mockRejectedValueOnce(Error('PRIVATE scope failure'));expect(await moduleActionEntryAccess(ctxOf('hr_admin'),'org')).toBe('unknown');
 });
 it('offers assigned decisions to managers and admins, and to anyone else only with a current assigned task',async()=>{
  for(const role of ['manager','hr_admin','super_admin'])expect(await moduleActionEntryAccess(ctxOf(role),'assigned_leave')).toBe('allowed');expect(source.assigned).not.toHaveBeenCalled();
  expect(await moduleActionEntryAccess(ctxOf('employee'),'assigned_leave')).toBe('refused');
  source.assigned.mockResolvedValueOnce({kind:'choices',truncated:false,tasks:[task]});expect(await moduleActionEntryAccess(ctxOf('employee'),'assigned_leave')).toBe('allowed');
  source.assigned.mockResolvedValueOnce({kind:'unavailable'});expect(await moduleActionEntryAccess(ctxOf('employee'),'assigned_leave')).toBe('unknown');
  source.assigned.mockRejectedValueOnce(Error('PRIVATE'));expect(await moduleActionEntryAccess(ctxOf('employee'),'assigned_leave')).toBe('unknown');
 });
 it('lists nothing administrative for an ordinary employee and every shortcut for a scoped HR admin',async()=>{
  expect(await allowedModuleActionEntries(ctxOf('employee'),AGENT_MODULE_CODES)).toEqual([]);
  source.companies.mockResolvedValue(['company']);expect(new Set(await allowedModuleActionEntries(ctxOf('hr_admin'),AGENT_MODULE_CODES))).toEqual(new Set(MODULE_ACTION_ENTRIES));
  source.companies.mockResolvedValue([]);expect(await allowedModuleActionEntries(ctxOf('manager'),AGENT_MODULE_CODES)).toEqual(['assigned_leave']);
 });
 it('reads nothing for task cards that are not shown',async()=>{
  expect(await allowedModuleActionEntries(ctxOf('employee'),['leave','claims'])).toEqual([]);expect(source.companies).not.toHaveBeenCalled();expect(source.assigned).not.toHaveBeenCalled();
 });
});
