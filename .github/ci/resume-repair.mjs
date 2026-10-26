/** Repair scheduling only. Original reports retain their SHA; no CI v2 release authority is changed. */
import {isDeepStrictEqual} from 'node:util';
import {hash, requiredEvidence} from './manifest.mjs';
import {assessResumeCoverage} from './resume-assessment.mjs';
import {assessResumeSource} from './resume-source.mjs';
const fail = reason => {throw Error('Repair assessment refused: ' + reason);};
const safePath = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/')
  && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..');

/**
 * Both plans and impactContext MUST be independently reconstructed from Git source by the caller.
 * This assessor authenticates no API snapshots and proves no dependency graph/ancestry on its own.
 */
export function assessRepairCoverage({sourceEvidence, candidatePlan, candidate, impactContext}) {
  const original = assessResumeSource(sourceEvidence), sourcePlan = sourceEvidence.expectedPlan;
  const expected = {...sourceEvidence.expected, candidate};
  assessResumeCoverage({expectedPlan: candidatePlan, expected, reports: []});
  if (candidate === sourcePlan.sha) fail('a repair requires a different candidate');
  if (!isDeepStrictEqual(candidatePlan.runtime, sourcePlan.runtime)
    || !isDeepStrictEqual(candidatePlan.execution, sourcePlan.execution)) fail('changed execution environment');
  if (impactContext?.base !== sourcePlan.sha || impactContext?.head !== candidate
    || impactContext.controller !== candidatePlan.controller) fail('impact belongs to another delta/controller');
  if (!['baseTree', 'headTree'].every(key => /^[a-f0-9]{40}$/.test(impactContext[key] ?? ''))
    || impactContext.snapshotSource !== 'IMMUTABLE_GIT_OBJECTS'
    || impactContext.sourceInputsFingerprint !== hash({baseTree: impactContext.baseTree, headTree: impactContext.headTree,
      controller: impactContext.controller, impactPolicy: 3})) fail('missing immutable source input binding');
  const impact = impactContext.plan;
  if (!impact || impact.policyVersion !== 3 || !['full', 'impact'].includes(impact.tier)
    || !['low', 'moderate', 'high', 'unknown'].includes(impact.risk)) fail('unknown impact policy');
  const {fingerprint, ...body} = impact;
  if (fingerprint !== hash(body)) fail('altered impact plan');
  if (!Array.isArray(impact.changed) || !impact.changed.length || !impact.changed.every(safePath)
    || new Set(impact.changed).size !== impact.changed.length || !Array.isArray(impact.classifications)
    || !isDeepStrictEqual(impact.classifications.map(c => c.path).sort(), [...impact.changed].sort()))
    fail('incomplete impact classification');
  if (!Array.isArray(impact.reasons) || !Array.isArray(impact.run) || !impact.run.every(path => candidatePlan.suite.includes(path))
    || new Set(impact.run).size !== impact.run.length || !impact.selection
    || !isDeepStrictEqual(Object.keys(impact.selection).sort(), [...impact.run].sort()) || typeof impact.browser !== 'boolean')
    fail('incomplete impact selection');
  for (const classification of impact.classifications)
    if (!['low', 'moderate', 'high', 'unknown'].includes(classification.risk)
      || !Array.isArray(classification.uncertainties)) fail('invalid classification');
  if (impact.tier === 'impact' && (impact.reasons.length || ['high', 'unknown'].includes(impact.risk)
    || impact.classifications.some(c => ['high', 'unknown'].includes(c.risk) || c.uncertainties.length)))
    fail('impact plan contradicts mandatory full policy');

  const mustRun = new Set([...impact.run, ...impact.changed.filter(path => candidatePlan.suite.includes(path))]);
  // Keep browser invalidation conservative even if a caller supplies a contradictory false flag.
  const freshBrowser = impact.browser || impact.changed.some(path => /\.(tsx|css)$/.test(path) || path.startsWith('public/'));
  const sourceUnits = new Map(sourcePlan.units.map(unit => [unit.id, unit]));
  const passed = new Map(original.reusable.map(unit => [unit.id, unit]));
  const failed = new Map(original.rerun.map(unit => [unit.id, unit.reason]));
  const carry = [], fresh = [];
  for (const unit of candidatePlan.units) {
    const previous = sourceUnits.get(unit.id), witness = passed.get(unit.id);
    let reason;
    if (impact.tier === 'full') reason = 'Impact policy requires complete fresh verification';
    else if (!previous || !isDeepStrictEqual(previous, unit)) reason = 'New or changed unit coverage';
    else if (!witness) reason = 'Previous unit requires fresh verification: ' + (failed.get(unit.id) ?? 'missing evidence');
    else if (unit.files.some(path => mustRun.has(path))) reason = 'Changed, transitive, guard or learned-failure selection';
    else if (unit.kind === 'browser' && freshBrowser) reason = 'Browser experience affected';
    if (reason) fresh.push({id: unit.id, reason});
    else carry.push({id: unit.id, candidateSha: candidate, original: {sha: sourcePlan.sha,
      fingerprint: sourcePlan.fingerprint, reportHash: witness.reportHash, source: witness.source},
      files: witness.files, tests: witness.tests});
  }
  const required = requiredEvidence(candidatePlan);
  if (carry.length + fresh.length !== required.units.length) fail('incomplete candidate coverage');
  return {kind: 'REPAIR_COVERAGE_ASSESSMENT_NOT_RELEASE_EVIDENCE', releaseAuthorized: false,
    sourceSha: sourcePlan.sha, candidateSha: candidate, controller: candidatePlan.controller,
    baseline: candidatePlan.migrationBase, candidateFingerprint: candidatePlan.fingerprint,
    impactFingerprint: impact.fingerprint, impactTier: impact.tier, sourceInputsFingerprint: impactContext.sourceInputsFingerprint,
    requiresIndependentlyRecomputedImpact: true, requiresGitAncestryAndInputRevalidation: true,
    requiresFreshGitHubApiAndLatestFailureHistoryValidation: true,
    requiresVersionedResumeWorkflowAndIndependentReleaseValidation: true,
    completeRequiredUnits: required.units, carry, fresh, freshPrerequisites: original.freshPrerequisites,
    originalFailureObservations: original.observations, sourceRun: original.sourceRun,
    finalVerificationRequired: true};
}
