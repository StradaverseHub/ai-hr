import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runProtectedLeaveComparison } from '../scripts/experiments/protected-leave-comparison';
import { protectedWorkSummarySplits, runProtectedWorkSummaryComparison } from '../scripts/experiments/protected-work-summary-comparison';
import { PROTECTED_CATALOGUE_FORMAT, protectedCatalogueAnswerJsonSchema } from '../scripts/experiments/protected-catalogue-answer-format';
import { protectedIndexedAnswer } from '../scripts/experiments/protected-indexed-answer-format';
import { runProtectedWorkSummaryImprovement } from '../scripts/experiments/protected-work-summary-improvement';
import { scoreProtectedWorkSummaryHoldout } from '../scripts/experiments/protected-work-summary-holdout';
import { scoreProtectedExplanationHoldout } from '../scripts/experiments/protected-explanation-holdout';
import { historicalExplanationCases } from '../scripts/experiments/write-historical-explanation-cases';
import {
  EXPLANATION_ANSWER_FORMAT, EXPLANATION_GENERATION_OPTIONS, explanationCases, runProtectedExplanationImprovement, runProtectedExplanationPriority,
} from '../scripts/experiments/protected-explanation-priority';
import type { ProtectedAnswerFixture } from '../scripts/experiments/protected-answer-comparison';
import { guidanceContractDigest, guidanceOptions, protectedStrategyDigest } from '../scripts/experiments/protected-work-summary-guidance';
import { leaveAnswerFormat } from '../scripts/experiments/leave-answer-format';
import { runLeaveImprovement, type PilotModel } from '../scripts/teras/leave-improvement';
import { adjudicateAssistantAnswerPlan } from '../lib/ai/assistant-answer-plan';
import { ASSISTANT_CONVERSATION_HOLDOUTS } from '../lib/ai/assistant-conversation-holdouts';
import { routingDigest } from '../lib/ai/module-agent-routing';

it('separates source-resolved findings from genuinely competing explanations', async () => {
  const report = await runProtectedExplanationPriority(async ({ mode, prompt }) => {
    expect(mode).toBe('answer');
    const request = JSON.parse(prompt);
    expect(Object.keys(request).sort()).toEqual(request.focus ? ['choices', 'focus', 'module'] : ['choices', 'module']);
    expect(request.choices).toHaveLength(2);
    expect(prompt).not.toMatch(/2026-|470|480|expected|scope_current_caller/);
    return { text: JSON.stringify({ choice: request.choices[0] }), inputTokens: 1, outputTokens: 1 };
  });
  expect(report).toMatchObject({
    originalCasesWithUniqueDomainExplanation: 7, cases: 6,
    arms: { withoutFocus: { correct: 3, rejected: 0 }, withFocus: { correct: 3, rejected: 0 } },
    budget: { calls: 12, inputTokens: 12, outputTokens: 12 },
  });
});

it('compares one model-proposed explanation revision on an unseen development module', async () => {
  let proposed = false;
  const report = await runProtectedExplanationImprovement(async ({ mode, prompt }) => {
    const request = JSON.parse(prompt);
    let reply;
    if (mode === 'revise') {
      expect(request.development).toEqual({ cases: 4, correct: 2, rejected: 0, maximumCorrectWithCurrentInputs: 2 });
      expect(prompt).not.toMatch(/toil|attendance|notifications|expired|payslip|expected/);
      proposed = true;
      reply = { change: 'include_source_focus' };
    } else {
      expect(request.module === 'toil').toBe(proposed);
      expect(prompt).not.toContain('expected');
      const choice = request.focus?.includes('expired')
        ? request.choices.find((item: string) => item.endsWith('credit_expired_not_available'))
        : request.focus
          ? request.choices.find((item: string) => item.endsWith('credit_pay_conversion_not_payslip'))
          : request.choices[0];
      reply = { choice };
    }
    return { text: JSON.stringify(reply), inputTokens: 2, outputTokens: 1 };
  });
  expect(report).toMatchObject({
    validationCases: 2, baseline: { correct: 1 }, candidate: { correct: 2, rejected: 0 },
    revision: 'include_source_focus', regressions: 0, advanced: true, releaseAuthorized: false,
    budget: { calls: 9, inputTokens: 18, outputTokens: 9 },
  });
});

