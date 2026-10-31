/** Authored UNRUN. Complete locale copy and exact semantics vocabulary, not independent translation certification. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {NATIVE_OUTCOME_ACTIONS} from '../lib/ai/module-native-outcomes';
const locales=['en','ms','zh','ta','vi','th'];
const read=(locale:string)=>JSON.parse(readFileSync(join(process.cwd(),'messages',locale+'.json'),'utf8')).assistant.workspace.nativeOutcomes as Record<string,string>;
describe('native outcome localised human semantics',()=>{
 it('has every action and control in each of the six locales without English fallback',()=>{
  const en=read('en'),keys=Object.keys(en).sort();for(const locale of locales){const copy=read(locale);expect(Object.keys(copy).sort()).toEqual(keys);for(const value of Object.values(copy))expect(value.trim().length).toBeGreaterThan(0);for(const action of Object.keys(NATIVE_OUTCOME_ACTIONS))expect(copy['action_'+action.replace(/[.-]/g,'_')]).toBeTruthy();if(locale!=='en')expect(copy).not.toEqual(en);}
 });
 it('never describes submitted Leave, Claims or payroll close as approval, reimbursement or payment proof',()=>{
  const workspace=JSON.parse(readFileSync(join(process.cwd(),'messages/en.json'),'utf8')).assistant.workspace,copy=read('en');expect(copy.action_leave_apply).toContain('not approved');expect(copy.action_claims_submit).toContain('not approved or reimbursed');expect(copy.action_payroll_close).toBe(workspace.payrollCloseActions.recorded);expect(copy.action_rewards_post).toBe(workspace.rewardsActions.posted);expect(copy.notQuality).toContain('does not approve, pay or execute');expect(copy.action_system_testing_execution_save).toContain('not independent verification');expect(copy.notQuality).toContain('does not prove');expect(copy.candidateIntro).toContain('replace independent evaluation');
 });
});

// Explicit repaired set is independent of runtime enumeration; never filter unknown actions away.
const repairedActions=[
 "org.position.archive",
 "org.department.archive",
 "org.employee_id_template.status",
 "org.people_general.change",
 "payroll.reopen",
 "payroll.reset",
 "performance.checkin.cancel",
 "performance.checkin.complete",
 "performance.checkin.schedule",
 "performance.goal.approve",
 "rewards.cancel_review",
 "rewards.calendar.update",
 "lifecycle.offboarding.step.complete",
 "lifecycle.offboarding.step.undo",
 "lifecycle.offboarding.case.cancel",
 "rewards.annual_review.return",
 "employees.compensation.maintain",
 "attendance.schedule_group.maintain",
 "employees.profile_request.reject",
 "attendance.day_schedule.correct",
 "employees.code.maintain",
 "employees.workforce_profile.maintain",
 "employees.bank.maintain",
 "employees.document_metadata.maintain",
 "employees.fixed_item.archive",
 "employees.cost_allocation.maintain",
 "employees.payment_method.maintain",
 "employees.tp3_opening.maintain",
 "employees.passport.maintain",
 "employees.emergency_contact.maintain",
 "employees.family.maintain",
 "employees.qualification.maintain",
 "employees.draft.discard",
 "employees.draft.activate"
] as const;
const retainedNotificationCaptions=['approvals.claim.chase','approvals.attendance.chase','approvals.toil.chase','employees.review_overdue.remind','attendance.missing_clock.remind','employees.passport_expiry.remind','lifecycle.step.chase'] as const;
it('covers all human outcome captions while preserving seven old notification captions without admitting automatic evidence',()=>{
 expect(repairedActions).toHaveLength(34);expect(new Set(repairedActions).size).toBe(34);for(const action of retainedNotificationCaptions)expect(Object.hasOwn(NATIVE_OUTCOME_ACTIONS,action)).toBe(false);
 for(const locale of locales){const workspace=JSON.parse(readFileSync(join(process.cwd(),'messages',locale+'.json'),'utf8')).assistant.workspace,copy=read(locale);
  expect(Object.keys(copy).filter(key=>key.startsWith('action_')).sort()).toEqual([...Object.keys(NATIVE_OUTCOME_ACTIONS),...retainedNotificationCaptions].map(action=>'action_'+action.replace(/[.-]/g,'_')).sort());
  for(const action of repairedActions)expect(copy['action_'+action.replace(/[.-]/g,'_')],locale+'.'+action).toBeTruthy();
  expect(copy.action_payroll_close).toBe(workspace.payrollCloseActions.recorded);expect(copy.action_rewards_post).toBe(workspace.rewardsActions.posted);
  expect(copy.notQuality).toBeTruthy();
 }
});
