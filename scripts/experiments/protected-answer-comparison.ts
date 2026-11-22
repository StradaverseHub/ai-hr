import { adjudicateAssistantAnswerPlan, parseAssistantAnswerPlan, type AssistantAnswerBlock, type AssistantAnswerPlan, type AssistantAnswerRead } from '../../lib/ai/assistant-answer-plan';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import {
  adjudicatePrivateAssistantTerminal, capturePrivateAssistantTask, privateAssistantCatalogue,
  type PrivateAssistantCardSelection, type PrivateAssistantIntent, type PrivateAssistantPayload,
} from '../../lib/ai/provider-assistant-policy';
import type { PilotModel } from '../teras/leave-improvement';

const strategies = ['baseline_v1', 'focused_v1'] as const;
type Answer = Extract<AssistantAnswerPlan, { mode: 'answer' }>;
type Diagnostic =
  | { outcome: 'correct' }
  | { outcome: 'rejected'; reason: 'invalid_plan' | 'outside_catalogue' | 'canonical_rejection' }
  | { outcome: 'wrong_selection'; missing: readonly AssistantAnswerBlock[]; extra: readonly AssistantAnswerBlock[]; orderOnly: boolean };

export type ProtectedAnswerFixture = Readonly<{
  id: string;
  intent: PrivateAssistantIntent;
  reads: readonly AssistantAnswerRead[];
  selected: { selection: readonly PrivateAssistantCardSelection[] };
  expected: unknown;
}>;

/** Report only closed selectors from a successfully adjudicated reply. Discard rejected text. */
function diagnose(text: string, expected: Answer, local: PrivateAssistantPayload, reads: readonly AssistantAnswerRead[]): Diagnostic {
  let selection: AssistantAnswerPlan;
  try {
    selection = adjudicatePrivateAssistantTerminal(text, local);
  } catch {
    try {
      parseAssistantAnswerPlan(text);
      return { outcome: 'rejected', reason: 'outside_catalogue' };
    } catch {
      return { outcome: 'rejected', reason: 'invalid_plan' };
    }
  }
  let plan: AssistantAnswerPlan;
  try {
    plan = adjudicateAssistantAnswerPlan(selection, reads);
  } catch {
    return { outcome: 'rejected', reason: 'canonical_rejection' };
  }
  if (plan.mode !== 'answer') return { outcome: 'rejected', reason: 'outside_catalogue' };
  if (routingDigest(plan) === routingDigest(expected)) return { outcome: 'correct' };
  const observedKeys = new Set(plan.blocks.map(routingDigest));
  const expectedKeys = new Set(expected.blocks.map(routingDigest));
  const missing = expected.blocks.filter(block => !observedKeys.has(routingDigest(block)));
  const extra = plan.blocks.filter(block => !expectedKeys.has(routingDigest(block)));
  return { outcome: 'wrong_selection', missing, extra, orderOnly: missing.length === 0 && extra.length === 0 };
}

export async function evaluateProtectedAnswer(
  fixture: ProtectedAnswerFixture,
  strategy: typeof strategies[number],
  model: PilotModel,
) {
  const expected = adjudicateAssistantAnswerPlan(fixture.expected, fixture.reads);
  if (expected.mode !== 'answer') throw Error('Expected a model-backed answer fixture.');
  const local = privateAssistantCatalogue(fixture.intent, fixture.reads, strategy, fixture.selected.selection);
  const task = capturePrivateAssistantTask(local);
  if (!('turns' in task.args)) throw Error('Expected a protected conversation task.');
  const [turn] = task.args.turns;
  if (task.args.turns.length !== 1 || turn?.role !== 'user' || task.args.tools.length !== 0)
    throw Error('Unexpected protected conversation input.');
  adjudicatePrivateAssistantTerminal(JSON.stringify(expected), local);
  const response = await model({ mode: 'answer', system: task.args.system.join(' '), prompt: turn.content });
  if ([response.inputTokens, response.outputTokens].some(count => !Number.isSafeInteger(count) || count < 0))
    throw Error('Invalid model usage observation.');
  return { diagnostic: diagnose(response.text, expected, local, fixture.reads), inputTokens: response.inputTokens, outputTokens: response.outputTokens };
}

export async function compareProtectedAnswers(fixtures: readonly ProtectedAnswerFixture[], model: PilotModel) {
  const budget = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const comparisons: ({ id: string; strategy: typeof strategies[number] } & Diagnostic)[] = [];
  for (const fixture of fixtures) {
    for (const strategy of strategies) {
      const result = await evaluateProtectedAnswer(fixture, strategy, model);
      budget.calls++;
      budget.inputTokens += result.inputTokens;
      budget.outputTokens += result.outputTokens;
      comparisons.push({ id: fixture.id, strategy, ...result.diagnostic });
    }
  }
  return {
    comparisons,
    strategies: strategies.map(strategy => {
      const rows = comparisons.filter(item => item.strategy === strategy);
      return {
        strategy, cases: rows.length,
        correct: rows.filter(row => row.outcome === 'correct').length,
        rejected: rows.filter(row => row.outcome === 'rejected').length,
        wrongSelection: rows.filter(row => row.outcome === 'wrong_selection').length,
      };
    }),
    budget,
  };
}
