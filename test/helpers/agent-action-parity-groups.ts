/** Explicit test-only partition. Unknown future actions or variants must fail the coverage guard,
 * never silently disappear or join multiple hosted DB entrypoints. No executable probes live here. */
import type {ProbedActionId} from './agent-action-parity-matrix';
const COMMAND_VARIANTS=['adapter_coverage','rejected_decisions','routed_attendance','permission_revalidation','boundary_controls','standalone_tester'] as const;
export const PARITY_PROBE_VARIANTS=[...COMMAND_VARIANTS,'cost_allocation_clear'] as const;
export type ParityProbeVariant=typeof PARITY_PROBE_VARIANTS[number];
export const PARITY_PROBE_GROUPS={
 commands:{actions:[
  'org.reporting.change','knowledge_base.article.create','typed_pay_components.create','leave.adjustment.apply',
  'employees.compensation.maintain','employees.bank.maintain','employees.emergency_contact.maintain',
  'employees.qualification.maintain','employees.movement.transfer','rewards.post',
 ],variants:[...COMMAND_VARIANTS]},
 requests:{actions:[
  'leave.apply','leave.cancel','leave.edit','ess.profile.request','attendance.correction.request',
  'attendance.overtime.request','claims.draft.save','claims.submit','claims.cancel','toil.replacement.request',
  'notifications.email_preferences.save','system_testing.execution.save','lifecycle.acknowledgement.submit',
 ],variants:[]},
 reviews:{actions:[
  'approvals.leave.decide','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide',
  'payroll.close','performance.review.acknowledge','performance.onehr.plan.acknowledge','multi_cycle_payroll.create_run',
  'country-my.statutory.update','employees.workforce_profile.maintain','employees.draft.activate',
  'employees.family.maintain','toil.credit.grant',
 ],variants:[]},
 personnel:{actions:[
  'employees.document_metadata.maintain','employees.code.maintain','employees.passport.maintain',
  'employees.payment_method.maintain','employees.fixed_item.archive','employees.tp3_opening.maintain',
  'employees.cost_allocation.maintain','employees.profile_request.reject',
 ],variants:['cost_allocation_clear']},
 personnel_discard:{actions:['employees.draft.discard'],variants:[]},
} satisfies Record<string,{actions:readonly ProbedActionId[];variants:readonly ParityProbeVariant[]}>;
export type ParityProbeGroup=keyof typeof PARITY_PROBE_GROUPS;
export const PARITY_PROBE_ENTRYPOINTS:Record<ParityProbeGroup,string>={commands:'test/agent-action-permission-parity-commands.test.ts',requests:'test/agent-action-permission-parity-requests.test.ts',reviews:'test/agent-action-permission-parity-reviews.test.ts',personnel:'test/agent-action-permission-parity-personnel.test.ts',personnel_discard:'test/agent-action-permission-parity-personnel-discard.test.ts'};
