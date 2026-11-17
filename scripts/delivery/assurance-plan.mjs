/** Advisory design prototype. Cannot run checks, authorize exposure or deploy. */
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const EFFECTS = new Set(['presentation', 'private-read', 'business-write', 'money-calculation',
  'money-finalization', 'access-change', 'schema-change', 'external-message', 'destructive-write']);
const SHA = /^[a-f0-9]{40}$/;
function assert(ok, message) { if (!ok) throw new Error(message); }
function exact(value, keys, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  assert(Object.keys(value).sort().join(',') === [...keys].sort().join(','), `${name} fields differ`);
}
function text(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 2000; }

export function validateContract(c) {
  exact(c, ['schemaVersion', 'changeId', 'sourceSha', 'baseSha', 'effects', 'scope', 'acceptance', 'recovery', 'observability'], 'contract');
  assert(c.schemaVersion === 1 && text(c.changeId), 'Invalid contract identity');
  assert(SHA.test(c.sourceSha) && SHA.test(c.baseSha), 'Exact source and baseline SHAs required');
  assert(Array.isArray(c.effects) && c.effects.length > 0 && c.effects.length <= EFFECTS.size &&
    new Set(c.effects).size === c.effects.length && c.effects.every(e => EFFECTS.has(e)), 'Invalid effects');
  exact(c.scope, ['status', 'author', 'reviewer'], 'scope');
  assert(['unknown', 'bounded'].includes(c.scope.status) && text(c.scope.author) &&
    (c.scope.reviewer === null || text(c.scope.reviewer)), 'Invalid scope');
  exact(c.acceptance, ['revision', 'approvedRevision', 'criteria'], 'acceptance');
  assert(Number.isSafeInteger(c.acceptance.revision) && c.acceptance.revision > 0 &&
    (c.acceptance.approvedRevision === null || Number.isSafeInteger(c.acceptance.approvedRevision) && c.acceptance.approvedRevision > 0), 'Invalid approval revision');
  assert(Array.isArray(c.acceptance.criteria) && c.acceptance.criteria.length > 0 &&
    c.acceptance.criteria.length <= 50 && c.acceptance.criteria.every(text), 'Observable acceptance criteria required');
  assert(['reversible', 'forward-repair', 'unknown'].includes(c.recovery), 'Invalid recovery strategy');
  assert(['defined', 'unknown'].includes(c.observability), 'Invalid observability');
  return c;
}

export function planAssurance(input) {
  const c = validateContract(input), obligations = new Map(), holds = [];
  function require(id, stage, reason) {
    const prior = obligations.get(id) ?? {id, stage, reasons: []};
    if (!prior.reasons.includes(reason)) prior.reasons.push(reason);
    obligations.set(id, prior);
  }
  // The supplied assertions are NOT authenticated evidence, even when they say "bounded".
  require('scope-provenance', 'before-exposure', 'Independently verify the complete diff, dependency reach, effect inventory and reviewer identity.');
  require('acceptance-reproduction', 'during-development', 'Exercise each approved criterion; reproduce reported defects before fixing them.');
  require('artifact-integrity', 'before-installation', 'Bind strict compilation, build and dependency checks to the exact source, runtime and promoted artifact.');
  require('independent-acceptance', 'before-exposure', 'A non-author checks the actual user journey against independent expected results.');
  require('broad-regression-audit', 'continuous', 'Challenge selection with broad regression and historical defect replay; investigate every unexplained disagreement.');
  if (c.scope.status !== 'bounded' || !c.scope.reviewer || c.scope.reviewer === c.scope.author) {
    holds.push('independent-scope-review');
    require('scope-discovery', 'before-exposure', 'Unknown or self-reviewed reach needs investigation; an agent cannot declare itself low risk.');
  }
  if (c.acceptance.approvedRevision !== c.acceptance.revision) holds.push('current-reporter-approval');
  if (c.recovery === 'unknown') holds.push('recovery-design');
  if (c.observability === 'unknown') holds.push('outcome-signals');

  const rules = {
    presentation: [
      ['rendered-journey', 'before-exposure', 'Verify intended rendering, accessibility and interactions.'],
    ],
    'private-read': [
      ['isolation-proof', 'before-exposure', 'Exercise denied access, role/scope boundaries and cross-tenant leakage.'],
      ['read-shape', 'before-exposure', 'Check order/count equivalence and realistic multi-company query shape.'],
    ],
    'business-write': [
      ['write-invariants', 'before-exposure', 'Check authorization, transaction invariants, concurrency, idempotency and audit events.'],
    ],
    'money-calculation': [
      ['financial-oracle', 'before-exposure', 'Compare exact values against independently approved expected outcomes and statutory boundary cases.'],
      ['side-effect-free-replay', 'before-exposure', 'Compare on authorized fixtures with writes, payment and external effects disabled.'],
    ],
    'money-finalization': [
      ['financial-oracle', 'before-exposure', 'Compare exact values against independently approved expected outcomes and statutory boundary cases.'],
      ['finalization-control', 'before-irreversible-action', 'Enforce reconciliation, authorized human approval, durable idempotency and immutable finalization audit.'],
    ],
    'access-change': [
      ['isolation-proof', 'before-exposure', 'Exercise denied access, role/scope boundaries and cross-tenant leakage.'],
      ['grant-control', 'before-irreversible-action', 'Enforce authorized grant changes and session/revocation behavior; rollback cannot undo disclosure.'],
    ],
    'schema-change': [
      ['migration-proof', 'before-installation', 'Rehearse populated upgrades as restricted owner; verify ordered hashes, grants and mixed-version compatibility.'],
      ['schema-recovery', 'before-irreversible-action', 'Prove backup/restore or forward repair; a code rollback does not reverse a schema change.'],
    ],
    'external-message': [
      ['delivery-control', 'before-irreversible-action', 'Enforce recipient authorization, reviewed channel policy, outbox deduplication and bounded redelivery.'],
    ],
    'destructive-write': [
      ['destruction-control', 'before-irreversible-action', 'Check authority, retention, affected-row preview and verified recovery before destructive writes.'],
    ],
  };
  for (const effect of [...c.effects].sort()) for (const rule of rules[effect]) require(...rule);
  const irreversible = c.effects.some(e => ['money-finalization', 'access-change', 'schema-change', 'external-message', 'destructive-write'].includes(e));
  require('exposure-observation', 'during-exposure', 'Evaluate business outcomes and service signals against a control; insufficient samples do not mean success.');
  const sorted = [...obligations.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const o of sorted) o.reasons.sort();
  return {
    kind: 'ADVISORY_ASSURANCE_PLAN', policyVersion: 'delivery-v2-prototype/1',
    sourceSha: c.sourceSha, baseSha: c.baseSha, changeId: c.changeId,
    mode: 'shadow', inputTrust: 'UNAUTHENTICATED_PROPOSAL',
    disposition: holds.length ? 'needs-design-or-clarification' : 'ready-for-evidence-design',
    holds: holds.sort(), obligations: sorted,
    exposure: irreversible ? 'requires-pre-effect-controls' : 'candidate-for-bounded-rollout',
    evidenceVerified: false, releaseAuthorized: false, exposureAuthorized: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert(process.argv.length === 2, 'Usage: node scripts/delivery/assurance-plan.mjs < contract.json');
    const bytes = readFileSync(0);
    assert(bytes.length <= 128 * 1024, 'Contract exceeds 128 KiB');
    process.stdout.write(JSON.stringify(planAssurance(JSON.parse(bytes.toString('utf8'))), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`Assurance planning refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
