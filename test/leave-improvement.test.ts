import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { runProtectedLeaveComparison, runProtectedLeaveRouting } from '../scripts/experiments/protected-leave-comparison';
import { selectProtectedLeaveCount } from '../lib/ai/assistant-leave-count';
import { describePairedLeaveRoutingCases, scorePairedLeaveRoutingHoldout, scoreProtectedLeaveRoutingHoldout } from '../scripts/experiments/protected-leave-routing-holdout';
import { signPairedLeaveEvaluation, verifyPairedLeaveEvaluations } from '../lib/ai/assistant-leave-evaluation-receipt';
import { installedLocalLeaveEvidence } from '../core/assistant-local-leave-evidence';
import { protectedWorkSummarySplits, runProtectedWorkSummaryComparison } from '../scripts/experiments/protected-work-summary-comparison';
import { PROTECTED_CATALOGUE_FORMAT, protectedCatalogueAnswerJsonSchema } from '../scripts/experiments/protected-catalogue-answer-format';
import { protectedIndexedAnswer } from '../scripts/experiments/protected-indexed-answer-format';
import { runProtectedWorkSummaryImprovement } from '../scripts/experiments/protected-work-summary-improvement';
import { scoreProtectedWorkSummaryHoldout } from '../scripts/experiments/protected-work-summary-holdout';
import { assertFreshExplanationCases, scoreFreshExplanationRouting, scoreProtectedExplanationHoldout } from '../scripts/experiments/protected-explanation-holdout';
import { assessExplanationRouting } from '../scripts/experiments/assess-explanation-routing';
import { historicalExplanationCases } from '../scripts/experiments/write-historical-explanation-cases';
import { compareProtectedExplanationMeanings } from '../scripts/experiments/protected-explanation-meanings';
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
import { capturePrivateAssistantTask } from '../lib/ai/provider-assistant-policy';

it('presents every available meaning only in the glossary arm and scores paired gains by locale', async () => {
  const cases = [historicalExplanationCases('en'), historicalExplanationCases('ms')].flat();
  let previousChoices: string[] = [];
  let requestNumber = 0;
  const report = await compareProtectedExplanationMeanings(async ({ mode, prompt }) => {
    expect(mode).toBe('answer');
    const fixture = cases[Math.floor(requestNumber / 3)];
    const arm = requestNumber++ % 3;
    const request = JSON.parse(prompt);
    expect(request.module).toBe(fixture.module);
    expect(request).not.toHaveProperty('expected');
    const correct = 'specialist_finding:' + fixture.expected;
    if (arm === 0) previousChoices = request.choices;
    expect(request.choices).toEqual(previousChoices);
    if (arm > 0) expect(request.focus).toBe(fixture.focus);
    else expect(request).not.toHaveProperty('focus');
    if (arm === 2) expect(Object.keys(request.meanings)).toEqual(previousChoices);
    else expect(request).not.toHaveProperty('meanings');
    const choice = arm === 2 ? correct : previousChoices.find(choice => choice !== correct);
    return { text: JSON.stringify({choice}), inputTokens: 10 + arm, outputTokens: 2 };
  });
  expect(report).toMatchObject({
    passes: true, releaseAuthorized: false, budget: {calls: 3 * cases.length},
    locales: ['en', 'ms'].map(locale => ({
      locale, original: {correct: 0, regressions: 0}, focused: {correct: 0, regressions: 0},
      meanings: {rejected: 0}, passes: true,
    })),
  });
  for (const locale of report.locales) {
    expect(locale.focused.gains).toBe(locale.cases);
    expect(locale.tokens.meanings.input).toBe(12 * locale.cases);
  }
});

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
      expect(Object.keys(request.options)).toEqual(['include_source_focus']);
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
    eligibleRevisions: ['include_source_focus'], revision: 'include_source_focus',
    regressions: 0, advanced: true, releaseAuthorized: false,
    budget: { calls: 9, inputTokens: 18, outputTokens: 9 },
  });
});

