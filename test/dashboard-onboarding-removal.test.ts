import { describe, expect, it } from 'vitest';
import { CARD_META, ROLE_CARDS, type DashboardRole } from '../lib/dashboard-cards';

/**
 * Feedback 614a8fd3 — "Remove Onboarding Summary Card from Manager Dashboard".
 * The onboardingWeek card is gone from the manager set entirely: not in ROLE_CARDS, not in CARD_META,
 * and the manager keeps exactly its three remaining cards in order. Employee/admin sets are untouched,
 * and config↔meta parity holds (no orphaned meta id, no card without meta).
 */
describe('onboarding card removal (614a8fd3)', () => {
  it('manager set is exactly the three remaining cards, in order', () => {
    expect(ROLE_CARDS.manager).toEqual(['teamAwayToday', 'approvalRequests', 'upcomingReminders']);
  });

  it('no role set references onboardingWeek', () => {
    for (const role of Object.keys(ROLE_CARDS) as DashboardRole[]) {
      expect(ROLE_CARDS[role]).not.toContain('onboardingWeek');
    }
  });

  it('CARD_META has no onboardingWeek entry', () => {
    expect(Object.keys(CARD_META)).not.toContain('onboardingWeek');
  });

  it('employee and admin card sets are untouched', () => {
    expect(ROLE_CARDS.employee).toEqual(['leaveBalance', 'nextHoliday', 'pendingTasks']);
    expect(ROLE_CARDS.hr_admin).toEqual(['headcount', 'pendingLeave', 'companies', 'latestPayroll']);
  });

  it('every card in every role has meta, and every meta id is used by some role (parity)', () => {
    const usedIds = new Set(Object.values(ROLE_CARDS).flat());
    for (const id of usedIds) {
      expect(CARD_META[id], `missing meta for ${id}`).toBeDefined();
    }
    for (const metaId of Object.keys(CARD_META)) {
      expect(usedIds.has(metaId as never), `orphaned meta id ${metaId}`).toBe(true);
    }
  });
});
