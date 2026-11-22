import { presentGroundedToolOutcome } from '../../lib/ai/grounded-tool-presentation';
import { adjudicateAssistantAnswerPlan } from '../../lib/ai/assistant-answer-plan';
import {
  adjudicatePrivateAssistantTerminal, privateAssistantCatalogue, resolvePrivateAssistantIntent, selectPrivateAssistantCards,
} from '../../lib/ai/provider-assistant-policy';
import { selectProtectedLeaveCount } from '../../lib/ai/assistant-leave-count';
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

function leaveFixtures() {
  return questions.flatMap(({ question, intent, field }) => balances.map(balance => {
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
}

/** Fictional source recreation through the same owned projection and terminal adjudicator as the app. */
export async function runProtectedLeaveComparison(model: PilotModel) {
  const cases = leaveFixtures();
  const localCases = ['Show my colleague’s leave balance', 'How much annual leave do I have?', 'Why did my annual leave not match eligibility?']
    .map(question => ({ question, intent: resolvePrivateAssistantIntent(question).intent }));
  return {
    evidence: 'protected_leave_projection_development',
    fixtureDigest: routingDigest([cases, localCases]),
    localCases,
    ...await compareProtectedAnswers(cases, model),
  };
}

function clarifiedLeaveFixtures() {
  return questions.map(({question,intent,field}) => {
    const companies = ['Fictional other company', 'Fictional selected company'];
    const employments = companies.map((company, card) => ({
      company, employmentId: 'fictional-own-' + card,
      balances: [{leaveType: 'Fictional annual leave', available: 9 + card, pending: 2 + card, taken: 4 + card}],
    }));
    const presentation = presentGroundedToolOutcome('my_leave_balances', {ok:true,employments});
    if (!presentation || presentation.cards.length !== 2) throw Error('Clarified leave must begin with two own records.');
    const reads = [{read:0,presentation,explanations:[]}];
    const local = employments.map(({company,employmentId},card) => ({read:0,card,key:employmentId,labels:[company]}));
    const unclarified = selectPrivateAssistantCards(intent,reads,null,local);
    const selected = selectPrivateAssistantCards(intent,reads,{originalQuestion:question,slot:'employment',answer:companies[1],earlier:[]},local);
    if (unclarified.slot !== 'employment' || selected.slot || selected.selection[0]?.cards.join(',') !== '1')
      throw Error('Clarified leave did not follow the existing company-selection rule.');
    const fact = presentation.cards[1].facts.findIndex(value => value.field === field && value.value !== null);
    if (fact < 0) throw Error('Missing requested fact in the selected company.');
    return {id:intent + ':clarified-company',intent,reads,selected,
      expected:{version:1,mode:'answer',blocks:[{kind:'fact',read:0,card:1,fact}]}};
  });
}

export async function runProtectedLeaveRouting(model: PilotModel) {
  const cases = [...leaveFixtures(), ...clarifiedLeaveFixtures()];
  const comparison = await compareProtectedAnswers(cases, model);
  const direct = new Map(cases.flatMap(fixture => {
    const catalogue = privateAssistantCatalogue(fixture.intent, fixture.reads, 'baseline_v1', fixture.selected.selection);
    const chosen = selectProtectedLeaveCount(catalogue);
    if (!chosen) return [];
    const plan = adjudicatePrivateAssistantTerminal(JSON.stringify({version: 1, mode: 'answer', blocks: [chosen]}), catalogue);
    const checked = adjudicateAssistantAnswerPlan(plan, fixture.reads);
    const expected = adjudicateAssistantAnswerPlan(fixture.expected, fixture.reads);
    return [[fixture.id, routingDigest(checked) === routingDigest(expected)] as const];
  }));
  const references = comparison.strategies.map(reference => {
    const rows = comparison.comparisons.filter(row => row.strategy === reference.strategy);
    const gains = rows.filter(row => direct.get(row.id) === true && row.outcome !== 'correct').length;
    const regressions = rows.filter(row => direct.get(row.id) === false && row.outcome === 'correct').length;
    return {...reference, gains, regressions, routedCorrect: reference.correct + gains - regressions};
  });
  return {evidence: 'offline_protected_leave_routing_development', releaseAuthorized: false,
    fixtureDigest: routingDigest(cases), cases: cases.length, direct: direct.size,
    directCorrect: [...direct.values()].filter(Boolean).length,
    estimatedCallsPerStrategy: cases.length - direct.size,
    references, budget: comparison.budget};
}
