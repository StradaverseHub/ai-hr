import { describe, expect, it } from 'vitest';
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
