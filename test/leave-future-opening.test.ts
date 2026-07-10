// Future Leave Year Opening Rule (d9e41725). Covers the reporter's four fields end-to-end:
//   - the pure date-computation helper (each unit, month-length / leap-year edges, week math)
//   - persisting the rule (enable + amount + unit + effective year) → open_leave_year_date computed + stamped
//   - validation (reject 0/negative amount, bad unit, out-of-range year)
//   - the tri-state disable path (clears the rule columns, keeps the previously computed date)
//   - substrate: a leave-year.opening-rule.configured event is appended on save
//   - backward-compat: a leave_year_config row with NO rule (0190 shape) is unchanged
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  adminCtx,
  closeAll,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import {
  computeOpenLeaveYearDate,
  saveFutureOpeningRule,
  listLeaveYearConfigs,
} from '@/core/leave';
import { leaveYearConfig, domainEvent } from '@/db/schema';

let base: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});

describe('computeOpenLeaveYearDate (pure UTC calendar math)', () => {
  it('subtracts calendar days', () => {
    // LY2027 starts 2027-01-01; 14 days before = 2026-12-18.
    expect(computeOpenLeaveYearDate(2027, 14, 'days')).toBe('2026-12-18');
    expect(computeOpenLeaveYearDate(2027, 1, 'days')).toBe('2026-12-31');
  });
  it('subtracts weeks as 7-day multiples', () => {
    expect(computeOpenLeaveYearDate(2027, 2, 'weeks')).toBe('2026-12-18'); // 14 days
    expect(computeOpenLeaveYearDate(2027, 4, 'weeks')).toBe('2026-12-04'); // 28 days
  });
  it('subtracts whole calendar months (anchored to Jan 1)', () => {
    expect(computeOpenLeaveYearDate(2027, 1, 'months')).toBe('2026-12-01');
    expect(computeOpenLeaveYearDate(2027, 2, 'months')).toBe('2026-11-01');
    expect(computeOpenLeaveYearDate(2027, 12, 'months')).toBe('2026-01-01');
  });
  it('crosses a leap-year boundary correctly (NOT /365.25)', () => {
    // 2024 is a leap year: Jan-1-2025 minus 60 days lands in early Nov 2024.
    expect(computeOpenLeaveYearDate(2025, 60, 'days')).toBe('2024-11-02');
    // Month subtraction ignores day-length: Jan 1 minus 1 month is always the 1st.
    expect(computeOpenLeaveYearDate(2025, 1, 'months')).toBe('2024-12-01');
  });
  it('rejects a non-positive amount', () => {
    expect(() => computeOpenLeaveYearDate(2027, 0, 'days')).toThrow();
    expect(() => computeOpenLeaveYearDate(2027, -3, 'weeks')).toThrow();
  });
});

describe('saveFutureOpeningRule (persist + compute + substrate)', () => {
  it('enabling computes + stamps open_leave_year_date and persists the rule', async () => {
    const ctx = adminCtx(base);
    const res = await saveFutureOpeningRule(ctx, {
      year: 2027,
      enabled: true,
      amount: 14,
      unit: 'days',
    });
    expect(res.enabled).toBe(true);
    expect(res.openLeaveYearDate).toBe('2026-12-18');

    const [row] = await owner.db
      .select()
      .from(leaveYearConfig)
      .where(and(eq(leaveYearConfig.tenantId, base.tenantId), eq(leaveYearConfig.year, 2027)));
    expect(row.openingRuleEnabled).toBe(true);
    expect(row.openBeforeAmount).toBe(14);
    expect(row.openBeforeUnit).toBe('days');
    expect(row.openLeaveYearDate).toBe('2026-12-18');
    // Status must NOT be moved by the rule (v1 is compute-only, not auto-open).
    expect(row.status).toBe('draft');

    const view = await listLeaveYearConfigs(ctx);
    const y = view.find((v) => v.year === 2027)!;
    expect(y.openingRuleEnabled).toBe(true);
    expect(y.openBeforeAmount).toBe(14);
    expect(y.openBeforeUnit).toBe('days');
  });

  it('appends a leave-year.opening-rule.configured domain event', async () => {
    const ctx = adminCtx(base);
    await saveFutureOpeningRule(ctx, { year: 2028, enabled: true, amount: 1, unit: 'months' });
    const events = await owner.db
      .select()
      .from(domainEvent)
      .where(and(eq(domainEvent.tenantId, base.tenantId), eq(domainEvent.eventType, 'leave-year.opening-rule.configured')));
    expect(events.length).toBe(1);
    const payload = events[0].payload as { after?: { openLeaveYearDate?: string; openBeforeUnit?: string } };
    expect(payload.after?.openLeaveYearDate).toBe('2027-12-01');
    expect(payload.after?.openBeforeUnit).toBe('months');
  });

  it('disabling clears the rule columns but keeps the last computed date', async () => {
    const ctx = adminCtx(base);
    await saveFutureOpeningRule(ctx, { year: 2027, enabled: true, amount: 2, unit: 'weeks' });
    const disabled = await saveFutureOpeningRule(ctx, { year: 2027, enabled: false });
    expect(disabled.enabled).toBe(false);
    // The previously-computed date is preserved (2026-12-18), not wiped.
    expect(disabled.openLeaveYearDate).toBe('2026-12-18');

    const [row] = await owner.db
      .select()
      .from(leaveYearConfig)
      .where(and(eq(leaveYearConfig.tenantId, base.tenantId), eq(leaveYearConfig.year, 2027)));
    expect(row.openingRuleEnabled).toBe(false);
    expect(row.openBeforeAmount).toBeNull();
    expect(row.openBeforeUnit).toBeNull();
    expect(row.openLeaveYearDate).toBe('2026-12-18');
  });

  it('rejects an invalid amount, unit, or year when enabled', async () => {
    const ctx = adminCtx(base);
    await expect(
      saveFutureOpeningRule(ctx, { year: 2027, enabled: true, amount: 0, unit: 'days' }),
    ).rejects.toThrow();
    await expect(
      saveFutureOpeningRule(ctx, { year: 2027, enabled: true, amount: 5, unit: 'fortnights' }),
    ).rejects.toThrow();
    await expect(
      saveFutureOpeningRule(ctx, { year: 1999, enabled: true, amount: 5, unit: 'days' }),
    ).rejects.toThrow();
  });

  it('backward-compat: a row created without the rule reads false/null defaults', async () => {
    // Insert a bare 0190-shape row (no rule columns supplied).
    await owner.db.insert(leaveYearConfig).values({ tenantId: base.tenantId, year: 2030, status: 'draft' });
    const view = await listLeaveYearConfigs(adminCtx(base));
    const y = view.find((v) => v.year === 2030)!;
    expect(y.openingRuleEnabled).toBe(false);
    expect(y.openBeforeAmount).toBeNull();
    expect(y.openBeforeUnit).toBeNull();
  });
});
