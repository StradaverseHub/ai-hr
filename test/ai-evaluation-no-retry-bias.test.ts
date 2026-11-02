/** Test the evaluator's accounting, not real-model task quality. */
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../lib/ai', () => ({ generateDraft: vi.fn() }));
vi.mock('../core/ai-governance', () => ({
 withAiAdmissionLifecycle: (configuration: unknown) => configuration,
 preparePrivateAiTask: async (configuration: unknown, id: string, read: () => Promise<unknown>) => {
  const { getProviderWorkloadDescriptor } = await import('../lib/ai/provider-workload-policy');
  const descriptor = getProviderWorkloadDescriptor(id)!;
  return { configuration, operation: descriptor.operation, ...descriptor.capture(await read()), dispose() {} };
 },
}));
import { generateDraft } from '../lib/ai';
import { executePromptHoldout, type PromptHoldoutReport } from '../core/module-agent-prompt-harness';
import { PROMPT_HOLDOUTS, PROMPT_HOLDOUT_REQUEST_LIMIT, PROMPT_BASELINE, promptCandidateSystem } from '../lib/ai/module-agent-prompt-candidate';
import { ASSISTANT_CONVERSATION_HOLDOUTS } from '../lib/ai/assistant-conversation-holdouts';
import { nextAssistantConversationArms, scoreAssistantConversationTrial, compareAssistantConversationArms, type ConversationArm } from '../lib/ai/assistant-conversation-candidate';
import { routingDigest } from '../lib/ai/module-agent-routing';
import type { ResolvedAiConfig } from '../lib/ai/types';
const generated = vi.mocked(generateDraft);
const candidate = { kind: 'read_plan_prompt_v1', variant: 'explicit_scope_v1' };
const config: ResolvedAiConfig = { provider: 'openai', model: 'fictional-evaluation', apiKey: 'fictional-not-a-secret' };
const correct = (question: string) => { const expected = PROMPT_HOLDOUTS.find(row => row.question === question)!; return JSON.stringify({ decision: expected.decision, modules: expected.modules }); };
beforeEach(() => { generated.mockReset(); });
it('cannot turn a valid wrong answer into perfect reliability by resuming with a now-correct provider', async () => {
 const fixture = PROMPT_HOLDOUTS.find(row => row.id === 'reject-peer')!;
 generated.mockImplementation(async (_configuration, args) => args.prompt === fixture.question && args.system !== promptCandidateSystem(PROMPT_BASELINE) ? JSON.stringify({ decision: 'read', modules: ['payroll'] }) : correct(args.prompt));
 let report: PromptHoldoutReport | undefined;
 for (let n = 0; n <= Math.ceil(PROMPT_HOLDOUTS.length * 2 / PROMPT_HOLDOUT_REQUEST_LIMIT); n++) {
  report = await executePromptHoldout(candidate, config, report);
  if (report.state === 'complete') break;
 }
 expect(report?.state).toBe('complete');
 const failure = report!.cases.find(row => row.id === fixture.id && row.arm === 'candidate');
 expect(failure?.state).toBe('failed');
 generated.mockClear(); generated.mockImplementation(async (_configuration, args) => correct(args.prompt));
 for (let repeat = 0; repeat < 3; repeat++) {
  report = await executePromptHoldout(candidate, config, report);
  expect(report.cases.find(row => row.id === fixture.id && row.arm === 'candidate')?.outputDigest).toBe(failure?.outputDigest);
  expect(report.qualityFailures).toBe(1);
  expect(report.securityFailures).toBe(1);
  expect(report.comparison.candidate.correct).toBe(PROMPT_HOLDOUTS.length - 1);
 }
 expect(generated).not.toHaveBeenCalled();
});
it('keeps completed conversation failures measured and schedules only genuinely unrun arms', () => {
 const cases = ASSISTANT_CONVERSATION_HOLDOUTS.slice(0, 2);
 const binding = { candidateDigest: routingDigest('fixed-candidate'), providerFingerprint: routingDigest('fixed-provider') };
 const arms: ConversationArm[] = cases.flatMap(row => (['baseline', 'candidate'] as const).map(arm => ({ arm, ...binding, case: scoreAssistantConversationTrial(row, {
  terminal: arm === 'candidate' && row.id === cases[0].id ? 'invalid' : JSON.stringify(row.expected),
  reads: row.reads, tools: row.expectedTools, observation: { elapsedMs: 10, inputTokens: null, outputTokens: null, costCredits: null },
 }) })));
 expect(compareAssistantConversationArms(cases, arms, binding).candidate.correct).toBe(1);
 expect(nextAssistantConversationArms(cases, arms, binding)).toEqual([]);
 const partial = arms.slice(0, 2);
 expect(nextAssistantConversationArms(cases, partial, binding)).toEqual([{ id: cases[1].id, arm: 'baseline' }, { id: cases[1].id, arm: 'candidate' }]);
});
