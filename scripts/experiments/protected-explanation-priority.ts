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

/** Fictional, offline diagnosis of which supported explanation would accompany
 * application-supplied facts. Fact selection is outside this comparison. */
export async function runProtectedExplanationPriority(model: PilotModel) {
  const { development, validation } = protectedWorkSummarySplits();
  const easyCases = [...development, ...validation].filter(fixture => {
    const options = fixture.reads.flatMap(read => read.explanations
      .filter(option => option.card === null && option.code !== 'specialist_finding:scope_current_caller'));
    return options.length === 1 && fixture.expected.blocks.some(block => block.kind === 'explanation' && block.code === options[0].code);
  }).length;
  const cases = priorities.flatMap(({ module, sources, questions }) => {
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
  const arms = { withoutFocus: { correct: 0, rejected: 0 }, withFocus: { correct: 0, rejected: 0 } };
  const budget = { calls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0 };
  const started = performance.now();
  for (const { module, choices, focus, expected } of cases) {
    for (const arm of ['withoutFocus', 'withFocus'] as const) {
      const response = await model({ mode: 'answer', system, prompt: JSON.stringify({
        module, choices, ...(arm === 'withFocus' ? { focus } : {}),
      }) });
      if ([response.inputTokens, response.outputTokens].some(count => !Number.isSafeInteger(count) || count < 0))
        throw Error('Invalid model usage observation.');
      budget.calls++;
      budget.inputTokens += response.inputTokens;
      budget.outputTokens += response.outputTokens;
      let choice: unknown;
      try {
        const parsed = JSON.parse(response.text);
        if (parsed && Object.keys(parsed).join() === 'choice') choice = parsed.choice;
      } catch { /* Only the rejection count leaves this experiment. */ }
      if (!choices.includes(choice as AssistantExplanationCode)) arms[arm].rejected++;
      else if (choice === expected) arms[arm].correct++;
    }
  }
  budget.elapsedMs = Math.round(performance.now() - started);
  return {
    evidence: 'offline_explanation_priority_development', releaseAuthorized: false,
    fixtureDigest: routingDigest(cases), originalCasesWithUniqueDomainExplanation: easyCases,
    cases: cases.length, arms, budget,
  };
}
