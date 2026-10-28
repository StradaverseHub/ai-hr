import { describe, expect, it } from 'vitest';
import { MODULE_CATALOG } from '../packs/catalog';
import { AGENT_MODULE_CODES, isAgentModuleCode, moduleAgentCoverage } from '../lib/ai/module-agents';
import { createAgentCandidate, promoteAgentCandidate, selectAgentVersion, type IndependentEvaluation } from '../lib/ai/module-agent-improvement';
import { captureModuleReadPlan } from '../core/module-agent-orchestrator';
const scope = { tenantId: 'tenant-a', userId: 'caller-a', module: 'leave' as const };
const candidate = () => createAgentCandidate(scope, 'author', 'baseline', 2, {
  promptDigest: 'prompt', routingDigest: 'route', engineContractDigest: 'engine',
});
const evaluation = (evaluatorId: string): IndependentEvaluation => ({ candidateDigest: candidate().digest,
  evaluatorId, suiteDigest: 'independent-suite', heldOut: true, securityFailures: 0,
  qualityFailures: 0, verifiedOutcomes: 5, completed: true });
const now = '2026-10-26T00:00:00Z';
const until = '2026-10-26T01:00:00Z';
describe('canonical module binding and bounded orchestration', () => {
  it('explicitly binds every current catalogue module and refuses future implicit support', () => {
    expect(new Set(AGENT_MODULE_CODES).size).toBe(20);
    expect(moduleAgentCoverage(MODULE_CATALOG).filter(row => row.capability === null)).toEqual([]);
    expect(moduleAgentCoverage([{ code: 'future-module' }])).toEqual([{ code: 'future-module', capability: null }]);
    expect(isAgentModuleCode('future-module')).toBe(false);
  });
  it('captures plans without accepting posted subjects, duplicates or unbounded fanout', () => {
    const modules = ['leave', 'claims'];
    const captured = captureModuleReadPlan({ version: 1, modules });
    modules[0] = 'payroll';
    expect(captured.modules).toEqual(['leave', 'claims']);
    for (const value of [{ version: 1, modules: ['leave', 'leave'] },
      { version: 1, modules: ['leave'], employeeId: 'other' },
      { version: 1, modules: ['future-module'] }, { version: 1, modules: [...AGENT_MODULE_CODES] }]) {
      expect(() => captureModuleReadPlan(value)).toThrow();
    }
  });
});
describe('governed independent promotion and rollback', () => {
  const promote = (rows: readonly IndependentEvaluation[], caller = { ...scope, approverId: 'approver' }) =>
    promoteAgentCandidate(candidate(), caller, rows, { maxJobs: 10, expiresAt: until }, now);
  it('requires two independent held-out completed evaluations and zero security/quality failures', () => {
    expect(() => promote([evaluation('reviewer-a')])).toThrow();
    for (const patch of [{ evaluatorId: 'author' }, { heldOut: false }, { completed: false },
      { securityFailures: 1 }, { qualityFailures: 1 }, { verifiedOutcomes: 0 }, { candidateDigest: 'other' }]) {
      expect(() => promote([evaluation('reviewer-a'), { ...evaluation('reviewer-b'), ...patch } as IndependentEvaluation])).toThrow();
    }
    expect(() => promote([evaluation('reviewer-a'), evaluation('reviewer-a')])).toThrow();
    expect(() => promote([evaluation('reviewer-a'), evaluation('reviewer-b')], { ...scope, userId: 'other', approverId: 'approver' })).toThrow();
  });
  it('bounds jobs/time and rolls back on regression, expiry or human rollback', () => {
    const receipt = promote([evaluation('reviewer-a'), evaluation('reviewer-b')]);
    const healthy = { jobs: 0, securityFailures: 0, qualityFailures: 0, rolledBack: false };
    expect(selectAgentVersion(receipt, healthy, now)).toEqual({ digest: candidate().digest, state: 'promoted' });
    for (const patch of [{ jobs: 10 }, { jobs: -1 }, { securityFailures: 1 }, { qualityFailures: 1 }, { rolledBack: true }]) {
      expect(selectAgentVersion(receipt, { ...healthy, ...patch }, now)).toEqual({ digest: 'baseline', state: 'rolled_back' });
    }
    expect(selectAgentVersion(receipt, healthy, until).state).toBe('rolled_back');
  });
});
