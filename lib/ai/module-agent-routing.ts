/** The routing candidate kind; read-plan prompt, canonical guidance and conversation candidates have separate harnesses. It reorders an already authorized read set.
 * It cannot nominate subjects, change fields, add work, call providers or own business effects.
 */
import { createHash } from 'node:crypto';
import { AGENT_MODULE_CODES, isAgentModuleCode, type AgentModuleCode } from './module-agents';
export const ROUTING_ENGINE_VERSION = 'typed-route-priority-v1';
export const routingDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ROUTING_ENGINE_DIGEST = routingDigest([ROUTING_ENGINE_VERSION, 'captured-permutation', 'same-exact-module-set', 'no-effects','paired-canonical-observations-v2','permutation-is-not-quality-gain']);
export type TypedRouteCandidate = Readonly<{ kind: 'typed_route_priority_v1'; priority: readonly AgentModuleCode[] }>;
export type CapturedModulePlan = Readonly<{ version: 1; modules: readonly AgentModuleCode[] }>;
const refuse = (): never => { throw new Error('Unsupported module-agent candidate or plan.'); };
export function captureTypedRouteCandidate(value: unknown): TypedRouteCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'kind,priority' || row.kind !== 'typed_route_priority_v1' ||
    !Array.isArray(row.priority) || row.priority.length !== AGENT_MODULE_CODES.length ||
    !row.priority.every(isAgentModuleCode) || new Set(row.priority).size !== AGENT_MODULE_CODES.length) return refuse();
  return Object.freeze({ kind: 'typed_route_priority_v1', priority: Object.freeze([...row.priority]) });
}
export function captureTypedModulePlan(value: unknown): CapturedModulePlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'modules,version' || row.version !== 1 || !Array.isArray(row.modules) ||
    row.modules.length < 1 || row.modules.length > 4 || !row.modules.every(isAgentModuleCode) ||
    new Set(row.modules).size !== row.modules.length) return refuse();
  return Object.freeze({ version: 1, modules: Object.freeze([...row.modules]) });
}
export function applyTypedRouteCandidate(configuration: unknown, proposed: unknown): CapturedModulePlan {
  const candidate = captureTypedRouteCandidate(configuration), plan = captureTypedModulePlan(proposed);
  return Object.freeze({ version: 1, modules: Object.freeze([...plan.modules].sort((a,b) => candidate.priority.indexOf(a)-candidate.priority.indexOf(b))) });
}
/** Immutable held-out contract inputs owned independently of candidate/model/feedback. */
export const ROUTING_HOLDOUT_PLANS = Object.freeze([
  Object.freeze(['employees','ess'] as const), Object.freeze(['ess','employees'] as const),
  Object.freeze(['leave','approvals','employees'] as const), Object.freeze(['attendance','toil','org'] as const),
  Object.freeze(['payroll','typed_pay_components','multi_cycle_payroll'] as const),
  Object.freeze(['claims','performance','rewards','lifecycle'] as const),
  Object.freeze(['assistant','notifications','knowledge_base','country-my'] as const),
  Object.freeze(['system_testing','system_explorer'] as const),
]);
// The actual native fixture reads only authorized own Employees/ESS facts. Other plans above are
// typed set/scope contracts; this evaluation does not claim live all-module business coverage.
export const ROUTING_CANONICAL_PLANS=Object.freeze(ROUTING_HOLDOUT_PLANS.slice(0,2));
export const ROUTING_POLICY = Object.freeze({ version: 2, securityFailures: 0, qualityFailures: 0,
  independentEvaluators: 2, minimumOwnSubjects: 1, maxJobs: 100, maxHours: 24, coverage: 'typed-routing-contract-only', improvementRequires:'strict-independent-canonical-quality-gain', timerNoiseNeverQualifies:true });
export const ROUTING_POLICY_DIGEST = routingDigest(ROUTING_POLICY);
export const ROUTING_INPUT_DIGEST = routingDigest([ROUTING_HOLDOUT_PLANS,ROUTING_CANONICAL_PLANS]);
export const ROUTING_SUITE_DIGEST = routingDigest(['routing-heldout-v2-paired', ROUTING_ENGINE_DIGEST, ROUTING_INPUT_DIGEST, ROUTING_POLICY_DIGEST]);
