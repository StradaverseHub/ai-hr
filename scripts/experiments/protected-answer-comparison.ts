import { adjudicateAssistantAnswerPlan, type AssistantAnswerRead } from '../../lib/ai/assistant-answer-plan';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import {
  adjudicatePrivateAssistantTerminal, capturePrivateAssistantTask, privateAssistantCatalogue,
  type PrivateAssistantCardSelection, type PrivateAssistantIntent,
} from '../../lib/ai/provider-assistant-policy';
import type { PilotModel } from '../teras/leave-improvement';

const strategies = ['baseline_v1', 'focused_v1'] as const;
type Outcome = 'rejected' | 'correct' | 'wrong_selection';

type ProtectedAnswerFixture = Readonly<{
  id: string;
  intent: PrivateAssistantIntent;
  reads: readonly AssistantAnswerRead[];
  selected: { selection: readonly PrivateAssistantCardSelection[] };
  expected: unknown;
}>;

export async function compareProtectedAnswers(fixtures: readonly ProtectedAnswerFixture[], model: PilotModel) {
  const budget = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const comparisons: { id: string; strategy: typeof strategies[number]; outcome: Outcome }[] = [];
  for (const fixture of fixtures) {
    const expected = adjudicateAssistantAnswerPlan(fixture.expected, fixture.reads);
    for (const strategy of strategies) {
      const local = privateAssistantCatalogue(fixture.intent, fixture.reads, strategy, fixture.selected.selection);
      const task = capturePrivateAssistantTask(local);
      if (!('turns' in task.args)) throw Error('Expected a protected conversation task.');
      const [turn] = task.args.turns;
      if (task.args.turns.length !== 1 || turn?.role !== 'user' || task.args.tools.length !== 0)
        throw Error('Unexpected protected conversation input.');
      // Reject an invalid expectation before spending a call. Only cases that
      // actually reach model selection belong in this comparison.
      if (expected.mode !== 'answer') throw Error('Expected a model-backed answer fixture.');
      adjudicatePrivateAssistantTerminal(JSON.stringify(expected), local);
      const response = await model({ mode: 'answer', system: task.args.system.join(' '), prompt: turn.content });
      if ([response.inputTokens, response.outputTokens].some(count => !Number.isSafeInteger(count) || count < 0))
        throw Error('Invalid model usage observation.');
      budget.calls++;
      budget.inputTokens += response.inputTokens;
      budget.outputTokens += response.outputTokens;
      let outcome: Outcome;
      try {
        const plan = adjudicateAssistantAnswerPlan(adjudicatePrivateAssistantTerminal(response.text, local), fixture.reads);
        outcome = routingDigest(plan) === routingDigest(expected) ? 'correct' : 'wrong_selection';
      } catch {
        outcome = 'rejected';
      }
      comparisons.push({ id: fixture.id, strategy, outcome });
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
