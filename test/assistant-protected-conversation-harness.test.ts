import { describe, expect, it, vi } from 'vitest';
import type { ResolvedAiConfig } from '../lib/ai/types';
import { ASSISTANT_CONVERSATION_HOLDOUTS } from '../lib/ai/assistant-conversation-holdouts';
import { scoreAssistantConversationTrial, type ConversationArm } from '../lib/ai/assistant-conversation-candidate';
import { executeAssistantConversationHoldout, type ConversationHarnessCheckpoint } from '../core/assistant-conversation-harness';

const { converse } = vi.hoisted(() => ({ converse: vi.fn() }));
vi.mock('../lib/ai', () => ({ converse }));
vi.mock('../core/assistant-tools', () => ({ ASSISTANT_TOOLS: [] }));
vi.mock('../core/ai-governance', async () => {
  const { getProviderWorkloadDescriptor } = await import('../lib/ai/provider-workload-policy');
  return {
    withAiAdmissionLifecycle: (configuration: ResolvedAiConfig) => configuration,
    preparePrivateAiTask: async (configuration: ResolvedAiConfig, contract: string, source: () => Promise<unknown>) => {
      const descriptor = getProviderWorkloadDescriptor(contract);
      if (!descriptor) throw Error('Expected the registered fixture contract');
      return { operation: descriptor.operation, configuration, ...descriptor.capture(await source()), dispose: () => {} };
    },
  };
});

describe('protected conversation evaluation harness', () => {
  it('makes one closed call per protected arm and fails an attempted tool call without dispatching it', async () => {
    const binding = { candidateDigest: 'a'.repeat(64), providerFingerprint: 'b'.repeat(64) };
    const protectedCases = ASSISTANT_CONVERSATION_HOLDOUTS.filter(fixture => fixture.protectedSelection);
    const prior: ConversationArm[] = ASSISTANT_CONVERSATION_HOLDOUTS.filter(fixture => !fixture.protectedSelection)
      .flatMap(fixture => (['baseline', 'candidate'] as const).map(arm => ({
        arm, ...binding, case: scoreAssistantConversationTrial(fixture, {
          terminal: JSON.stringify(fixture.expected), reads: fixture.reads, tools: fixture.expectedTools,
          observation: { elapsedMs: null, inputTokens: null, outputTokens: null, costCredits: null },
        }),
      })));
    converse.mockImplementation(async (_configuration, args) => {
      expect(args.tools).toEqual([]);
      expect(args.turns).toHaveLength(1);
      const input = JSON.parse(args.turns[0].content);
      const fixture = protectedCases.find(row => row.protectedIntent === input.intent)!;
      expect(args.turns[0].content).not.toContain(fixture.question);
      const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
      if (input.intent === 'attendance' && input.strategy === 'baseline_v1')
        return { text: '', stop: 'tool_use', toolCalls: [{ id: 'wrong', name: 'foreign_read', input: { marker: 'raw marker' } }], usage };
      return { text: JSON.stringify(fixture.expected), stop: 'end', toolCalls: [], usage };
    });
    const checkpoints: ConversationHarnessCheckpoint[] = [];
    const run = await executeAssistantConversationHoldout(
      { kind: 'assistant_answer_prompt_v1', variant: 'focused_v1' }, {} as ResolvedAiConfig, binding, prior,
      async arm => { checkpoints.push(arm); },
    );
    expect(run).toEqual({ attemptedCalls: 8, completedArms: 8, unavailable: 0 });
    expect(converse).toHaveBeenCalledTimes(8);
    expect(checkpoints.every(arm => arm.calls === 1)).toBe(true);
    expect(checkpoints.filter(arm => !arm.case.passed)).toEqual([
      expect.objectContaining({ arm: 'baseline', case: expect.objectContaining({
        id: 'en:protected:attendance', securityFailure: true, plan: null, tools: [{ name: 'unavailable_source', input: null }],
      }) }),
    ]);
    expect(JSON.stringify(checkpoints)).not.toContain('raw marker');
  });
});
