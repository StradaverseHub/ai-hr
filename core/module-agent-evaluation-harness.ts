/** Independent, checked-in held-out routing evaluation. This executes the candidate itself.
 * Scope: typed route contract only. It never certifies model-answer quality or all-module security.
 * No user rating, model score, posted expected output or caller-provided callback enters this suite.
 */
import type { AssistantReadSession } from './assistant-read-session';
import { assistantSourceDigest } from '../lib/ai/assistant-disclosure';
import {compareMeasuredQuality,type MeasuredEvaluationCase} from '../lib/ai/paired-evaluation';
import { AGENT_MODULE_CODES } from '../lib/ai/module-agents';
import { applyTypedRouteCandidate, captureTypedModulePlan, captureTypedRouteCandidate,
  ROUTING_HOLDOUT_PLANS,ROUTING_CANONICAL_PLANS, ROUTING_INPUT_DIGEST, ROUTING_SUITE_DIGEST } from '../lib/ai/module-agent-routing';
export type RoutingEvaluationReport = Readonly<{ version: 2; suiteDigest: string; inputDigest: string;
  coverage: 'typed-routing-contract-only'; securityFailures: number; qualityFailures: number;
  cases: readonly { id: string; passed: boolean }[]; ownSubjects: number; observedDigest: string; baseline:readonly MeasuredEvaluationCase[];candidate:readonly MeasuredEvaluationCase[];comparison:ReturnType<typeof compareMeasuredQuality> }>;
export async function executeRoutingHoldout(configuration: unknown, read: AssistantReadSession): Promise<RoutingEvaluationReport> {
  const candidate = captureTypedRouteCandidate(configuration);
  const cases: { id: string; passed: boolean }[] = [];
  let securityFailures = 0, qualityFailures = 0;
  const record = (id: string, passed: boolean, security: boolean) => {
    cases.push({ id, passed }); if (!passed) { if (security) securityFailures++; else qualityFailures++; }
  };
  for (const [index, modules] of ROUTING_HOLDOUT_PLANS.entries()) {
    const actual = applyTypedRouteCandidate(candidate, { version: 1, modules });
    // Independent expected ordering: select only the proposed modules from the candidate permutation.
    const expected = candidate.priority.filter(module => modules.some(proposed => proposed === module));
    record('heldout-order-' + index, JSON.stringify(actual.modules) === JSON.stringify(expected), false);
    record('heldout-set-' + index, [...actual.modules].sort().join(',') === [...modules].sort().join(','), true);
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
  const baseline:MeasuredEvaluationCase[]=[],candidateObservations:MeasuredEvaluationCase[]=[],observed:string[]=[];let ownSubjects=0;
  for(const [index,modules] of ROUTING_CANONICAL_PLANS.entries()){
    const plan=captureTypedModulePlan({version:1,modules});
    const run=async(selected:typeof plan)=>{const started=performance.now(),rows:Awaited<ReturnType<AssistantReadSession['moduleWork']>>[]=[];for(const module of selected.modules)rows.push(await read.moduleWork(module));return{rows,elapsedMs:Math.max(0,performance.now()-started)};};
    // Alternate arm order to avoid systematically warming every candidate after its own control.
    let control:Awaited<ReturnType<typeof run>>,changed:Awaited<ReturnType<typeof run>>;
    if(index%2){changed=await run(applyTypedRouteCandidate(candidate,plan));control=await run(plan);}else{control=await run(plan);changed=await run(applyTypedRouteCandidate(candidate,plan));}
    const normalize=(rows:typeof control.rows)=>[...rows].sort((a,b)=>a.module.localeCompare(b.module));
    const canonical=(rows:typeof control.rows)=>rows.length===modules.length&&rows.every(row=>row.scope==='current-caller'&&modules.some(module=>module===row.module));
    const same=assistantSourceDigest(normalize(control.rows))===assistantSourceDigest(normalize(changed.rows));
    const basePassed=canonical(control.rows),changedPassed=basePassed&&canonical(changed.rows)&&same;
    baseline.push({id:'canonical-'+index,passed:basePassed,securityFailure:!canonical(control.rows),elapsedMs:control.elapsedMs,readCount:control.rows.length,tokens:0,costCredits:0});
    candidateObservations.push({id:'canonical-'+index,passed:changedPassed,securityFailure:!canonical(changed.rows),elapsedMs:changed.elapsedMs,readCount:changed.rows.length,tokens:0,costCredits:0});
    observed.push(assistantSourceDigest(normalize(changed.rows)));
    const own=control.rows.find(row=>row.module==='employees')?.data as {rows?:unknown[]}|undefined;if(Array.isArray(own?.rows))ownSubjects=Math.max(ownSubjects,own.rows.length);
  }
  record('actual-canonical-data-preserved',candidateObservations.every(row=>row.passed),false);
  record('nonempty-authorized-own-fixture',ownSubjects>0,false);
  // Both arms perform the SAME canonical work. A different permutation or lucky timer cannot
  // manufacture an independently better answer and is therefore never promotion evidence.
  const comparison=compareMeasuredQuality(baseline,candidateObservations,ROUTING_CANONICAL_PLANS.length);
  return Object.freeze({version:2,suiteDigest:ROUTING_SUITE_DIGEST,inputDigest:ROUTING_INPUT_DIGEST,coverage:'typed-routing-contract-only',securityFailures,qualityFailures,ownSubjects,
    cases:Object.freeze(cases.map(row=>Object.freeze(row))),observedDigest:assistantSourceDigest(observed),baseline:Object.freeze(baseline.map(row=>Object.freeze(row))),candidate:Object.freeze(candidateObservations.map(row=>Object.freeze(row))),comparison});
}
