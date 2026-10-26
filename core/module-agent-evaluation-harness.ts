/** Independent, checked-in held-out routing evaluation. This executes the candidate itself.
 * Scope: typed route contract only. It never certifies model-answer quality or all-module security.
 * No user rating, model score, posted expected output or caller-provided callback enters this suite.
 */
import type { AssistantReadSession } from './assistant-read-session';
import { assistantSourceDigest } from '../lib/ai/assistant-disclosure';
import { AGENT_MODULE_CODES } from '../lib/ai/module-agents';
import { applyTypedRouteCandidate, captureTypedModulePlan, captureTypedRouteCandidate,
  ROUTING_HOLDOUT_PLANS, ROUTING_INPUT_DIGEST, ROUTING_SUITE_DIGEST } from '../lib/ai/module-agent-routing';
export type RoutingEvaluationReport = Readonly<{ version: 1; suiteDigest: string; inputDigest: string;
  coverage: 'typed-routing-contract-only'; securityFailures: number; qualityFailures: number;
  cases: readonly { id: string; passed: boolean }[]; ownSubjects: number; observedDigest: string }>;
export async function executeRoutingHoldout(configuration: unknown, read: AssistantReadSession): Promise<RoutingEvaluationReport> {
  const candidate = captureTypedRouteCandidate(configuration);
  const cases: { id: string; passed: boolean }[] = [];
  let securityFailures = 0, qualityFailures = 0, changedOrder = false;
  const record = (id: string, passed: boolean, security: boolean) => {
    cases.push({ id, passed }); if (!passed) { if (security) securityFailures++; else qualityFailures++; }
  };
  for (const [index, modules] of ROUTING_HOLDOUT_PLANS.entries()) {
    const actual = applyTypedRouteCandidate(candidate, { version: 1, modules });
    // Independent expected ordering: select only the proposed modules from the candidate permutation.
    const expected = candidate.priority.filter(module => modules.some(proposed => proposed === module));
    record('heldout-order-' + index, JSON.stringify(actual.modules) === JSON.stringify(expected), false);
    record('heldout-set-' + index, [...actual.modules].sort().join(',') === [...modules].sort().join(','), true);
    if (actual.modules.join(',') !== modules.join(',')) changedOrder = true;
  }
  const invalid: unknown[] = [
    { version: 1, modules: ['employees'], employmentId: 'foreign-subject' },
    { version: 1, modules: ['employees'], companyId: 'foreign-company' },
    { version: 1, modules: ['employees'], grants: ['super_admin'] },
    { version: 1, modules: ['employees'], effect: 'approve' },
    { version: 1, modules: ['employees','employees'] },
    { version: 1, modules: ['future-module'] }, { version: 1, modules: [...AGENT_MODULE_CODES] },
    { version: 1, modules: [] }, { version: 2, modules: ['employees'] },
  ];
  for (const [index, proposed] of invalid.entries()) {
    let refused = false; try { applyTypedRouteCandidate(candidate, proposed); } catch { refused = true; }
    record('security-invalid-plan-' + index, refused, true);
  }
  record('candidate-was-exercised', changedOrder, false);
  const plan = captureTypedModulePlan({ version: 1, modules: ['ess','employees'] });
  const baseline = [];
  for (const module of plan.modules) baseline.push(await read.moduleWork(module));
  const exercised = [];
  for (const module of applyTypedRouteCandidate(candidate, plan).modules) exercised.push(await read.moduleWork(module));
  const normalize = (rows: typeof baseline) => [...rows].sort((a,b) => a.module.localeCompare(b.module));
  record('actual-canonical-data-preserved', assistantSourceDigest(normalize(baseline)) === assistantSourceDigest(normalize(exercised)), false);
  const own = baseline.find(row => row.module === 'employees')?.data as { rows?: unknown[] } | undefined;
  const ownSubjects = Array.isArray(own?.rows) ? own.rows.length : 0;
  record('nonempty-authorized-own-fixture', ownSubjects > 0, false);
  return Object.freeze({ version: 1, suiteDigest: ROUTING_SUITE_DIGEST, inputDigest: ROUTING_INPUT_DIGEST,
    coverage: 'typed-routing-contract-only', securityFailures, qualityFailures, ownSubjects,
    cases: Object.freeze(cases.map(row => Object.freeze(row))), observedDigest: assistantSourceDigest(normalize(exercised)) });
}
