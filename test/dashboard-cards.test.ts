import { describe, expect, it } from 'vitest';
import {
  CARD_META,
  ROLE_CARDS,
  pendingTasksCount,
  resolveDashboardRole,
  teamAwayToday,
  upcomingRemindersCount,
  type DashboardRole,
} from '../lib/dashboard-cards';

describe('resolveDashboardRole', () => {
  it('admin wins over everything (even with direct reports / manager role)', () => {
    expect(resolveDashboardRole({ admin: true, managerRole: true, hasDirectReports: true })).toBe('hr_admin');
    expect(resolveDashboardRole({ admin: true, managerRole: false, hasDirectReports: false })).toBe('hr_admin');
  });

  it('the manager platform role → manager', () => {
    expect(resolveDashboardRole({ admin: false, managerRole: true, hasDirectReports: false })).toBe('manager');
  });

  it('no role but hasDirectReports → manager (the 0110 reporting_line population)', () => {
    expect(resolveDashboardRole({ admin: false, managerRole: false, hasDirectReports: true })).toBe('manager');
  });

  it('neither admin, manager role, nor reports → employee', () => {
    expect(resolveDashboardRole({ admin: false, managerRole: false, hasDirectReports: false })).toBe('employee');
  });
});

describe('ROLE_CARDS', () => {
  it('has the exact card set + order per role (matches the reporter\'s three sets)', () => {
    expect(ROLE_CARDS.employee).toEqual(['leaveBalance', 'nextHoliday', 'pendingTasks']);
    expect(ROLE_CARDS.manager).toEqual(['teamAwayToday', 'onboardingWeek', 'approvalRequests', 'upcomingReminders']);
    expect(ROLE_CARDS.hr_admin).toEqual(['headcount', 'pendingLeave', 'companies', 'latestPayroll']);
  });

  it('every card in every role resolves to an href + label key (guards a card added to one map but not the other)', () => {
    for (const role of Object.keys(ROLE_CARDS) as DashboardRole[]) {
      for (const id of ROLE_CARDS[role]) {
        const meta = CARD_META[id];
        expect(meta, `missing CARD_META for ${id}`).toBeDefined();
        expect(meta.href.length).toBeGreaterThan(0);
        expect(meta.labelKey.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('teamAwayToday', () => {
  const today = '2026-07-08';
  const approved = (start: string, end: string) => ({ status: 'approved', startDate: start, endDate: end });

  it('counts a report with an approved leave covering today', () => {
    const rows = [{ id: 'p1', leaves: [approved('2026-07-06', '2026-07-10')] }];
    expect(teamAwayToday(rows, today, 'viewer')).toBe(1);
  });

  it('excludes pending leave', () => {
    const rows = [{ id: 'p1', leaves: [{ status: 'pending', startDate: '2026-07-06', endDate: '2026-07-10' }] }];
    expect(teamAwayToday(rows, today, 'viewer')).toBe(0);
  });

  it("excludes the viewer's own row", () => {
    const rows = [{ id: 'viewer', leaves: [approved('2026-07-06', '2026-07-10')] }];
    expect(teamAwayToday(rows, today, 'viewer')).toBe(0);
  });

  it('counts a person with two overlapping approved leaves only once', () => {
    const rows = [
      { id: 'p1', leaves: [approved('2026-07-06', '2026-07-08'), approved('2026-07-08', '2026-07-12')] },
    ];
    expect(teamAwayToday(rows, today, 'viewer')).toBe(1);
  });

  it('excludes an approved leave that does not cover today', () => {
    const rows = [{ id: 'p1', leaves: [approved('2026-07-01', '2026-07-05')] }];
    expect(teamAwayToday(rows, today, 'viewer')).toBe(0);
  });

  it('counts distinct reports across a mixed roster', () => {
    const rows = [
      { id: 'p1', leaves: [approved('2026-07-06', '2026-07-10')] },
      { id: 'p2', leaves: [{ status: 'pending', startDate: '2026-07-06', endDate: '2026-07-10' }] },
      { id: 'p3', leaves: [approved('2026-07-08', '2026-07-08')] },
      { id: 'viewer', leaves: [approved('2026-07-06', '2026-07-10')] },
    ];
    expect(teamAwayToday(rows, today, 'viewer')).toBe(2);
  });
});

describe('pendingTasksCount', () => {
  it('sums the employee action-item counts', () => {
    expect(pendingTasksCount([3])).toBe(3);
    expect(pendingTasksCount([2, 1, 4])).toBe(7);
  });

  it('is 0 for no task sources / an empty roster', () => {
    expect(pendingTasksCount([])).toBe(0);
    expect(pendingTasksCount([0])).toBe(0);
  });

  it('clamps negative inputs to 0 (defensive)', () => {
    expect(pendingTasksCount([-1, 2])).toBe(2);
  });
});

describe('upcomingRemindersCount', () => {
  const today = '2026-07-08';
  const cutoff = '2026-08-07'; // today + 30d

  it('counts review deadlines + holidays inside the window', () => {
    const holidays = [{ date: '2026-07-20' }, { date: '2026-08-31' }]; // one in-window, one past cutoff
    expect(upcomingRemindersCount(holidays, 2, today, cutoff)).toBe(3); // 1 holiday + 2 reviews
  });

  it('includes a holiday landing exactly on today and on the cutoff (inclusive bounds)', () => {
    const holidays = [{ date: today }, { date: cutoff }];
    expect(upcomingRemindersCount(holidays, 0, today, cutoff)).toBe(2);
  });

  it('excludes past holidays and holidays beyond the cutoff', () => {
    const holidays = [{ date: '2026-07-01' }, { date: '2026-09-01' }];
    expect(upcomingRemindersCount(holidays, 0, today, cutoff)).toBe(0);
  });

  it('counts review deadlines even with no upcoming holidays', () => {
    expect(upcomingRemindersCount([], 4, today, cutoff)).toBe(4);
  });

  it('clamps a negative review count to 0 (defensive)', () => {
    expect(upcomingRemindersCount([{ date: '2026-07-10' }], -3, today, cutoff)).toBe(1);
  });
});
