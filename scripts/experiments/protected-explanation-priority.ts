import { assistantAnswerExplanationAvailability, specialistAnswerExplanations } from '../../lib/ai/assistant-answer-explanations';
import type { AssistantExplanationCode } from '../../lib/ai/assistant-answer-plan';
import { MODULE_AGENT_CAPABILITIES } from '../../lib/ai/module-agents';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import { SPECIALIST_HOLDOUTS } from '../../lib/ai/module-specialist-holdouts';
import { executeCanonicalSpecialist } from '../../lib/ai/module-specialists';
import type { PilotModel } from '../teras/leave-improvement';
import { protectedWorkSummarySplits } from './protected-work-summary-comparison';

const priorities = [
  { module: 'attendance', sources: ['late', 'present'], questions: [
    ['attendance exceptions needing attention', 'specialist_finding:attendance_exception_recorded'],
    ['ordinary attendance recorded', 'specialist_finding:attendance_status_recorded'],
  ] },
  { module: 'toil', sources: ['expired-converted'], questions: [
    ['credits that cannot be used because they expired', 'specialist_finding:credit_expired_not_available'],
    ['recorded credit conversion and whether it proves a payslip', 'specialist_finding:credit_pay_conversion_not_payslip'],
  ] },
  { module: 'notifications', sources: ['unread', 'read'], questions: [
    ['unread notifications and whether that proves delivery', 'specialist_finding:notification_unread_not_delivery_proof'],
    ['notifications with a recorded read', 'specialist_finding:notification_read_recorded'],
  ] },
] as const;

const system = 'Choose one canonical explanation from the available codes. When a focus is supplied, choose the code addressing that focus. Return exactly {"choice":"the supplied code"} with no other fields. Never infer records, values, access, money or effects.';

function explanationCases() {
  return priorities.flatMap(({ module, sources, questions }) => {
    const capability = MODULE_AGENT_CAPABILITIES.find(row => row[0] === module)?.[1];
    if (!capability) throw Error('Missing explanation benchmark capability.');
    const rows = sources.flatMap(id => {
      const fixture = SPECIALIST_HOLDOUTS.find(row => row.id === module + ':' + id);
      const bounded = fixture?.data as { rows?: unknown[] } | undefined;
      if (!Array.isArray(bounded?.rows)) throw Error('Missing explanation benchmark source.');
      return bounded.rows;
    });
    const source = { module, capability, scope: 'current-caller', data: { rows, truncated: false } };
    const assessment = executeCanonicalSpecialist({ kind: 'canonical_specialist_v1', module, playbook: 'canonical_domain_v1' }, source);
    const choices = assistantAnswerExplanationAvailability(specialistAnswerExplanations(assessment, assessment.presentation))
      .filter(option => option.card === null && option.code !== 'specialist_finding:scope_current_caller')
      .map(option => option.code);
    if (choices.length < 2 || questions.some(([, expected]) => !choices.includes(expected)))
      throw Error('Ambiguous explanation benchmark lost a canonical choice.');
    return questions.map(([focus, expected]) => ({ module, choices, focus, expected }));
  });
}

type ExplanationCase = ReturnType<typeof explanationCases>[number];
type Outcome = 'correct' | 'incorrect' | 'rejected';

function observeModel(model: PilotModel) {
  const budget = { calls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0 };
  const started = performance.now();
  const call: PilotModel = async request => {
    const response = await model(request);
    if ([response.inputTokens, response.outputTokens].some(count => !Number.isSafeInteger(count) || count < 0))
      throw Error('Invalid model usage observation.');
    budget.calls++;
    budget.inputTokens += response.inputTokens;
    budget.outputTokens += response.outputTokens;
    budget.elapsedMs = Math.round(performance.now() - started);
    return response;
  };
  return { call, budget };
}

function readChoice(text: string, key: string): unknown {
  try {
    const parsed = JSON.parse(text);
    if (parsed && Object.keys(parsed).join() === key) return parsed[key];
  } catch { /* Invalid replies are rejected without retaining their text. */ }
}

