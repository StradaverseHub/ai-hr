import { describe, expect, it } from 'vitest';
import { runProtectedLeaveComparison } from '../scripts/experiments/protected-leave-comparison';
import { runProtectedWorkSummaryComparison } from '../scripts/experiments/protected-work-summary-comparison';
import { leaveAnswerFormat } from '../scripts/experiments/leave-answer-format';
import { runLeaveImprovement, type PilotModel } from '../scripts/teras/leave-improvement';
import { ASSISTANT_CONVERSATION_HOLDOUTS } from '../lib/ai/assistant-conversation-holdouts';

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
    expect(report.comparisons.filter(row => row.id === 'claims:two-statuses').map(row => row.outcome)).toEqual(['rejected', 'rejected']);
    expect(report.comparisons.filter(row => row.id === 'attendance:late').map(row => row.outcome)).toEqual(['wrong_selection', 'wrong_selection']);
  });
});
