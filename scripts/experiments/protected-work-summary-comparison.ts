import { assistantAnswerExplanationAvailability } from '../../lib/ai/assistant-answer-explanations';
import type { AssistantAnswerBlock, AssistantExplanationCode } from '../../lib/ai/assistant-answer-plan';
import { assistantToolAnswerExplanations } from '../../lib/ai/assistant-tool-answer-evidence';
import { presentGroundedToolOutcome, type GroundedToolName } from '../../lib/ai/grounded-tool-presentation';
import { MODULE_AGENT_CAPABILITIES } from '../../lib/ai/module-agents';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import { moduleHumanActionHandoffs } from '../../lib/ai/module-human-handoffs';
import type { JobFactField } from '../../lib/ai/module-jobs';
import { SPECIALIST_HOLDOUTS } from '../../lib/ai/module-specialist-holdouts';
import { compactSpecialistWork, executeCanonicalSpecialist } from '../../lib/ai/module-specialists';
import { resolvePrivateAssistantIntent, selectPrivateAssistantCards, type PrivateAssistantIntent } from '../../lib/ai/provider-assistant-policy';
import type { PilotModel } from '../teras/leave-improvement';
import { compareProtectedAnswers } from './protected-answer-comparison';

type ExpectedField = readonly [card: number, field: JobFactField];

function answerFixture({ id, question, intent, tool, outcome, fields, explanation }: {
  id: string;
  question: string;
  intent: PrivateAssistantIntent;
  tool: GroundedToolName;
  outcome: unknown;
  fields: readonly ExpectedField[];
  explanation?: AssistantExplanationCode;
}) {
  if (resolvePrivateAssistantIntent(question).intent !== intent) throw Error('Work summary fixture intent changed.');
  const presentation = presentGroundedToolOutcome(tool, outcome);
  if (!presentation) throw Error('Work summary fixture source is no longer supported.');
  const explanations = assistantAnswerExplanationAvailability(assistantToolAnswerExplanations(tool, outcome, presentation));
  const reads = [{ read: 0, presentation, explanations }];
  const selected = selectPrivateAssistantCards(intent, reads, null);
  if (selected.slot) throw Error('Work summary fixture now requires local clarification.');
  const blocks: AssistantAnswerBlock[] = fields.map(([card, field]) => {
    const matches = presentation.cards[card]?.facts.flatMap((value, index) => value.field === field && value.value !== null ? [index] : []);
    if (matches?.length !== 1) throw Error('Work summary fixture must expose one expected field per card.');
    return { kind: 'fact', read: 0, card, fact: matches[0] };
  });
  if (explanation) blocks.push({ kind: 'explanation', read: 0, card: null, code: explanation });
  return { id, question, intent, tool, reads, selected, expected: { version: 1, mode: 'answer', blocks } };
}

const specialistFixtures = [
  { id: 'attendance:late', question: 'My attendance', intent: 'attendance', fields: [[0, 'workedMinutes']], explanation: 'specialist_finding:attendance_exception_recorded' },
  { id: 'lifecycle:remaining', question: 'My onboarding', intent: 'lifecycle', fields: [[0, 'progressDone'], [0, 'progressTotal']], explanation: 'specialist_finding:lifecycle_steps_remaining' },
  { id: 'toil:banked', question: 'My replacement credits', intent: 'toil', fields: [[0, 'activeCredit']], explanation: 'specialist_finding:credit_recorded_not_new_eligibility' },
  { id: 'notifications:unread', question: 'My notifications', intent: 'notifications', fields: [[0, 'notificationCreated']], explanation: 'specialist_finding:notification_unread_not_delivery_proof' },
] as const;

const validationFixtures = [
  { id: 'attendance:present', question: 'My attendance', intent: 'attendance', fields: [[0, 'workedMinutes']], explanation: 'specialist_finding:attendance_status_recorded' },
  { id: 'lifecycle:complete', question: 'My onboarding', intent: 'lifecycle', fields: [[0, 'progressDone'], [0, 'progressTotal']], explanation: 'specialist_finding:lifecycle_progress_complete' },
  { id: 'toil:expired-converted', question: 'My replacement credits', intent: 'toil', fields: [[0, 'expiredCredit']], explanation: 'specialist_finding:credit_expired_not_available' },
  { id: 'notifications:read', question: 'My notifications', intent: 'notifications', fields: [[0, 'notificationCreated']], explanation: 'specialist_finding:notification_read_recorded' },
] as const;

function canonicalFixture(fixture: typeof specialistFixtures[number] | typeof validationFixtures[number]) {
  const sourceCase = SPECIALIST_HOLDOUTS.find(row => row.id === fixture.id);
  if (!sourceCase || sourceCase.module !== fixture.intent) throw Error('Missing canonical work summary fixture.');
  const capability = MODULE_AGENT_CAPABILITIES.find(([module]) => module === fixture.intent)?.[1];
  if (!capability) throw Error('Missing canonical work summary capability.');
  const source = {
    module: fixture.intent, capability, scope: 'current-caller', data: sourceCase.data,
    humanActions: moduleHumanActionHandoffs(fixture.intent),
  };
  const configuration = { kind: 'canonical_specialist_v1', module: fixture.intent, playbook: 'canonical_domain_v1' } as const;
  const assessment = executeCanonicalSpecialist(configuration, source);
  const specialistWork = compactSpecialistWork(assessment, { mode: 'baseline', version: 0, configuration });
  return answerFixture({ ...fixture, tool: 'my_module_work', outcome: { ok: true, ...source, specialistWork } });
}

export function protectedWorkSummarySplits() {
  return { development: specialistFixtures.map(canonicalFixture), validation: validationFixtures.map(canonicalFixture) };
}

/** Development benchmarks for the live post-read contract, using fictional source data. */
export async function runProtectedWorkSummaryComparison(model: PilotModel) {
  const cases = specialistFixtures.map(canonicalFixture);
  cases.push(answerFixture({
    id: 'claims:two-statuses', question: 'My claims', intent: 'claim_statuses', tool: 'my_claim_statuses',
    outcome: { ok: true, claims: [
      { claimType: 'Fictional taxi', status: 'pending', incurredOn: '2026-02-03', paidAt: null },
      { claimType: 'Fictional mileage', status: 'paid', incurredOn: '2026-02-01', paidAt: '2026-02-02' },
    ] },
    fields: [[0, 'status'], [1, 'status']],
  }));
  cases.push(answerFixture({
    id: 'leave:two-request-statuses', question: 'My leave requests', intent: 'leave_requests', tool: 'my_leave_requests',
    outcome: { ok: true, rows: [
      { leaveType: 'Fictional annual', status: 'pending', startDate: '2026-03-03', endDate: '2026-03-04' },
      { leaveType: 'Fictional special', status: 'approved', startDate: '2026-02-03', endDate: '2026-02-03' },
    ] },
    fields: [[0, 'status'], [0, 'from'], [1, 'status'], [1, 'from']],
  }));
  return {
    evidence: 'protected_work_summary_development',
    fixtureDigest: routingDigest(cases),
    ...await compareProtectedAnswers(cases, model),
  };
}
