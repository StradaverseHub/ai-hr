/** Assistant native-action shortcuts: which ones a session is OFFERED. Pure floors are pinned against the
 * gates they mirror; live-scope answers are stubbed at their source to prove fail-closed behaviour. No
 * database: the target actions' own refusals are proved by their own suites. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const source=vi.hoisted(()=>({companies:vi.fn(),assigned:vi.fn(),rewards:vi.fn(),cancel:vi.fn(),calendar:vi.fn(),annualReturn:vi.fn()}));
vi.mock('../core/workforce-access',()=>({workforceCompanies:source.companies}));
vi.mock('../packs/rewards/service',()=>({administersRewardsForAnyCompany:source.rewards}));
vi.mock('../core/assistant-actions/module-action-server',()=>({readAssignedLeaveModuleActionChoices:source.assigned}));
vi.mock('../core/assistant-actions/rewards-cancel-source',()=>({readRewardsCancelChoices:source.cancel}));
vi.mock('../core/assistant-actions/rewards-return-source',()=>({readRewardsReturnChoices:source.annualReturn}));
vi.mock('../core/assistant-actions/rewards-calendar-source',()=>({readRewardsCalendarChoices:source.calendar}));
import type {SessionContext} from '../db/client';
import {MODULE_ACTION_ENTRIES,MODULE_ACTION_ENTRY_OF,moduleActionEntryRoleFloor} from '../lib/assistant-actions/module-action-entries';
import {moduleActionEntryAccess,allowedModuleActionEntries} from '../core/assistant-actions/module-action-entries';
import {canAuthor} from '../core/knowledge-base';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
const ctxOf=(role:string)=>({tenantId:'t',userId:'u',roles:[role],grants:[{role,companyId:null}]}) as SessionContext;
const task={leaveRequestId:'10000000-0000-4000-8000-000000000002',currentStepId:null,stepIndex:null,applicantLabel:'Fictional applicant',createdAt:'2026-10-27T00:00:00Z'};
beforeEach(()=>{vi.clearAllMocks();source.companies.mockResolvedValue([]);source.assigned.mockResolvedValue({kind:'choices',truncated:false,tasks:[]});source.rewards.mockResolvedValue(false);source.cancel.mockResolvedValue({units:[]});source.calendar.mockResolvedValue({units:[]});source.annualReturn.mockResolvedValue({units:[]});});
describe('role floors mirror the target gates',()=>{
 it('mirrors each target gate: admin-only floors refuse employees and managers, payroll floors admit the payroll partner only where the target does',()=>{
  const ctxOf=(role:string)=>({tenantId:'t',userId:'u',roles:[role],grants:[{role,companyId:null}]}) as SessionContext;
  for(const role of ['employee','manager']){const s=ctxOf(role);for(const entry of ['employee_import','knowledge','pay_component','payroll_close','multi_cycle_run','country_statutory'] as const)expect(moduleActionEntryRoleFloor(s,entry)).toBe(false);}
  for(const role of ['hr_admin','super_admin']){const s=ctxOf(role);for(const entry of ['employee_import','knowledge','pay_component','payroll_close','multi_cycle_run','country_statutory'] as const)expect(moduleActionEntryRoleFloor(s,entry)).toBe(true);}
  const partner=ctxOf('payroll_partner');expect(moduleActionEntryRoleFloor(partner,'payroll_close')).toBe(true);expect(moduleActionEntryRoleFloor(partner,'multi_cycle_run')).toBe(false);expect(moduleActionEntryRoleFloor(partner,'pay_component')).toBe(false);
  // The Knowledge Base floor IS the author gate, not a copy that can drift from it.
  for(const role of ['employee','manager','hr_admin','super_admin','payroll_partner'])expect(moduleActionEntryRoleFloor(ctxOf(role),'knowledge')).toBe(canAuthor(ctxOf(role)));
  for(const entry of ['org','assigned_leave','rewards'] as const)expect(moduleActionEntryRoleFloor(ctxOf('hr_admin'),entry)).toBeNull();
  // app.reward_admin (0524) admits only hr_admin/super_admin role assignments, so nobody else is offered Rewards.
  for(const role of ['employee','manager','payroll_partner'])expect(moduleActionEntryRoleFloor(ctxOf(role),'rewards')).toBe(false);
  expect(new Set([...Object.values(MODULE_ACTION_ENTRY_OF),'rewards_cancel','rewards_calendar','rewards_return'])).toEqual(new Set(MODULE_ACTION_ENTRIES));
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
 it('offers Rewards posting only where the live app.reward_admin read admits the login, and hides it when the read fails',async()=>{
  expect(await moduleActionEntryAccess(ctxOf('employee'),'rewards')).toBe('refused');expect(source.rewards).not.toHaveBeenCalled();
  expect(await moduleActionEntryAccess(ctxOf('hr_admin'),'rewards')).toBe('refused');expect(source.rewards).toHaveBeenCalledWith(expect.objectContaining({userId:'u',roles:['hr_admin']}));
  source.rewards.mockResolvedValueOnce(true);expect(await moduleActionEntryAccess(ctxOf('super_admin'),'rewards')).toBe('allowed');
  source.rewards.mockRejectedValueOnce(Error('PRIVATE rewards failure'));expect(await moduleActionEntryAccess(ctxOf('hr_admin'),'rewards')).toBe('unknown');
  expect(await allowedModuleActionEntries(ctxOf('hr_admin'),['rewards'])).toEqual([]);
 });
 it('lists nothing administrative for an ordinary employee and every shortcut for a scoped HR admin',async()=>{
  expect(await allowedModuleActionEntries(ctxOf('employee'),AGENT_MODULE_CODES)).toEqual([]);
  source.companies.mockResolvedValue(['company']);source.rewards.mockResolvedValue(true);source.cancel.mockResolvedValue({units:[{unitId:'u'}]});source.calendar.mockResolvedValue({units:[{unitId:'u'}]});source.annualReturn.mockResolvedValue({units:[{unitId:'u'}]});expect(new Set(await allowedModuleActionEntries(ctxOf('hr_admin'),AGENT_MODULE_CODES))).toEqual(new Set(MODULE_ACTION_ENTRIES));
  source.companies.mockResolvedValue([]);source.cancel.mockResolvedValue({units:[]});source.calendar.mockResolvedValue({units:[]});source.annualReturn.mockResolvedValue({units:[]});expect(await allowedModuleActionEntries(ctxOf('manager'),AGENT_MODULE_CODES)).toEqual(['assigned_leave']);
 });
 it('reads nothing for task cards that are not shown',async()=>{
  expect(await allowedModuleActionEntries(ctxOf('employee'),['leave','claims'])).toEqual([]);expect(source.companies).not.toHaveBeenCalled();expect(source.assigned).not.toHaveBeenCalled();expect(source.rewards).not.toHaveBeenCalled();
 });
});

it('offers cancellation using actual native GR/company-admin choices and fails closed independently of posting',async()=>{expect(moduleActionEntryRoleFloor(ctxOf('employee'),'rewards_cancel')).toBeNull();source.cancel.mockResolvedValueOnce({units:[{unitId:'fictional'}]});expect(await moduleActionEntryAccess(ctxOf('employee'),'rewards_cancel')).toBe('allowed');source.cancel.mockRejectedValueOnce(Error('private'));expect(await moduleActionEntryAccess(ctxOf('employee'),'rewards_cancel')).toBe('unknown');expect(await moduleActionEntryAccess(ctxOf('employee'),'rewards')).toBe('refused');});

it('offers calendar editing independently through actual native choices and refuses failed reads',async()=>{expect(moduleActionEntryRoleFloor(ctxOf('employee'),'rewards_calendar')).toBeNull();source.calendar.mockResolvedValueOnce({units:[{unitId:'fictional'}]});expect(await moduleActionEntryAccess(ctxOf('employee'),'rewards_calendar')).toBe('allowed');source.calendar.mockRejectedValueOnce(Error('private'));expect(await moduleActionEntryAccess(ctxOf('employee'),'rewards_calendar')).toBe('unknown');expect(await moduleActionEntryAccess(ctxOf('employee'),'rewards')).toBe('refused');});

it('offers annual return through current native stage choices independently from posting',async()=>{expect(moduleActionEntryRoleFloor(ctxOf('employee'),'rewards_return')).toBeNull();source.annualReturn.mockResolvedValueOnce({units:[{unitId:'fictional'}]});expect(await moduleActionEntryAccess(ctxOf('employee'),'rewards_return')).toBe('allowed');source.annualReturn.mockRejectedValueOnce(Error('private'));expect(await moduleActionEntryAccess(ctxOf('employee'),'rewards_return')).toBe('unknown');expect(await moduleActionEntryAccess(ctxOf('employee'),'rewards')).toBe('refused');});
