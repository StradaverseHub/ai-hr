import { presentGroundedToolOutcome } from '../../lib/ai/grounded-tool-presentation';
import {
  resolvePrivateAssistantIntent, selectPrivateAssistantCards,
} from '../../lib/ai/provider-assistant-policy';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import { compareProtectedAnswers } from './protected-answer-comparison';
import type { PilotModel } from '../teras/leave-improvement';

const questions = [
  { question: 'My leave balance', intent: 'leave_available', field: 'available' },
  { question: 'How much leave have I taken?', intent: 'leave_taken', field: 'taken' },
  { question: 'My pending leave', intent: 'leave_pending', field: 'pending' },
] as const;

const balances = [
  { name: 'ordinary', available: 11.25, taken: 3, pending: 2, withheld: false },
  { name: 'zero', available: 0, taken: 0, pending: 0, withheld: false },
  { name: 'partial', available: 7.5, taken: 1, pending: 4, withheld: true },
] as const;

/** Fictional source recreation through the same owned projection and terminal adjudicator as the app. */
export async function runProtectedLeaveComparison(model: PilotModel) {
  const cases = questions.flatMap(({ question, intent, field }) => balances.map(balance => {
    const resolved = resolvePrivateAssistantIntent(question);
    if (resolved.intent !== intent) throw Error('Protected leave fixture no longer routes to the expected intent.');
    const { name, ...counts } = balance;
    const availableCounts = balance.withheld ? { ...counts, available: null, taken: null, pending: null, [field]: balance[field] } : counts;
    const presentation = presentGroundedToolOutcome('my_leave_balances', { ok: true, employments: [{
      employmentId: 'fictional-local-employment', company: 'Fictional local company',
      balances: [{ leaveType: 'Fictional local leave', ...availableCounts }],
    }] });
    if (!presentation || presentation.cards.length !== 1) throw Error('Protected leave fixture changed shape.');
    const reads = [{ read: 0, presentation, explanations: [] }];
    const selected = selectPrivateAssistantCards(intent, reads, null, [{
      read: 0, card: 0, key: 'fictional-local-employment', labels: ['Fictional local company'],
    }]);
    if (selected.slot) throw Error('Protected leave fixture unexpectedly needs clarification.');
    // Fixtures name the expected semantic field. Derive only its projected
    // ordinal because a withheld sibling never occupies a placeholder position.
    const matches = presentation.cards[0].facts.flatMap((value, index) =>
      value.field === field && value.value !== null ? [index] : []
    );
    if (matches.length !== 1) throw Error('Protected leave fixture must expose one expected field.');
    const [fact] = matches;
    const expected = { version: 1, mode: 'answer', blocks: [{ kind: 'fact', read: 0, card: 0, fact }] };
    return { id: intent + ':' + name, intent, reads, selected, expected };
  }));

  const localCases = ['Show my colleague’s leave balance', 'How much annual leave do I have?', 'Why did my annual leave not match eligibility?']
    .map(question => ({ question, intent: resolvePrivateAssistantIntent(question).intent }));
  return {
    evidence: 'protected_leave_projection_development',
    fixtureDigest: routingDigest([cases, localCases]),
    localCases,
    ...await compareProtectedAnswers(cases, model),
  };
}