describe('evaluator-held explanation choices', () => {
  const modelDigest = '1'.repeat(64);
  const publicCases = explanationCases();
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const report = {
    evidence: 'offline_explanation_revision_development', releaseAuthorized: false,
    modelDigest, answerFormatDigest: routingDigest(EXPLANATION_ANSWER_FORMAT), generationOptions: EXPLANATION_GENERATION_OPTIONS,
    developmentDigest: routingDigest(publicCases.filter(row => row.module !== 'toil')),
    validationDigest: routingDigest(publicCases.filter(row => row.module === 'toil')), validationCases: 2,
    revision: 'include_source_focus', advanced: true,
    baseline: { correct: 1, rejected: 0 }, candidate: { correct: 2, rejected: 0 }, regressions: 0,
  };
  const drafts = ['claim_draft_not_submitted', 'claim_approved_not_paid'];
  const credits = ['credit_recorded_not_new_eligibility', 'credit_pay_conversion_not_payslip'];
  const cases = [
    { module: 'claims', choices: drafts, focus: 'Still a draft in the system?', expected: drafts[0] },
    { module: 'claims', choices: drafts, focus: 'Approved but still unpaid?', expected: drafts[1] },
    { module: 'toil', choices: credits, focus: 'A new eligibility decision?', expected: credits[0] },
    { module: 'toil', choices: credits, focus: 'What was sent to wages?', expected: credits[1] },
  ];
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
  const spec = (development: Buffer, fixtures = cases) => bytes({
    version: 1, modelDigest, developmentReportDigest: sha(development), minimumGain: 2, cases: fixtures,
  });

  it('compares both model arms with a deterministic selector on the same cases', async () => {
    const savedReport = bytes(report);
    const input = spec(savedReport);
    const result = await scoreProtectedExplanationHoldout(input, sha(input), savedReport, modelDigest, async ({ mode, prompt }) => {
      expect(mode).toBe('answer');
      const received = JSON.parse(prompt);
      expect(Object.keys(received).sort()).toEqual(received.focus ? ['choices', 'focus', 'module'] : ['choices', 'module']);
      const fixture = cases.find(row => row.focus === received.focus);
      const choice = fixture ? 'specialist_finding:' + fixture.expected : received.choices[0];
      return { text: JSON.stringify({ choice }), inputTokens: 1, outputTokens: 1 };
    });
    expect(result).toMatchObject({
      candidate: { correct: 4, rejected: 0 }, original: { correct: 2, gains: 2, regressions: 0 },
      deterministic: { correct: 3, abstained: 1, gains: 1, regressions: 0 },
      retrievalFirst: { correct: 4, rejected: 0, modelCalls: 1, versusFocused: { gains: 0, regressions: 0 } },
      retrievalMargins: expect.arrayContaining([
        expect.objectContaining({ minimumMargin: 1, correct: 4, modelCalls: 1 }),
        expect.objectContaining({ minimumMargin: 8, correct: 4, modelCalls: 4 }),
      ]),
      confirmedGain: true, beatsDeterministic: false, releaseAuthorized: false, budget: { calls: 8 },
    });
    expect(JSON.stringify(result)).not.toContain(cases[0].focus);
  });

  it('rejects exposed catalogues and substituted development bytes before inference', async () => {
    const savedReport = bytes(report);
    const input = spec(savedReport);
    const noCall: PilotModel = async () => { throw Error('Unexpected model call'); };
    await expect(scoreProtectedExplanationHoldout(input, sha(input), bytes({ ...report, advanced: false }), modelDigest, noCall))
      .rejects.toThrow('Invalid frozen protected holdout');
    const exposed = {
      module: 'toil', choices: ['credit_pay_conversion_not_payslip', 'credit_expired_not_available'],
      focus: 'A new wording for an exposed catalogue', expected: 'credit_expired_not_available',
    };
    const mixed = spec(savedReport, [exposed, ...cases.slice(1)]);
    await expect(scoreProtectedExplanationHoldout(mixed, sha(mixed), savedReport, modelDigest, noCall))
      .rejects.toThrow('reuses an exposed catalogue');
  });
});

