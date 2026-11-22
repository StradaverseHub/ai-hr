import { routingDigest } from '../../lib/ai/module-agent-routing';
import type { PilotModel } from '../teras/leave-improvement';
import { evaluateProtectedAnswer, type ProtectedAnswerFixture } from './protected-answer-comparison';
import { protectedWorkSummarySplits } from './protected-work-summary-comparison';
import { guidanceOptions, guidanceContractDigest, isGuidance, protectedStrategyDigest, withProtectedGuidance, type Guidance } from './protected-work-summary-guidance';
export const protectedGuidanceProposalSchema = Object.freeze({
  type: 'object', additionalProperties: false, required: ['add'],
  properties: { add: { type: 'string', enum: Object.keys(guidanceOptions) } },
});

function captureProposal(text: string, current: readonly Guidance[]): Guidance | null {
  try {
    const proposal = JSON.parse(text);
    if (!proposal || Object.keys(proposal).join() !== 'add' || !isGuidance(proposal.add) || current.includes(proposal.add)) return null;
    return proposal.add;
  } catch {
    return null;
  }
}

/** Fictional offline experiment. Model suggestions select source-defined guidance
 * only. Results have no serving, approval or promotion authority. */
export async function runProtectedWorkSummaryImprovement(model: PilotModel) {
  const { development, validation } = protectedWorkSummarySplits();
  const maxRounds = 2;
  const maxCalls = validation.length + maxRounds * (development.length + 1 + validation.length);
  const budget = { maxRounds, maxCalls, calls: 0, inputTokens: 0, outputTokens: 0 };
  const call: PilotModel = async request => {
    if (budget.calls >= maxCalls) throw Error('Protected improvement call budget exhausted.');
    budget.calls++;
    const response = await model(request);
    if ([response.inputTokens, response.outputTokens].some(count => !Number.isSafeInteger(count) || count < 0))
      throw Error('Invalid model usage observation.');
    budget.inputTokens += response.inputTokens;
    budget.outputTokens += response.outputTokens;
    return response;
  };
  async function score(cases: readonly ProtectedAnswerFixture[], rules: readonly Guidance[]) {
    const diagnostics = [];
    const answer = withProtectedGuidance(call, rules);
    for (const fixture of cases) {
      const result = await evaluateProtectedAnswer(fixture, 'baseline_v1', answer);
      diagnostics.push({ id: fixture.id, intent: fixture.intent, ...result.diagnostic });
    }
    return {
      diagnostics, correct: diagnostics.filter(row => row.outcome === 'correct').length,
      rejected: diagnostics.filter(row => row.outcome === 'rejected').length,
    };
  }

  const contractDigest = guidanceContractDigest;
  const strategyDigest = protectedStrategyDigest;
  const baseline = await score(validation, []);
  let parent: { rules: readonly Guidance[]; score: typeof baseline } = { rules: [], score: baseline };
  const rounds = [];
  for (let number = 1; number <= maxRounds && parent.score.correct < validation.length; number++) {
    const discovery = await score(development, parent.rules);
    const feedback = discovery.diagnostics.flatMap(row => {
      if (row.outcome === 'correct') return [];
      return [{ intent: row.intent, outcome: row.outcome,
        ...(row.outcome === 'rejected' ? { reason: row.reason } : {
          missingFacts: row.missing.filter(block => block.kind === 'fact').length,
          missingExplanations: row.missing.filter(block => block.kind === 'explanation').length,
          extra: row.extra.length, orderOnly: row.orderOnly,
        }),
      }];
    });
    if (!feedback.length) break;
    const response = await call({
      mode: 'revise',
      system: 'Suggest one additional guidance option for the protected answer selector. Use only the supplied development diagnostics. Return exactly one JSON object {"add":"option_key"}. Choose a listed option absent from current.',
      prompt: JSON.stringify({ options: guidanceOptions, current: parent.rules, feedback }),
    });
    const add = captureProposal(response.text, parent.rules);
    const parentDigest = strategyDigest(parent.rules);
    if (!add) {
      rounds.push({ number, parentDigest, decision: 'no_valid_proposal' });
      break;
    }
    const rules = [...parent.rules, add];
    const proposed = await score(validation, rules);
    const regressions = parent.score.diagnostics.filter((row, index) =>
      row.outcome === 'correct' && proposed.diagnostics[index].outcome !== 'correct').length;
    const accepted = proposed.rejected === 0 && regressions === 0 && proposed.correct > parent.score.correct;
    rounds.push({ number, parentDigest, candidateDigest: strategyDigest(rules), add,
      validation: { correct: proposed.correct, rejected: proposed.rejected, regressions }, decision: accepted ? 'advanced_in_development' : 'retained_parent',
    });
    if (!accepted) break;
    parent = { rules, score: proposed };
  }
  return {
    evidence: 'offline_protected_selection_development', contractDigest,
    developmentDigest: routingDigest(development), validationDigest: routingDigest(validation),
    baseline: { digest: strategyDigest([]), correct: baseline.correct, rejected: baseline.rejected },
    rounds, selected: { digest: strategyDigest(parent.rules), rules: parent.rules, correct: parent.score.correct, rejected: parent.score.rejected }, budget,
  };
}
