/** Explicit test-only partition. Unknown future actions or variants must fail the coverage guard,
 * never silently disappear or join multiple hosted DB entrypoints. No executable probes live here. */
import type {ProbedActionId} from './agent-action-parity-matrix';
export const PARITY_PROBE_VARIANTS=['adapter_coverage','rejected_decisions','routed_attendance','permission_revalidation','boundary_controls','standalone_tester'] as const;
export type ParityProbeVariant=typeof PARITY_PROBE_VARIANTS[number];
export const PARITY_PROBE_GROUPS={
 commands:{actions:[
  'org.reporting.change','knowledge_base.article.create','typed_pay_components.create','leave.adjustment.apply',
  'employees.compensation.maintain','employees.bank.maintain','employees.emergency_contact.maintain',
  'employees.qualification.maintain','employees.movement.transfer','rewards.post',