async function choose(model: PilotModel, { module, choices, focus, expected }: ExplanationCase,
  includeFocus: boolean, instruction = system): Promise<Outcome> {
  const response = await model({ mode: 'answer', system: instruction,
    prompt: JSON.stringify({ module, choices, ...(includeFocus ? { focus } : {}) }) });
  const choice = readChoice(response.text, 'choice');
  if (!choices.includes(choice as AssistantExplanationCode)) return 'rejected';
  return choice === expected ? 'correct' : 'incorrect';
}

/** Fictional, offline diagnosis of which supported explanation would accompany
 * application-supplied facts. Fact selection is outside this comparison. */
export async function runProtectedExplanationPriority(model: PilotModel) {
  const { development, validation } = protectedWorkSummarySplits();
  const easyCases = [...development, ...validation].filter(fixture => {
    const options = fixture.reads.flatMap(read => read.explanations
      .filter(option => option.card === null && option.code !== 'specialist_finding:scope_current_caller'));
    return options.length === 1 && fixture.expected.blocks.some(block => block.kind === 'explanation' && block.code === options[0].code);
  }).length;
  const cases = explanationCases();
  const arms = { withoutFocus: { correct: 0, rejected: 0 }, withFocus: { correct: 0, rejected: 0 } };
  const { call, budget } = observeModel(model);
  for (const fixture of cases) {
    for (const arm of ['withoutFocus', 'withFocus'] as const) {
      const outcome = await choose(call, fixture, arm === 'withFocus');
      if (outcome !== 'incorrect') arms[arm][outcome]++;
    }
  }
  return {
    evidence: 'offline_explanation_priority_development', releaseAuthorized: false,
    fixtureDigest: routingDigest(cases), originalCasesWithUniqueDomainExplanation: easyCases,
    cases: cases.length, arms, budget,
  };
}

const revisions = {
  include_source_focus: 'Provide the source-owned fictional request focus with each catalogue.',
  compare_choice_meanings: 'Ask the answer model to compare the meanings of the available codes before selecting.',
} as const;
type Revision = keyof typeof revisions;

export const explanationRevisionSchema = {
  type: 'object', additionalProperties: false, required: ['change'],
  properties: { change: { type: 'string', enum: Object.keys(revisions) } },
};

/** One offline proposal. The optimizer receives diagnostics from two modules;
 * the third module supplies paired development scores after the proposal. */
export async function runProtectedExplanationImprovement(model: PilotModel) {
  const cases = explanationCases();
  const development = cases.filter(row => row.module !== 'toil');
  const validation = cases.filter(row => row.module === 'toil');
  const { call, budget } = observeModel(model);
  async function score(rows: ExplanationCase[], revision?: Revision) {
    const outcomes: Outcome[] = [];
    const instruction = revision === 'compare_choice_meanings'
      ? system + ' Compare the meanings of the available codes before selecting.' : system;
    for (const row of rows) outcomes.push(await choose(call, row, revision === 'include_source_focus', instruction));
    return outcomes;
  }
  const summarize = (rows: readonly Outcome[]) => ({
    correct: rows.filter(outcome => outcome === 'correct').length,
    rejected: rows.filter(outcome => outcome === 'rejected').length,
  });
  const discovery = await score(development);
  const proposal = await call({
    mode: 'revise',
    system: 'Choose one listed change to address the development results. The same catalogue can have different intended explanations depending on the request. Return only an object with the change key.',
    prompt: JSON.stringify({ options: revisions, development: { cases: development.length, ...summarize(discovery) } }),
  });
  const change = readChoice(proposal.text, 'change');
  const revision = typeof change === 'string' && Object.hasOwn(revisions, change) ? change as Revision : null;
  const parent = await score(validation);
  const candidate = revision ? await score(validation, revision) : null;
  const regressions = candidate?.filter((outcome, index) => parent[index] === 'correct' && outcome !== 'correct').length;
  const baseline = summarize(parent);
  const revised = candidate ? summarize(candidate) : null;
  const advanced = revised !== null && revised.correct > baseline.correct && revised.rejected === 0 && regressions === 0;
  return {
    evidence: 'offline_explanation_revision_development', releaseAuthorized: false,
    developmentDigest: routingDigest(development), validationDigest: routingDigest(validation),
    validationCases: validation.length, baseline, revision, candidate: revised, regressions: regressions ?? null,
    advanced, budget,
  };
}
