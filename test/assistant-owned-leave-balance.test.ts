import { describe, expect, it } from 'vitest';
import { selectOwnLeaveBalance } from '../lib/ai/assistant-owned-leave-balance';
import { selectOwnRequestStatuses } from '../lib/ai/assistant-owned-request-status';
import { adjudicatePrivateAssistantTerminal, capturePrivateAssistantTask } from '../lib/ai/provider-assistant-policy';

function catalogue(intent: string, available = true, selectedCards = 1) {
  const cards = Array.from({ length: selectedCards }, (_, index) => ({
    card: index + 2,
    facts: [
      { fact: 5, field: 'pending', available },
      { fact: 1, field: 'available', available: true },
      { fact: 4, field: 'taken', available: true },
    ],
  }));
  return capturePrivateAssistantTask({
    version: 1, operation: 'conversation', intent, strategy: 'baseline_v1',
    reads: [{ read: 3, module: 'leave', cards, explanations: [] }],
  }).local;
}

describe('owned leave balance selection', () => {
  it.each([['leave_available', 1], ['leave_taken', 4], ['leave_pending', 5]] as const)(
    'selects the requested %s reference and preserves the authorized ordinals',
    (intent, fact) => {
      const source = catalogue(intent);
      const plan = selectOwnLeaveBalance(source);
      expect(plan).toEqual({ version: 1, mode: 'answer', blocks: [{ kind: 'fact', read: 3, card: 2, fact }] });
      expect(adjudicatePrivateAssistantTerminal(JSON.stringify(plan), source)).toEqual(plan);
    },
  );

  it('does not substitute a different available field or choose an unselected card', () => {
    expect(selectOwnLeaveBalance(catalogue('leave_pending', false))).toBeUndefined();
    expect(selectOwnLeaveBalance(catalogue('leave_pending', true, 0))).toBeUndefined();
    expect(selectOwnLeaveBalance(catalogue('leave_pending', true, 2))).toBeUndefined();
    expect(selectOwnLeaveBalance(catalogue('leave_requests'))).toBeUndefined();
  });
});

function statuses(count: number, options: { hiddenStatus?: boolean; hiddenDate?: boolean; module?: string; intent?: string } = {}) {
  return capturePrivateAssistantTask({
    version: 1, operation: 'conversation', intent: options.intent ?? 'leave_requests', strategy: 'baseline_v1',
    reads: [{ read: 3, module: options.module ?? 'approvals', explanations: [], cards: Array.from({ length: count }, (_, card) => ({
      card, facts: [
        { fact: 1, field: 'status', available: !options.hiddenStatus || card > 0 },
        { fact: 2, field: 'from', available: !options.hiddenDate },
      ],
    })) }],
  }).local;
}

describe('owned request status selection', () => {
  it('keeps the scoped order and omits an unavailable date', () => {
    const plan = selectOwnRequestStatuses(statuses(2));
    expect(plan?.blocks.map(({ card, ...block }) => block.kind === 'fact' && [card, block.fact])).toEqual([
      [0, 1], [0, 2], [1, 1], [1, 2],
    ]);
    expect(selectOwnRequestStatuses(statuses(1, { hiddenDate: true }))?.blocks).toEqual([{ kind: 'fact', read: 3, card: 0, fact: 1 }]);
  });

  it('fits a full ten-record source without leaving any status out', () => {
    const source = statuses(10);
    const plan = selectOwnRequestStatuses(source);
    expect(plan?.blocks).toEqual(Array.from({ length: 10 }, (_, card) => ({ kind: 'fact', read: 3, card, fact: 1 })));
    expect(adjudicatePrivateAssistantTerminal(JSON.stringify(plan), source)).toEqual(plan);
  });

  it('refuses incomplete statuses, empty results and other sources', () => {
    expect(selectOwnRequestStatuses(statuses(2, { hiddenStatus: true }))).toBeUndefined();
    expect(selectOwnRequestStatuses(statuses(0))).toBeUndefined();
    expect(selectOwnRequestStatuses(statuses(1, { module: 'claims' }))).toBeUndefined();
    expect(selectOwnRequestStatuses(statuses(1, { intent: 'work_profile' }))).toBeUndefined();
  });
});
