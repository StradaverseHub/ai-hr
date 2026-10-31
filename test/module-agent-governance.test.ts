import { describe, expect, it } from 'vitest';
import { MODULE_CATALOG } from '../packs/catalog';
import { AGENT_MODULE_CODES, isAgentModuleCode, moduleAgentCoverage } from '../lib/ai/module-agents';
// WP11: the test-only improvement model (lib/ai/module-agent-improvement.ts) and orchestrator
// (core/module-agent-orchestrator.ts) were deleted. Plan capture is tested through the production owner;
// promotion governance is tested against the live owner in test/wp11-learning-loop.test.ts.
import { captureTypedModulePlan } from '../lib/ai/module-agent-routing';
describe('canonical module binding and bounded orchestration', () => {
  it('explicitly binds every current catalogue module and refuses future implicit support', () => {
    expect(new Set(AGENT_MODULE_CODES).size).toBe(20);
    expect(moduleAgentCoverage(MODULE_CATALOG).filter(row => row.capability === null)).toEqual([]);
    expect(moduleAgentCoverage([{ code: 'future-module' }])).toEqual([{ code: 'future-module', capability: null }]);
    expect(isAgentModuleCode('future-module')).toBe(false);
  });
  it('captures plans without accepting posted subjects, duplicates or unbounded fanout', () => {
    const modules = ['leave', 'claims'];
    const captured = captureTypedModulePlan({ version: 1, modules });
    modules[0] = 'payroll';
    expect(captured.modules).toEqual(['leave', 'claims']);
    for (const value of [{ version: 1, modules: ['leave', 'leave'] },
      { version: 1, modules: ['leave'], employeeId: 'other' },
      { version: 1, modules: ['future-module'] }, { version: 1, modules: [...AGENT_MODULE_CODES] }]) {
      expect(() => captureTypedModulePlan(value)).toThrow();
    }
  });
});
