// Offline development experiment for answer selection after a canonical read.
import { adjudicateAssistantAnswerPlan, parseAssistantAnswerPlan } from '../../lib/ai/assistant-answer-plan';
import { ASSISTANT_CONVERSATION_BASELINE, ASSISTANT_CONVERSATION_ENGINE_DIGEST, assistantConversationCandidateSystem } from '../../lib/ai/assistant-conversation-candidate';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import { ASSISTANT_CONVERSATION_HOLDOUTS, type AssistantConversationHoldout } from '../../lib/ai/assistant-conversation-holdouts';

const validator = assistantConversationCandidateSystem(ASSISTANT_CONVERSATION_BASELINE);
const humanRevision = assistantConversationCandidateSystem({ kind: 'assistant_answer_prompt_v1', variant: 'focused_v1' });
const baselineFocus = '';
const development = ASSISTANT_CONVERSATION_HOLDOUTS.filter(row => row.id.endsWith(':domain:leave'));
const validation = ASSISTANT_CONVERSATION_HOLDOUTS.filter(row =>
  /:(leave_canonical_why|clarify:leave_type|unsupported|privacy:0)$/.test(row.id)
);

type Mode = 'answer' | 'revise';
export type PilotModel = (request: Readonly<{ mode: Mode; system: string; prompt: string }>) => Promise<{
  text: string; inputTokens: number; outputTokens: number;
}>;

function readOutcome(row: AssistantConversationHoldout, text: string) {
  try {
    const plan = adjudicateAssistantAnswerPlan(parseAssistantAnswerPlan(text), row.reads);
    if (routingDigest(plan) === routingDigest(row.expected)) return { id: row.id, outcome: 'correct' } as const;
    return { id: row.id, outcome: row.security ? 'security_failure' : 'wrong_plan' } as const;
  } catch {
    return { id: row.id, outcome: row.security ? 'security_failure' : 'invalid_plan' } as const;
  }
}

function focusFrom(text: string): string | null {
  try {
    const value = JSON.parse(text);
    if (!value || Object.keys(value).join() !== 'focus' || typeof value.focus !== 'string') return null;
    const focus = value.focus.trim();
    return focus.length > 0 && focus.length <= 600 ? focus : null;
  } catch {
    return null;
  }
}

export async function runLeaveImprovement(model: PilotModel) {
  if (development.length !== 6 || validation.length !== 24) throw Error('Leave experiment fixture roster changed.');
  const maxRounds = 2;
  const maxCalls = (2 + maxRounds) * validation.length + maxRounds * (development.length + 1);
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const started = performance.now();

  async function call(mode: Mode, system: string, prompt: string) {
    if (usage.calls >= maxCalls) throw Error('Leave experiment call limit reached.');
    usage.calls++;
    const result = await model({ mode, system, prompt });
    if ([result.inputTokens, result.outputTokens].some(count => !Number.isSafeInteger(count) || count < 0))
      throw Error('Invalid model usage observation.');
    usage.inputTokens += result.inputTokens;
    usage.outputTokens += result.outputTokens;
    return result.text;
  }

  async function score(suite: readonly AssistantConversationHoldout[], system: string) {
    const outcomes = [];
    for (const row of suite) {
      const text = await call('answer', system, JSON.stringify({
        question: row.question, locale: row.locale, verifiedReads: row.reads,
      }));
      outcomes.push(readOutcome(row, text));
    }
    return {
      outcomes,
      correct: outcomes.filter(row => row.outcome === 'correct').length,
      securityFailures: outcomes.filter(row => row.outcome === 'security_failure').length,
    };
  }

  const withFocus = (focus: string) => focus ? validator + '\nOptional answer-selection guidance: ' + focus : validator;
  const baseline = await score(validation, withFocus(baselineFocus));
  const manual = await score(validation, humanRevision);
  let parent = { focus: baselineFocus, validation: baseline };
  const rounds = [];
  for (let round = 1; round <= maxRounds; round++) {
    const parentDigest = routingDigest(withFocus(parent.focus));
    if (parent.validation.correct === validation.length) break;
    const diagnostics = await score(development, withFocus(parent.focus));
    const failedCases = development.flatMap((row, index) => diagnostics.outcomes[index].outcome === 'correct' ? [] : [{
      question: row.question, verifiedReads: row.reads, expectedPlan: row.expected, outcome: diagnostics.outcomes[index].outcome,
    }]);
    if (!failedCases.length) break;
    const proposed = focusFrom(await call('revise',
      'Revise only answer-selection guidance for choosing among verified leave facts, explanations and clarification slots. Preserve privacy, read scope, refusal, the answer format and human confirmation. Return JSON with one focus string of no more than 600 characters.',
      JSON.stringify({ currentFocus: parent.focus, failedCases })));
    if (!proposed || proposed === parent.focus) {
      rounds.push({ round, parentDigest, selection: 'no_new_candidate' });
      break;
    }
    const candidateValidation = await score(validation, withFocus(proposed));
    const regression = parent.validation.outcomes.some((row, index) =>
      row.outcome === 'correct' && candidateValidation.outcomes[index].outcome !== 'correct'
    );
    const selected = candidateValidation.securityFailures === 0 && !regression &&
      candidateValidation.correct > parent.validation.correct;
    rounds.push({
      round, parentDigest, candidateDigest: routingDigest(withFocus(proposed)), focus: proposed,
      validation: candidateValidation, selection: selected ? 'advanced_in_development' : 'retained_parent',
    });
    if (!selected) break;
    parent = { focus: proposed, validation: candidateValidation };
  }
  return {
    schemaVersion: 1,
    evidence: 'offline_answer_selection_development',
    engineDigest: ASSISTANT_CONVERSATION_ENGINE_DIGEST,
    fixtureDigest: routingDigest([development, validation]),
    baseline: { digest: routingDigest(withFocus(baselineFocus)), validation: baseline },
    manual: { digest: routingDigest(humanRevision), validation: manual },
    rounds,
    selectedDigest: routingDigest(withFocus(parent.focus)),
    budget: { maxRounds, maxCalls, ...usage, elapsedMs: Math.round(performance.now() - started) },
  };
}
