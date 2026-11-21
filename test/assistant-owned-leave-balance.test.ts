import { describe, expect, it } from 'vitest';
import { selectOwnLeaveBalance } from '../lib/ai/assistant-owned-leave-balance';
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