it('refuses a proposed wording change that leaves colliding inputs unchanged', async () => {
  const report = await runProtectedExplanationImprovement(async ({ mode, system, prompt }) => {
    if (mode === 'revise') return { text: '{"change":"compare_choice_meanings"}', inputTokens: 2, outputTokens: 1 };
    const request = JSON.parse(prompt);
    expect(request).not.toHaveProperty('focus');
    expect(system).not.toContain('Compare the meanings');
    return { text: JSON.stringify({ choice: request.choices[0] }), inputTokens: 2, outputTokens: 1 };
  });
  expect(report).toMatchObject({
    eligibleRevisions: ['include_source_focus'], revision: null, candidate: null, advanced: false,
    validationCases: 2, budget: { calls: 7 },
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
      retrievalFirst: {
        correct: 4, rejected: 0, modelCalls: 1, versusFocused: { gains: 0, regressions: 0 },
        versusOriginal: { gains: 2, regressions: 0 }, versusDeterministic: { gains: 1, regressions: 0 },
      },
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

  it('uses the declared Malay catalogue while preserving the model request shape', async () => {
    const savedReport = bytes(report);
    const localized = cases.map((row, index) => ({
      ...row, focus: ['Tuntutan draf tersimpan', 'Kelulusan tuntutan sudah dibayar',
        'Kelayakan baharu cuti gantian', 'Adakah bayaran terbukti pada slip gaji'][index],
    }));
    const input = bytes({...JSON.parse(spec(savedReport, localized).toString()), locale: 'ms'});
    const result = await scoreProtectedExplanationHoldout(input, sha(input), savedReport, modelDigest, async ({prompt}) => {
      const request = JSON.parse(prompt);
      expect(request).not.toHaveProperty('locale');
      return {text: JSON.stringify({choice: request.choices[0]}), inputTokens: 1, outputTokens: 1};
    });
    expect(result).toMatchObject({locale: 'ms', comparator: 'canonical_malay_explanation_retrieval_v1'});
    expect(result.deterministic.correct).toBeGreaterThan(0);
    expect(result.retrievalFirst.modelCalls).toBeLessThan(localized.length);
  });

  it('refuses substitutions of the fixed margin or exposure bytes before inference', async () => {
    const developmentReport = bytes(report);
    const english = spec(developmentReport);
    const malay = bytes({...JSON.parse(english.toString()), locale: 'ms'});
    const run = (minimumMargin: number) => {
      const plan = bytes({version: 1, minimumMargin, englishSha256: sha(english), malaySha256: sha(malay)});
      return scoreFreshExplanationRouting({plan, planSha256: sha(plan), developmentReport, english, malay,
        exposures: {english, malay, challenge: english}}, modelDigest, async () => { throw Error('Unexpected model call'); });
    };
    await expect(run(4)).rejects.toThrow();
    await expect(run(5)).rejects.toThrow('Invalid frozen protected holdout');
  });
});

it('rejects repeated wording and translated expected findings in either fresh locale', () => {
  const prior = {
    module: 'claims', focus: 'Is this claim still a draft?', expected: 'specialist_finding:claim_draft_not_submitted',
  } as const;
  const fresh = {
    module: 'claims', focus: 'Adakah tuntutan yang diluluskan sudah dibayar?', expected: 'specialist_finding:claim_approved_not_paid',
  } as const;
  expect(() => assertFreshExplanationCases([prior], [fresh])).not.toThrow();
  expect(() => assertFreshExplanationCases([prior], [{...fresh, focus: 'Is this CLAIM still a draft.'}])).toThrow('repeat');
  expect(() => assertFreshExplanationCases([prior], [{...prior, focus: 'Adakah tuntutan ini masih draf?'}])).toThrow('repeat');
  expect(() => assertFreshExplanationCases([prior], [fresh, {...fresh, focus: 'Did the payment actually go through?'}])).toThrow('repeat');
});

describe('paired English and Malay routing evidence', () => {
  const languageReport = (locale: 'en' | 'ms', gains: number, regressions: number, modelDigest = 'a'.repeat(64)) => ({
    evidence: 'offline_explanation_revision_holdout', releaseAuthorized: false, locale,
    comparator: locale === 'en' ? 'canonical_english_explanation_retrieval_v2' : 'canonical_malay_explanation_retrieval_v1',
    cases: 5, candidate: {correct: 3, rejected: 0}, modelDigest,
    developmentReportDigest: 'b'.repeat(64), holdoutDigest: (locale === 'en' ? 'c' : 'd').repeat(64),
    answerFormatDigest: routingDigest(EXPLANATION_ANSWER_FORMAT), generationOptions: EXPLANATION_GENERATION_OPTIONS,
    retrievalMargins: [{minimumMargin: 4, correct: 3 + gains - regressions, rejected: 0, modelCalls: 3,
      versusFocused: {gains, regressions}}],
  });
  const bind = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return {bytes, sha256: createHash('sha256').update(bytes).digest('hex')};
  };

  it('requires paired quality in each language even when the combined score improves', () => {
    const english = bind(languageReport('en', 1, 0));
    const regressed = assessExplanationRouting(4, english, bind(languageReport('ms', 1, 1)));
    expect(regressed).toMatchObject({eligibleForFreshEvaluation: false, preservesQuality: false, hasGain: true, savesCalls: true});
    expect(assessExplanationRouting(4, english, bind(languageReport('ms', 0, 0)))).toMatchObject({
      eligibleForFreshEvaluation: true, releaseAuthorized: false,
    });
  });

  it('refuses missing margins, duplicated locales, altered bytes and mismatched model identities', () => {
    const english = bind(languageReport('en', 1, 0));
    const malay = bind(languageReport('ms', 0, 0));
    expect(() => assessExplanationRouting(8, english, malay)).toThrow('not evaluated');
    expect(() => assessExplanationRouting(4, english, english)).toThrow('Distinct English and Malay');
    expect(() => assessExplanationRouting(4, english, {...malay, sha256: english.sha256})).toThrow();
    const differentModel = bind(languageReport('ms', 0, 0, 'e'.repeat(64)));
    expect(() => assessExplanationRouting(4, english, differentModel)).toThrow('share a model and parent');
  });
});

it.each(['en', 'ms'] as const)('reuses earlier %s fictional business questions and labels on unexposed modules', locale => {
  const cases = historicalExplanationCases(locale);
  expect(cases.length).toBeGreaterThanOrEqual(4);
  expect(new Set(cases.map(row => row.module)).size).toBe(cases.length);
  for (const row of cases) {
    expect(explanationCases().some(exposed => exposed.module === row.module)).toBe(false);
    expect(['claims', 'rewards']).not.toContain(row.module);
    const source = ASSISTANT_CONVERSATION_HOLDOUTS.find(item => item.locale === locale && item.category === 'domain' &&
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
  const withFictionalTitle = (fixture: ProtectedAnswerFixture) => ({
    ...fixture, id: 'fictional-oracle-' + fixture.id,
    reads: fixture.reads.map(read => ({ ...read, presentation: {
      ...read.presentation, cards: read.presentation.cards.map((card, index) => index === 0 ? {
        ...card, title: { kind: 'text' as const, value: 'Fictional value sentinel' },
        facts: card.facts.slice(0, -1),
      } : card),
    } })),
  });
  const fictional = published.map(withFictionalTitle);
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
    expect(calls).toBe(8);
    expect(report).toMatchObject({
      cases: 2, repetitions: 2, gains: 2, regressions: 0, candidateCorrectByRepeat: [2, 2], candidateRejected: 0,
      meetsThreshold: true, releaseAuthorized: false, usage: { calls: 8, inputTokens: 80, outputTokens: 40 },
    });
    expect(JSON.stringify(report)).not.toMatch(/fictional-oracle|Fictional value sentinel|progressTotal/);
  });

  it('counts gains across both repeats and catches a lost answer even when both arms miss in the same repeat', async () => {
    const bytes = file();
    const seen = new Map<string, number>();
    const firstCaseCallOrder: string[] = [];
    const report = await scoreProtectedWorkSummaryHoldout(bytes, hash(bytes), developmentReport, modelDigest,
      async ({ system, prompt }) => {
        const fixture = fictional.find(row => row.intent === JSON.parse(prompt).intent)!;
        const isFirstCase = fixture === fictional[0];
        const arm = system.includes(guidanceOptions.include_meaning) ? 'candidate' : 'parent';
        if (isFirstCase) firstCaseCallOrder.push(arm);
        const identity = `${fixture.id}:${arm}`;
        const repeat = seen.get(identity) ?? 0;
        seen.set(identity, repeat + 1);
        const plan = adjudicateAssistantAnswerPlan(fixture.expected, fixture.reads);
        if (plan.mode !== 'answer') throw Error('Expected an answer fixture.');
        const correct = isFirstCase ? repeat === 0 : arm === 'candidate';
        return {
          text: JSON.stringify(correct ? plan : {...plan, blocks: plan.blocks.slice(0, 1)}),
          inputTokens: 10, outputTokens: 5,
        };
      });
    expect(firstCaseCallOrder).toEqual(['parent', 'candidate', 'candidate', 'parent']);
    expect(report).toMatchObject({
      repetitions: 2, candidateCorrect: 1, candidateCorrectByRepeat: [2, 1], candidateRejected: 0,
      parentCorrect: 0, gains: 1, regressions: 1, meetsThreshold: false,
    });
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

  it('requires a passing immediate parent and fresh cases, then measures incremental and cumulative gain', async () => {
    const firstCases = file();
    const fresh = validation.slice(0, 2).map(withFictionalTitle);
    const correct = (fixture: ProtectedAnswerFixture) => ({
      text: JSON.stringify(fixture.expected), inputTokens: 10, outputTokens: 5,
    });
    const wrong = { text: '{}', inputTokens: 10, outputTokens: 5 };
    const firstScore = await scoreProtectedWorkSummaryHoldout(firstCases, hash(firstCases), developmentReport, modelDigest,
      async ({ system, prompt }) => system.includes(guidanceOptions.include_meaning)
        ? correct(fictional.find(row => row.intent === JSON.parse(prompt).intent)!) : wrong);
    expect(firstScore.meetsThreshold).toBe(true);
    const previous = { cases: firstCases, report: Buffer.from(JSON.stringify(firstScore)) };
    const revisedRules = ['include_meaning', 'group_evidence'] as const;
    const revisedDigest = protectedStrategyDigest(revisedRules);
    const parent = JSON.parse(developmentReport.toString());
    const secondDevelopment = Buffer.from(JSON.stringify({
      ...parent, rounds: [...parent.rounds, {
        number: 2, parentDigest: parent.selected.digest, add: 'group_evidence', candidateDigest: revisedDigest,
        decision: 'advanced_in_development', validation: { correct: 3, rejected: 0, regressions: 0 },
      }], selected: { digest: revisedDigest, rules: revisedRules, correct: 3, rejected: 0 },
    }));
    const secondFile = (cases: readonly ProtectedAnswerFixture[], evidence: Buffer) => Buffer.from(JSON.stringify({
      version: 3, cases, modelDigest, minimumGain: 2, developmentReportDigest: hash(secondDevelopment),
      parentRules: ['include_meaning'], parentDigest: parent.selected.digest, candidateRules: revisedRules,
      candidateDigest: revisedDigest, previousReportDigest: hash(evidence),
    }));
    const bytes = secondFile(fresh, previous.report);
    const noCall = vi.fn<PilotModel>();
    await expect(scoreProtectedWorkSummaryHoldout(bytes, hash(bytes), secondDevelopment, modelDigest, noCall))
      .rejects.toThrow('Invalid frozen protected holdout');
    const failed = Buffer.from(JSON.stringify({ ...firstScore, meetsThreshold: false }));
    const citesFailed = secondFile(fresh, failed);
    await expect(scoreProtectedWorkSummaryHoldout(citesFailed, hash(citesFailed), secondDevelopment, modelDigest, noCall,
      { ...previous, report: failed })).rejects.toThrow('Invalid frozen protected holdout');
    const replay = secondFile(fictional.map(row => ({ ...row, id: 'renamed-' + row.intent })), previous.report);
    await expect(scoreProtectedWorkSummaryHoldout(replay, hash(replay), secondDevelopment, modelDigest, noCall, previous))
      .rejects.toThrow('Holdout repeats an exposed');
    expect(noCall).not.toHaveBeenCalled();

    for (const originalCorrect of [false, true]) {
      const scored = await scoreProtectedWorkSummaryHoldout(bytes, hash(bytes), secondDevelopment, modelDigest,
        async ({ system, prompt }) => {
          const fixture = fresh.find(row => row.intent === JSON.parse(prompt).intent)!;
          const original = !system.includes(guidanceOptions.include_meaning);
          if (system.includes(guidanceOptions.group_evidence) || (original && originalCorrect)) return correct(fixture);
          return wrong;
        }, previous);
      expect(scored).toMatchObject({
        gains: 2, regressions: 0, meetsThreshold: !originalCorrect, previousReportDigest: hash(previous.report),
        canonical: { correct: originalCorrect ? 2 : 0, gains: originalCorrect ? 0 : 2, regressions: 0 },
        repetitions: 2, usage: { calls: 12, inputTokens: 120, outputTokens: 60 },
      });
    }
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

  it('routes the exact selected own leave count and preserves the reviewed strategies on the same catalogue', async () => {
    const report = await runProtectedLeaveRouting(async ({prompt}) => {
      expect(prompt).not.toMatch(/Fictional|annual leave/i);
      const {local} = capturePrivateAssistantTask(JSON.parse(prompt));
      if (local.operation !== 'conversation') throw Error('Expected a conversation catalogue.');
      const fields = {leave_available:'available',leave_pending:'pending',leave_taken:'taken'};
      const [read] = local.reads;
      const [card] = read.cards;
      const fact = card.facts.find(row => row.field === fields[local.intent as keyof typeof fields] && row.available);
      expect(fact).toBeDefined();
      return {text:JSON.stringify({version:1,mode:'answer',blocks:[{kind:'fact',read:read.read,card:card.card,fact:fact!.fact}]}),
        inputTokens:1,outputTokens:1};
    });
    expect(report).toMatchObject({releaseAuthorized:false,cases:12,direct:12,directCorrect:12,
      estimatedCallsPerStrategy:0,budget:{calls:24}});
    expect(report.references.map(row=>[row.correct,row.routedCorrect,row.regressions])).toEqual([[12,12,0],[12,12,0]]);
  });

  it('abstains on unavailable counts, multiple candidates and intents without an exact leave field', () => {
    const fact = {fact:2,field:'pending',available:true};
    const card = {card:0,facts:[fact]};
    const read = {read:0,module:'leave',cards:[card],explanations:[]};
    const request = {version:1,operation:'conversation',intent:'leave_pending',strategy:'baseline_v1',reads:[read]};
    const select = (input: unknown) => selectProtectedLeaveCount(capturePrivateAssistantTask(input).local);
    expect(select(request)).toEqual({kind:'fact',read:0,card:0,fact:2});
    for(const input of [
      {...request,intent:'leave_requests'},
      {...request,reads:[{...read,module:'payroll'}]},
      {...request,reads:[{...read,cards:[{...card,facts:[{...fact,available:false}]}]}]},
      {...request,reads:[{...read,cards:[{...card,facts:[fact,{...fact,fact:3}]}]}]},
      {...request,reads:[{...read,cards:[card,{...card,card:1}]}]},
    ]) expect(select(input)).toBeNull();
  });
});

describe('evaluator-owned leave routing suite', () => {
  const candidateSha = 'a'.repeat(40);
  const balance = { leaveType: 'Fictional vacation', available: -0.75, taken: 2.5, pending: 1, withheld: false };
  const company = { company: 'Fictional primary company', balances: [balance] };
  const otherCompany = { company: 'Fictional second company', balances: [{ ...balance, taken: 17.25 }] };
  const question = 'My leave balance';
  const defer = { kind: 'defer' };
  const cases = [
    { scenario: { question, employments: [company] },
      expected: { kind: 'direct', employment: 0, balance: 0, field: 'available', value: -0.75 } },
    { scenario: { question: 'How much leave have I taken?', employments: [company, otherCompany],
      clarification: { slot: 'employment', answer: otherCompany.company } },
      expected: { kind: 'direct', employment: 1, balance: 0, field: 'taken', value: 17.25 } },
    { scenario: { question, employments: [company, otherCompany] }, expected: defer },
    { scenario: { question, employments: [{ ...company, balances: [{ ...balance, available: null, withheld: true }] }] }, expected: defer },
    { scenario: { question: 'Show me Mina Fictional’s balance', employments: [company] }, expected: defer },
  ];
  function frozen(rows: readonly unknown[] = cases) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, candidateSha, cases: rows }));
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
  }

  it('validates the selected employment, field and value, and returns aggregate results only', () => {
    const { bytes, digest } = frozen();
    const score = scoreProtectedLeaveRoutingHoldout(bytes, digest, candidateSha);
    expect(score).toEqual({ evidence: 'offline_leave_routing_holdout', candidateSha, holdoutDigest: digest,
      cases: 5, expectedDirect: 2, correctDirect: 2, correctDeferrals: 3, wrongDirect: 0,
      unexpectedDirect: 0, missedDirect: 0, meetsThreshold: true, releaseAuthorized: false });
    expect(JSON.stringify(score)).not.toMatch(/Fictional|17\.25|leave balance/);
  });

  it('fails an incorrect count or subject and an answer where the evaluator requires deferral', () => {
    const rows = cases.map((item, index) => index === 0 ? { ...item, expected: { ...item.expected, value: 0 } }
      : index === 1 ? { ...item, expected: defer }
      : index === 2 ? { ...item, expected: { kind: 'direct', employment: 0, balance: 0, field: 'available', value: -0.75 } } : item);
    const { bytes, digest } = frozen(rows);
    expect(scoreProtectedLeaveRoutingHoldout(bytes, digest, candidateSha)).toMatchObject({
      meetsThreshold: false, wrongDirect: 1, unexpectedDirect: 1, missedDirect: 1, correctDeferrals: 2 });
  });

  it('refuses a mismatched commit or digest, a repeated scenario and a one-sided suite', () => {
    const { bytes, digest } = frozen();
    expect(() => scoreProtectedLeaveRoutingHoldout(bytes, digest, 'b'.repeat(40))).toThrow('Invalid frozen leave routing suite');
    expect(() => scoreProtectedLeaveRoutingHoldout(bytes, 'b'.repeat(64), candidateSha)).toThrow('Invalid frozen protected holdout');
    for (const rows of [[...cases, cases[0]], cases.map(item => ({ ...item, expected: defer }))]) {
      const input = frozen(rows);
      expect(() => scoreProtectedLeaveRoutingHoldout(input.bytes, input.digest, candidateSha)).toThrow('Use distinct fictional scenarios');
    }
  });

  const modelDigest = 'f'.repeat(64);
  const trialCases = [cases[0], { scenario:{ question:'How much leave have I taken?', employments:[otherCompany] },
    expected:{ kind:'direct', employment:0, balance:0, field:'taken', value:17.25 } },
    ...cases.slice(2), { ...cases[1], expected:defer }];
  function pair(rows: readonly unknown[] = trialCases, minimumSavedCalls = 2) {
    const bytes = Buffer.from(JSON.stringify({ version: 2, candidateSha, modelDigest, minimumSavedCalls, cases: rows }));
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
  }
  function baseline(fieldForAvailable = 'available') {
    return async ({ mode, prompt }: Parameters<PilotModel>[0]) => {
      expect(mode).toBe('answer');
      expect(prompt).not.toMatch(/Fictional|17\.25|leave balance|employmentId/);
      const { local } = capturePrivateAssistantTask(JSON.parse(prompt));
      if (local.operation !== 'conversation') throw Error('Expected a protected catalogue.');
      const [read] = local.reads, [card] = read.cards;
      const fact = card.facts.find(row => row.field === (local.intent === 'leave_taken' ? 'taken' : fieldForAvailable));
      if (!fact) throw Error('Expected a fictional recorded fact.');
      return { text: JSON.stringify({ version: 1, mode: 'answer', blocks: [{ kind: 'fact', read: read.read, card: card.card, fact: fact.fact }] }), inputTokens: 9, outputTokens: 4 };
    };
  }

  it('measures avoided model calls even when baseline quality is already perfect', async () => {
    const { bytes, digest } = pair();
    const score = await scorePairedLeaveRoutingHoldout(bytes, digest, candidateSha, modelDigest, baseline());
    expect(score).toMatchObject({ meetsThreshold: true, releaseAuthorized: false, baselineCalls: 2, baselineCorrect: 2,
      candidateFallbackCalls: 0, candidateCorrect: 2, gains: 0, regressions: 0, savedCalls: 2,
      baselineInputTokens: 18, baselineOutputTokens: 8, correctDeferrals: 4, scope: 'single_active_own_employment' });
    expect(JSON.stringify(score)).not.toMatch(/Fictional|17\.25|leave balance/);
  });

  it('blocks a paired regression and preflights source and budget mismatches before transport', async () => {
    const regressed = pair(trialCases.map((item, index) => index === 0 ? { ...item,
      expected: { kind: 'direct', employment: 0, balance: 0, field: 'pending', value: 1 } } : item));
    await expect(scorePairedLeaveRoutingHoldout(regressed.bytes, regressed.digest, candidateSha, modelDigest, baseline('pending')))
      .resolves.toMatchObject({ meetsThreshold: false, regressions: 1, savedCalls: 1 });
    let calls = 0;
    const guard: PilotModel = async input => { calls++; return baseline()(input); };
    const missing = pair(trialCases.map((item, index) => index === 1 ? { ...item, expected: { ...item.expected, value: 99 } } : item));
    await expect(scorePairedLeaveRoutingHoldout(missing.bytes, missing.digest, candidateSha, modelDigest, guard)).rejects.toThrow('no verified source');
    const excessive = pair(trialCases, 3);
    await expect(scorePairedLeaveRoutingHoldout(excessive.bytes, excessive.digest, candidateSha, modelDigest, guard)).rejects.toThrow('Saved-call target');
    const broad = pair(cases);
    await expect(scorePairedLeaveRoutingHoldout(broad.bytes, broad.digest, candidateSha, modelDigest, guard)).rejects.toThrow('trial employment scope');
    await expect(scorePairedLeaveRoutingHoldout(regressed.bytes, regressed.digest, candidateSha, 'a'.repeat(64), guard)).rejects.toThrow('Invalid frozen paired leave suite');
    expect(calls).toBe(0);
  });

  it('authenticates two independently enrolled fictional scorers without exposing the held cases', async () => {
    const id = (suffix: string) => `11111111-1111-4111-8111-${suffix.padStart(12, '0')}`;
    const keys = [generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')];
    const secondCases = trialCases.map(item => ({ ...item, scenario: { ...item.scenario,
      employments: item.scenario.employments.map(employment => ({ ...employment, company: employment.company + ' East' })),
    } }));
    const inputs = [pair(), pair(secondCases)];
    const fingerprints = inputs.map(input => describePairedLeaveRoutingCases(input.bytes, input.digest));
    // JSON layout, case order, letter case and extra whitespace cannot create a second scenario set.
    const reflowed = pair([...trialCases].reverse().map(item => ({ ...item, scenario: { ...item.scenario,
      question: item.scenario.question.toUpperCase().replace(/ /g, '  '),
    } })));
    expect(reflowed.digest).not.toBe(inputs[0].digest);
    expect(describePairedLeaveRoutingCases(reflowed.bytes, reflowed.digest).caseDigests).toEqual(fingerprints[0].caseDigests);
    const generationOptions = { temperature: 0, seed: 42, num_predict: 512 };
    const answerFormatDigest = routingDigest('json');
    const plan = {
      version: 2, trialId: id('1'), tenantId: id('2'), authorId: id('3'), approverId: id('4'),
      candidateSha, candidateDigest: 'c'.repeat(64), baselineDigest: 'b'.repeat(64), sourceDigest:'d'.repeat(64),
      modelDigest, generationOptionsDigest: routingDigest(generationOptions), answerFormatDigest,
      committedAt: '2026-11-21T00:00:00Z', expiresAt: '2026-11-22T00:00:00Z',
      evaluators: fingerprints.map((fingerprint, index) => ({ id: id(String(index + 5)), publicKey: keys[index].publicKey.export({format:'jwk'}).x,
        ...fingerprint, minimumSavedCalls: 2 })),
    };
    const freezePlan = (value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
    };
    const committed = freezePlan(plan), now = new Date('2026-11-21T06:00:00Z');
    const reports = await Promise.all(inputs.map(async input => ({
      ...await scorePairedLeaveRoutingHoldout(input.bytes, input.digest, candidateSha, modelDigest, baseline()),
      answerFormatDigest, generationOptions, model:'fictional:fixture',
    })));
    const receipts = reports.map((report, index) => signPairedLeaveEvaluation(committed.bytes, committed.digest,
      plan.evaluators[index].id, report, keys[index].privateKey, now));
    expect(verifyPairedLeaveEvaluations(committed.bytes, committed.digest, receipts, now))
      .toMatchObject({ candidateSha, trialId:plan.trialId, tenantId:plan.tenantId, evaluatorCount:2, savedCalls:4, releaseAuthorized:false });
    expect(JSON.stringify(receipts)).not.toMatch(/Fictional|17\.25|leave balance/);

    const refused = 'Frozen paired leave evidence could not be confirmed';
    const [first, second] = receipts;
    expect(() => verifyPairedLeaveEvaluations(committed.bytes, committed.digest, [first, first], now)).toThrow(refused);
    expect(() => verifyPairedLeaveEvaluations(committed.bytes, committed.digest, [{ ...first,
      report:{ ...first.report, baselineInputTokens: first.report.baselineInputTokens + 1 } }, second], now)).toThrow(refused);
    expect(() => verifyPairedLeaveEvaluations(committed.bytes, committed.digest, receipts, new Date(plan.expiresAt))).toThrow(refused);
    expect(() => signPairedLeaveEvaluation(committed.bytes, committed.digest, plan.evaluators[0].id,
      reports[0], keys[1].privateKey, now)).toThrow(refused);
    expect(() => signPairedLeaveEvaluation(committed.bytes, committed.digest, plan.evaluators[0].id,
      { ...reports[0], regressions:1 }, keys[0].privateKey, now)).toThrow(refused);
    expect(() => signPairedLeaveEvaluation(committed.bytes, committed.digest, plan.evaluators[0].id,
      { ...reports[0], caseSetDigest: '0'.repeat(64) }, keys[0].privateKey, now)).toThrow(refused);
    const shared = describePairedLeaveRoutingCases(reflowed.bytes, reflowed.digest);
    for (const caseDigests of [shared.caseDigests, [...fingerprints[1].caseDigests.slice(1), shared.caseDigests[0]]]) {
      const overlapping = freezePlan({ ...plan, evaluators: [plan.evaluators[0], {
        ...plan.evaluators[1], holdoutDigest: reflowed.digest, caseDigests,
      }] });
      expect(() => signPairedLeaveEvaluation(overlapping.bytes, overlapping.digest, plan.evaluators[0].id,
        reports[0], keys[0].privateKey, now)).toThrow(refused);
    }
    const conflicted = freezePlan({ ...plan, approverId: plan.evaluators[0].id });
    expect(() => signPairedLeaveEvaluation(conflicted.bytes, conflicted.digest, plan.evaluators[0].id,
      reports[0], keys[0].privateKey, now)).toThrow(refused);
    const replay = freezePlan({ ...plan, tenantId:id('8') });
    expect(() => verifyPairedLeaveEvaluations(replay.bytes, replay.digest, receipts, now)).toThrow(refused);

    const binding = { tenantId:plan.tenantId, authorId:plan.authorId, candidateDigest:plan.candidateDigest,
      baselineDigest:plan.baselineDigest, sourceDigest:plan.sourceDigest };
    try {
      vi.stubEnv('AIHR_LOCAL_LEAVE_TRIAL_BUNDLE',JSON.stringify({plan:committed.bytes.toString('base64url'),receipts}));
      vi.stubEnv('AIHR_LOCAL_LEAVE_TRIAL_PLAN_SHA256','');
      expect(installedLocalLeaveEvidence(binding,now)).toBeNull();
      vi.stubEnv('AIHR_LOCAL_LEAVE_TRIAL_PLAN_SHA256',committed.digest);
      expect(installedLocalLeaveEvidence(binding,now)).toMatchObject({kind:'paired_leave_offline_v2',planDigest:committed.digest,
        approverId:plan.approverId,expiresAt:plan.expiresAt});
      expect(installedLocalLeaveEvidence({...binding,sourceDigest:'a'.repeat(64)},now)).toBeNull();
      expect(installedLocalLeaveEvidence({...binding,tenantId:id('8')},now)).toBeNull();
      expect(installedLocalLeaveEvidence(binding,new Date(plan.expiresAt))).toBeNull();
    } finally { vi.unstubAllEnvs(); }
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