it('reuses only earlier fictional business questions and labels on unexposed modules', () => {
  const cases = historicalExplanationCases();
  expect(cases.length).toBeGreaterThanOrEqual(4);
  expect(new Set(cases.map(row => row.module)).size).toBe(cases.length);
  for (const row of cases) {
    expect(explanationCases().some(exposed => exposed.module === row.module)).toBe(false);
    expect(['claims', 'rewards']).not.toContain(row.module);
    const source = ASSISTANT_CONVERSATION_HOLDOUTS.find(item => item.locale === 'en' && item.category === 'domain' &&
      item.module === row.module && item.question === row.focus);
    expect(source?.expected).toMatchObject({mode: 'answer',
      blocks: expect.arrayContaining([expect.objectContaining({kind: 'explanation', card: null, code: 'specialist_finding:' + row.expected})])});
    expect(row.choices).toContain(row.expected);
    expect(row.choices.length).toBeGreaterThan(1);
  }
});

describe('evaluator-held protected answer cases', () => {
  const modelDigest = 'a'.repeat(64);
  const { development, validation } = protectedWorkSummarySplits();
  const published = development.slice(0, 2);
  const fictional = published.map(fixture => ({
    ...fixture, id: 'fictional-oracle-' + fixture.intent,
    reads: fixture.reads.map(read => ({ ...read, presentation: {
      ...read.presentation, cards: read.presentation.cards.map((card, index) => index === 0 ? {
        ...card, title: { kind: 'text' as const, value: 'Fictional value sentinel' },
        facts: card.facts.slice(0, -1),
      } : card),
    } })),
  }));
  const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');
  const developmentReport = Buffer.from(JSON.stringify({
    evidence: 'offline_protected_selection_development', contractDigest: guidanceContractDigest, modelDigest,
    answerFormatDigest: routingDigest(PROTECTED_CATALOGUE_FORMAT),
    developmentDigest: routingDigest(development), validationDigest: routingDigest(validation),
    baseline: { digest: protectedStrategyDigest([]), correct: 0, rejected: 0 },
    rounds: [{ number: 1, parentDigest: protectedStrategyDigest([]), add: 'include_meaning',
      candidateDigest: protectedStrategyDigest(['include_meaning']),
      decision: 'advanced_in_development', validation: { correct: 2, rejected: 0, regressions: 0 } }],
    selected: { digest: protectedStrategyDigest(['include_meaning']), rules: ['include_meaning'], correct: 2, rejected: 0 },
  }));
  const file = (cases: readonly ProtectedAnswerFixture[] = fictional, report = developmentReport) => Buffer.from(JSON.stringify({
    version: 2, cases, modelDigest, minimumGain: 2, developmentReportDigest: hash(report),
    parentRules: [], parentDigest: protectedStrategyDigest([]),
    candidateRules: ['include_meaning'], candidateDigest: protectedStrategyDigest(['include_meaning']),
  }));

  it('scores a frozen pair without sending expected answers or reporting case details', async () => {
    let calls = 0;
    const model: PilotModel = async ({ mode, system, prompt }) => {
      calls++;
      expect(mode).toBe('answer');
      expect(prompt).not.toMatch(/fictional-oracle|Fictional value sentinel|expected|progressTotal":\s*[0-9]/);
      const fixture = fictional.find(row => row.intent === JSON.parse(prompt).intent);
      expect(fixture).toBeDefined();
      return {
        text: system.includes(guidanceOptions.include_meaning) ? JSON.stringify(fixture!.expected) : '{}',
        inputTokens: 10, outputTokens: 5,
      };
    };
    const bytes = file();
    const report = await scoreProtectedWorkSummaryHoldout(bytes, hash(bytes), developmentReport, modelDigest, model);
    expect(calls).toBe(4);
    expect(report).toMatchObject({
      cases: 2, gains: 2, regressions: 0, candidateRejected: 0, meetsThreshold: true, releaseAuthorized: false,
      usage: { calls: 4, inputTokens: 40, outputTokens: 20 },
    });
    expect(JSON.stringify(report)).not.toMatch(/fictional-oracle|Fictional value sentinel|progressTotal/);
  });

  it('refuses a changed case file and exposed case catalogues before any model call', async () => {
    const noCall: PilotModel = async () => { throw Error('Model should not be called'); };
    const bytes = file();
    await expect(scoreProtectedWorkSummaryHoldout(bytes, '0'.repeat(64), developmentReport, modelDigest, noCall))
      .rejects.toThrow('Invalid frozen protected holdout');
    const exposed = file(published.map(fixture => ({ ...fixture, id: 'renamed-' + fixture.intent })));
    await expect(scoreProtectedWorkSummaryHoldout(exposed, hash(exposed), developmentReport, modelDigest, noCall))
      .rejects.toThrow('Holdout repeats an exposed');
  });

  it('recognizes exposed evidence after its reference ordinals change', async () => {
    const noCall: PilotModel = async () => { throw Error('Model should not be called'); };
    const reordered = published.map(fixture => {
      const plan = adjudicateAssistantAnswerPlan(fixture.expected, fixture.reads);
      if (plan.mode !== 'answer') throw Error('Expected a published answer fixture.');
      return {
        ...fixture,
        id: 'reordered-' + fixture.intent,
        reads: fixture.reads.map(read => ({ ...read, presentation: {
          ...read.presentation, cards: read.presentation.cards.map(card => ({ ...card, facts: [...card.facts].reverse() })),
        } })),
        expected: { ...plan, blocks: plan.blocks.map(block => {
          if (block.kind !== 'fact') return block;
          const card = fixture.reads.find(read => read.read === block.read)!.presentation.cards[block.card];
          return { ...block, fact: card.facts.length - 1 - block.fact };
        }) },
      };
    });
    expect(reordered[0].reads).not.toEqual(published[0].reads);
    const bytes = file(reordered);
    await expect(scoreProtectedWorkSummaryHoldout(bytes, hash(bytes), developmentReport, modelDigest, noCall))
      .rejects.toThrow('Holdout repeats an exposed');
  });

  it('refuses to spend withheld cases on a rejected or substituted revision', async () => {
    const noCall: PilotModel = async () => { throw Error('Model should not be called'); };
    const changed = Buffer.from(developmentReport.toString().replace('advanced_in_development', 'retained_parent'));
    const original = file();
    await expect(scoreProtectedWorkSummaryHoldout(original, hash(original), changed, modelDigest, noCall))
      .rejects.toThrow('Invalid frozen protected holdout');
    const pinned = file(fictional, changed);
    await expect(scoreProtectedWorkSummaryHoldout(pinned, hash(pinned), changed, modelDigest, noCall))
      .rejects.toThrow('The frozen development report does not select this candidate');
  });
});

function fakeModel(options: { regress?: boolean; fail?: boolean } = {}) {
  const parents: string[] = [];
  const model: PilotModel = async ({ mode, system, prompt }) => {
    const parsed = JSON.parse(prompt);
    let text: string;
    if (mode === 'revise') {
      parents.push(parsed.currentFocus);
      expect(parsed.failedCases).toHaveLength(6);
      for (const failure of parsed.failedCases) {
        expect(ASSISTANT_CONVERSATION_HOLDOUTS.find(row => row.question === failure.question)?.id).toMatch(/:domain:leave$/);
      }
      text = JSON.stringify({ focus: parsed.currentFocus === '' ? 'first revision' : 'second revision' });
    } else {
      expect(parsed).not.toHaveProperty('expectedPlan');
      if (options.fail) throw Error('Local model service unavailable');
      const row = ASSISTANT_CONVERSATION_HOLDOUTS.find(item =>
        item.question === parsed.question && item.locale === parsed.locale);
      if (!row) throw Error('Test received an unexpected question');
      const first = system.endsWith('first revision');
      const second = system.endsWith('second revision');
      const misses =
        row.id.endsWith(':domain:leave') ||
        (row.id.endsWith(':leave_canonical_why') && !first && !second) ||
        (row.id.endsWith(':clarify:leave_type') && !second) ||
        (row.security && second && options.regress);
      text = misses ? '{}' : JSON.stringify(row.expected);
    }
    return { text, inputTokens: 2, outputTokens: 1 };
  };
  return { model, parents };
}

describe('leave improvement development experiment', () => {
  it('revises from the selected parent and records two paired gains and finite usage', async () => {
    const { model, parents } = fakeModel();
    const result = await runLeaveImprovement(model);
    const [first, second] = result.rounds;
    expect(parents).toEqual(['', 'first revision']);
    expect(first).toMatchObject({ parentDigest: result.baseline.digest, selection: 'advanced_in_development', validation: { correct: 18 } });
    expect(second).toMatchObject({ parentDigest: first.candidateDigest, selection: 'advanced_in_development', validation: { correct: 24 } });
    expect(result.selectedDigest).toBe(second.candidateDigest);
    expect(result.baseline.validation.correct).toBe(12);
    expect(result.manual.validation.correct).toBe(12);
    expect(result.budget).toMatchObject({ calls: 110, maxCalls: 110, inputTokens: 220, outputTokens: 110 });
  });

  it('retains the prior strategy if the new revision regresses privacy', async () => {
    const { model } = fakeModel({ regress: true });
    const result = await runLeaveImprovement(model);
    expect(result.rounds[1]).toMatchObject({ selection: 'retained_parent', validation: { securityFailures: 6 } });
    expect(result.selectedDigest).toBe(result.rounds[0].candidateDigest);
  });

  it('fails rather than recording a gain when the model is unavailable', async () => {
    await expect(runLeaveImprovement(fakeModel({ fail: true }).model)).rejects.toThrow('Local model service unavailable');
  });
});

describe('leave experiment output schema', () => {
  it('admits the expected plans for every search and validation fixture', () => {
    const cases = ASSISTANT_CONVERSATION_HOLDOUTS.filter(row =>
      /:(domain:leave|leave_canonical_why|clarify:leave_type|unsupported|privacy:0)$/.test(row.id)
    );
    expect(cases).toHaveLength(30);
    for (const row of cases) expect(leaveAnswerFormat.parse(row.expected)).toEqual(row.expected);
  });

  it('rejects prose selectors, arbitrary effects, extra keys and empty plans', () => {
    for (const invalid of [
      { version: 1, mode: 'answer', blocks: [{ kind: 'fact', read: 0, card: 0, fact: 'a guessed amount' }] },
      { version: 1, mode: 'propose', action: 'apply_leave', hints: {} },
      { version: 1, mode: 'refuse', code: 'unsupported_request', prose: 'a disclosure' },
      { version: 1, mode: 'answer', blocks: [] },
    ]) expect(leaveAnswerFormat.safeParse(invalid).success).toBe(false);
  });
});

describe('protected leave comparison', () => {
  it('exercises the owned provider projection without words, dates, titles or numeric leave values', async () => {
    const report = await runProtectedLeaveComparison(async ({ prompt, system }) => {
      expect(prompt).not.toMatch(/Fictional local|11\.25|7\.5|how much|my pending/i);
      expect(system).toContain('There are no HR values or human words here');
      const payload = JSON.parse(prompt);
      expect(payload.reads[0].cards).toHaveLength(1);
      const expectedFact: Record<string, number> = { leave_available: 1, leave_taken: 2, leave_pending: 3 };
      const facts = payload.reads[0].cards[0].facts;
      expect([2, 4]).toContain(facts.length);
      const fact = facts.length === 2 ? 1 : expectedFact[payload.intent];
      const field = { leave_available: 'available', leave_taken: 'taken', leave_pending: 'pending' }[payload.intent as 'leave_available'];
      expect(facts[fact].field).toBe(field);
      expect(payload.reads[0].cards[0].facts[fact]).toMatchObject({ fact, available: true });
      return { text: JSON.stringify({ version: 1, mode: 'answer', blocks: [{ kind: 'fact', read: 0, card: 0, fact }] }), inputTokens: 1, outputTokens: 1 };
    });
    expect(report.budget.calls).toBe(18);
    expect(report.strategies.map(item => item.correct)).toEqual([9, 9]);
    expect(report.localCases.map(item => item.intent)).toEqual([null, null, null]);
  });

  it('rejects references outside the prepared source rather than counting syntactically valid plans as correct', async () => {
    const report = await runProtectedLeaveComparison(async () => ({
      text: '{"version":1,"mode":"answer","blocks":[{"kind":"fact","read":0,"card":1,"fact":1}]}',
      inputTokens: 1, outputTokens: 1,
    }));
    expect(report.strategies.map(item => [item.correct, item.rejected])).toEqual([[0, 9], [0, 9]]);
  });
});

describe('protected work summary comparison', () => {
  it('compiles a per-request schema from available references, without adding a correct answer', () => {
    const catalogue = { version: 1, operation: 'conversation', intent: 'claim_statuses', strategy: 'baseline_v1', reads: [{
      read: 0, module: 'claims', cards: [{ card: 0, facts: [
        { fact: 0, field: 'status', available: true }, { fact: 4, field: 'paidAt', available: false },
      ] }, { card: 1, facts: [{ fact: 0, field: 'status', available: true }] }],
      explanations: [{ card: null, code: 'specialist_finding:claim_pending_not_approved' }],
    }] };
    const schema = protectedCatalogueAnswerJsonSchema(catalogue);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.mode.const).toBe('answer');
    expect(schema.properties.blocks.maxItems).toBe(3);
    expect(schema.properties.blocks.items.anyOf.map(choice => choice.properties)).toMatchObject([
      { kind: { const: 'fact' }, read: { const: 0 }, card: { const: 0 }, fact: { const: 0 } },
      { kind: { const: 'fact' }, read: { const: 0 }, card: { const: 1 }, fact: { const: 0 } },
      { kind: { const: 'explanation' }, read: { const: 0 }, card: { const: null }, code: { const: 'specialist_finding:claim_pending_not_approved' } },
    ]);
    expect(() => protectedCatalogueAnswerJsonSchema({ ...catalogue, reads: [] })).toThrow('requires an available reference');

    const indexed = protectedIndexedAnswer(catalogue);
    expect(indexed.format.properties.selection.items.enum).toEqual([0, 1, 2]);
    expect(JSON.parse(indexed.prompt).choices).toEqual([
      { index: 0, read: 0, card: 0, module: 'claims', field: 'status' },
      { index: 1, read: 0, card: 1, module: 'claims', field: 'status' },
      { index: 2, read: 0, card: null, module: 'claims', explanation: 'specialist_finding:claim_pending_not_approved' },
    ]);
    expect(JSON.parse(indexed.decode('{"selection":[1,2]}')).blocks).toEqual([
      { kind: 'fact', read: 0, card: 1, fact: 0 },
      { kind: 'explanation', read: 0, card: null, code: 'specialist_finding:claim_pending_not_approved' },
    ]);
    for (const invalid of ['{"selection":[]}', '{"selection":[0,0]}', '{"selection":[3]}',
      '{"selection":["1"]}', '{"selection":[1],"prose":"x"}', 'untrusted prose']) {
      expect(indexed.decode(invalid)).toBe('{}');
    }
  });

  it('checks complete multi-record answers and canonical specialist explanations without disclosing source values', async () => {
    const expected = {
      attendance: { facts: [[0, 2]], code: 'specialist_finding:attendance_exception_recorded' },
      lifecycle: { facts: [[0, 1], [0, 2]], code: 'specialist_finding:lifecycle_steps_remaining' },
      toil: { facts: [[0, 0]], code: 'specialist_finding:credit_recorded_not_new_eligibility' },
      notifications: { facts: [[0, 0]], code: 'specialist_finding:notification_unread_not_delivery_proof' },
      claim_statuses: { facts: [[0, 0], [1, 0]], code: null },
      leave_requests: { facts: [[0, 1], [0, 2], [1, 1], [1, 2]], code: null },
    };
    const report = await runProtectedWorkSummaryComparison(async ({ prompt }) => {
      expect(prompt).not.toMatch(/Fictional|Human equipment|2026-|\b470\b|My attendance|pending|approved|\/me\//i);
      const catalogue = JSON.parse(prompt);
      const { facts, code } = expected[catalogue.intent as keyof typeof expected];
      const blocks = facts.map(([card, fact]) => ({ kind: 'fact', read: 0, card, fact }));
      const explanation = code ? [{ kind: 'explanation', read: 0, card: null, code }] : [];
      return { text: JSON.stringify({ version: 1, mode: 'answer', blocks: [...blocks, ...explanation] }), inputTokens: 1, outputTokens: 1 };
    });
    expect(report.budget.calls).toBe(12);
    expect(report.strategies.map(item => item.correct)).toEqual([6, 6]);
  });

  it('separates incomplete answers from attempts to use withheld facts', async () => {
    const report = await runProtectedWorkSummaryComparison(async ({ prompt }) => {
      const catalogue = JSON.parse(prompt);
      const blocks = [{ kind: 'fact', read: 0, card: 0, fact: catalogue.intent === 'claim_statuses' ? 4 : 0 }];
      return { text: JSON.stringify({ version: 1, mode: 'answer', blocks }), inputTokens: 1, outputTokens: 1 };
    });
    const claims = report.comparisons.filter(row => row.id === 'claims:two-statuses');
    expect(claims).toHaveLength(2);
    for (const row of claims) expect(row).toMatchObject({ outcome: 'rejected', reason: 'outside_catalogue' });
    const attendance = report.comparisons.filter(row => row.id === 'attendance:late');
    expect(attendance).toHaveLength(2);
    for (const row of attendance) expect(row).toMatchObject({
      outcome: 'wrong_selection',
      missing: [
        { kind: 'fact', read: 0, card: 0, fact: 2 },
        { kind: 'explanation', read: 0, card: null, code: 'specialist_finding:attendance_exception_recorded' },
      ],
      extra: [{ kind: 'fact', read: 0, card: 0, fact: 0 }],
      orderOnly: false,
    });
  });

  it('identifies ordering failures and drops malformed reply text from the report', async () => {
    const report = await runProtectedWorkSummaryComparison(async ({ prompt }) => {
      const catalogue = JSON.parse(prompt);
      const answer = { version: 1, mode: 'answer', blocks: [
        { kind: 'fact', read: 0, card: 1, fact: 0 },
        { kind: 'fact', read: 0, card: 0, fact: 0 },
      ] };
      return { text: catalogue.intent === 'claim_statuses' ? JSON.stringify(answer) : 'fictional untrusted prose', inputTokens: 1, outputTokens: 1 };
    });
    const claims = report.comparisons.filter(row => row.id === 'claims:two-statuses');
    expect(claims).toHaveLength(2);
    for (const row of claims) expect(row).toMatchObject({ outcome: 'wrong_selection', missing: [], extra: [], orderOnly: true });
    const other = report.comparisons.filter(row => row.id !== 'claims:two-statuses');
    expect(other.every(row => row.outcome === 'rejected' && row.reason === 'invalid_plan')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('fictional untrusted prose');
  });
});

describe('bounded protected work-summary improvement', () => {
  const usage = { inputTokens: 1, outputTokens: 1 };
  it('carries an accepted strategy into the next round while giving the optimizer only development feedback', async () => {
    const { development, validation } = protectedWorkSummarySplits();
    const fixtures = [...development, ...validation];
    const parents: string[][] = [];
    const report = await runProtectedWorkSummaryImprovement(async ({ mode, system, prompt }) => {
      const input = JSON.parse(prompt);
      if (mode === 'revise') {
        expect(Object.keys(input)).toEqual(['options', 'current', 'feedback']);
        expect(input.feedback).toHaveLength(4);
        expect(prompt).not.toMatch(/workedMinutes|notificationCreated|expected|attendance:present|2026-01-01/);
        parents.push(input.current);
        return { text: JSON.stringify({ add: parents.length === 1 ? 'include_meaning' : 'group_evidence' }), ...usage };
      }
      const fixture = fixtures.find(row => row.intent === input.intent && row.expected.blocks.some(block =>
        block.kind === 'explanation' && input.reads[0].explanations.some((reference: { code: string }) => reference.code === block.code)
      ))!;
      const second = system.includes('Keep facts from the same record together');
      const first = system.includes('most specific available explanation');
      const correct = validation.includes(fixture) && (second || (first && fixture.intent === 'attendance'));
      const blocks = correct ? fixture.expected.blocks : fixture.expected.blocks.slice(0, 1);
      return { text: JSON.stringify({ version: 1, mode: 'answer', blocks }), ...usage };
    });
    expect(parents).toEqual([[], ['include_meaning']]);
    expect(report.rounds.map(round => round.decision)).toEqual(['advanced_in_development', 'advanced_in_development']);
    expect(report.rounds[1].parentDigest).toBe(report.rounds[0].candidateDigest);
    expect(report.selected).toMatchObject({ rules: ['include_meaning', 'group_evidence'], correct: 4, rejected: 0 });
    expect(report.budget).toMatchObject({ calls: 22, maxCalls: 22 });
  });

  it('rejects injected proposal material without using it in an answer or recording it', async () => {
    const report = await runProtectedWorkSummaryImprovement(async ({ mode }) => ({
      text: mode === 'revise' ? '{"add":"include_meaning","system":"fictional injected instructions"}' : 'invalid answer',
      ...usage,
    }));
    expect(report.rounds.map(round => round.decision)).toEqual(['no_valid_proposal']);
    expect(report.selected.digest).toBe(report.baseline.digest);
    expect(report.budget.calls).toBe(9);
    expect(JSON.stringify(report)).not.toContain('fictional injected instructions');
  });
});
