/**
 * r285 (feedback 7bfb629c) — the Explain panel must use the grid's words, and must agree with its own total.
 *
 * TWO CLAIMS, AND THE SECOND IS A REAL DEFECT THE REPORTER DID NOT REPORT.
 *
 * 1. WORDING, WHICH WE CAUSED. r279 renamed the Employee Balances GRID columns to "Full Entitlement" and
 *    "Earned to Date" and deliberately left the Explain panel reading "Eligible (full year entitlement)" and
 *    "YTD entitled". Both pairs are PICKs off ONE breakdown object (`eligibleDays` / `currentYearEntitlement`),
 *    so the result was the same two numbers under two names, one click apart. Only the LABELS move here: the
 *    field keys `eligible` / `ytdEntitled` are stored ESS component keys in `leave_type.ess_view_config`
 *    (core/ess-view.ts) that production leave types hold, exactly as r279 handled it. §1 and §2 below.
 *
 * 2. THE PANEL'S PENDING QUERY HAD NO DATE BOUND. `leaveBalances` counts a pending request only once its
 *    start date has arrived (`start_date <= asOf`, 3ddae357); `leaveEntitlementBreakdown` counted every
 *    pending request whatever its dates. The panel renders the BREAKDOWN's figure on its "Pending Approval"
 *    line and leaveBalances' figure on its "Available Balance" line, so the explanation column stopped
 *    reaching the total printed at the bottom of the same panel — by exactly the days of every pending
 *    request starting after the As-at date. §3 and §4 below.
 *
 * THE FIXTURE IS THE PRODUCTION SHAPE, seeded (production is never touched). Mei Ling EMP-0003 / Demo Sdn
 * Bhd / ANNUAL, as at 2026-08-04, three pending ANNUAL requests:
 *     2026-08-03   4.00   started  → counts at 2026-08-04
 *     2026-08-05   1.00   not yet  → must NOT count at 2026-08-04
 *     2026-09-04   1.00   not yet  → must NOT count at 2026-08-04
 * against an ANNUAL ledger standing at −6.50. What the two surfaces reported before this change:
 *     grid  pending 4.00   available −10.50
 *     panel pending 6.00   column implies −12.50
 * Those four figures are asserted literally rather than recomputed, because they ARE the item.
 *
 * NON-VACUITY. §3's `the panel's pending figure is bounded by the as-at date, exactly as the grid's is`
 * fails (6 received vs 4 expected) with the `lte(leaveRequest.startDate, asOf)` line reverted out of
 * core/read.ts, and so does §4's column-closes assertion (−12.5 vs −10.5). Verified by reverting it.
 *
 * Read-only feature: no schema, no migration, no DomainEvent.
 * // substrate: read-only, no event
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { leaveBalances, leaveEntitlementBreakdown } from '../core/read';
import { employeeBalanceRows } from '../app/leave/employee-balances/rows';
import { ESS_VIEW_COMPONENT_KEYS } from '../core/ess-view';
import {
  ENTITLEMENT_PANEL_SECTIONS,
  type PanelData,
  type PanelField,
} from '../components/leave/entitlement-panel-config';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const catalogue = (loc: string) => JSON.parse(read(`/messages/${loc}.json`));
const panelField = (loc: string) => catalogue(loc).leave.breakdown.field as Record<string, string>;
const gridCol = (loc: string) => catalogue(loc).me.leaveBalanceTable as Record<string, unknown>;

const r2 = (n: number) => Math.round(n * 100) / 100;

const summary = () => ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === 'summary')!;
const field = (key: string): PanelField => summary().fields!.find((f) => f.key === key)!;
/** A summary row's figure. Every row in this section declares a `select`; §1 pins that it still does. */
const pick = (key: string, d: PanelData) => field(key).select!(d);

// ── 1. The two labels the reporter read twice ───────────────────────────────────────────────────────

describe('r285 §1: the panel says what the grid says — the same words for the same figure', () => {
  for (const loc of LOCALES) {
    it(`${loc}: the panel's two labels are now the grid's two labels, verbatim`, () => {
      const f = panelField(loc);
      const g = gridCol(loc);
      expect(f.eligible, `[${loc}] field.eligible`).toBe(g.colFullEntitlement);
      expect(f.ytdEntitled, `[${loc}] field.ytdEntitled`).toBe(g.colYtdEntitled);
      // …and the two are still distinct from each other, in every locale. Two rows that print the same
      // string is the defect this item is about, in a new place.
      expect(f.eligible, `[${loc}] the two rows must not collapse`).not.toBe(f.ytdEntitled);
    });
  }

  it('English reads exactly what the reporter will see', () => {
    const f = panelField('en');
    expect(f.eligible).toBe('Full Entitlement');
    expect(f.ytdEntitled).toBe('Earned to Date');
    // The words that caused the report are gone from these two rows.
    expect(f.eligible).not.toContain('Eligible');
    expect(f.ytdEntitled).not.toContain('YTD');
  });

  it('the two rows still read those keys — a label move, not a descriptor rewrite', () => {
    expect(field('eligible').labelKey).toBe('field.eligible');
    expect(field('ytdEntitled').labelKey).toBe('field.ytdEntitled');
    // And still the SAME two picks off the one breakdown object that made them duplicates of the grid.
    const b = { eligibleDays: 18, currentYearEntitlement: 12.5 } as PanelData['breakdown'];
    const d = { breakdown: b, summary: { available: 0 } } as PanelData;
    expect(field('eligible').select).toBeTypeOf('function');
    expect(field('ytdEntitled').select).toBeTypeOf('function');
    expect(pick('eligible', d)).toBe(18);
    expect(pick('ytdEntitled', d)).toBe(12.5);
  });
});

// ── 2. What must NOT have moved ─────────────────────────────────────────────────────────────────────

describe('r285 §2: the blast radius — stored keys and the shared popup strings are untouched', () => {
  it('`ytdEntitled` and `eligible` are still ESS component keys: stored config keeps resolving', () => {
    // 12 production leave types hold `ytdEntitled` in leave_type.ess_view_config. Renaming the FIELD would
    // silently un-hide a row HR had hidden, on a screen nobody would think to re-check.
    expect(ESS_VIEW_COMPONENT_KEYS).toContain('ytdEntitled');
    expect(ESS_VIEW_COMPONENT_KEYS).toContain('eligible');
    expect(field('ytdEntitled').essKey).toBe('ytdEntitled');
    expect(field('eligible').essKey).toBe('eligible');
  });

  it('the leave-apply popup’s SHARED keys still hold their own strings, in all six locales', () => {
    // components/leave-duration-fields.tsx renders breakdown.field.pendingApproval and .available. They are
    // NOT this panel's alone, and `field.available` (popup) is a different key from `field.availableBalance`
    // (panel) with a near-identical string — easy to "tidy" into one and break the popup.
    const body = read('/components/leave-duration-fields.tsx');
    expect(body).toContain("t('breakdown.field.pendingApproval')");
    expect(body).toContain("t('breakdown.field.available')");
    for (const loc of LOCALES) {
      const f = panelField(loc);
      for (const k of ['pendingApproval', 'available', 'availableBalance', 'broughtForward', 'adjustments', 'total', 'taken', 'broughtForwardForfeited']) {
        expect(f[k], `[${loc}] field.${k} must still resolve`).toBeTruthy();
      }
    }
  });

  it('the grid keeps ITS names — r279 is not undone', () => {
    expect(gridCol('en').colFullEntitlement).toBe('Full Entitlement');
    expect(gridCol('en').colYtdEntitled).toBe('Earned to Date');
  });

  it('the tooltips are unchanged and still describe the figure, not the old label', () => {
    for (const loc of LOCALES) {
      const tip = catalogue(loc).leave.breakdown.summaryTip as Record<string, string>;
      expect(tip.eligible, `[${loc}] summaryTip.eligible`).toBeTruthy();
      expect(tip.ytdEntitled, `[${loc}] summaryTip.ytdEntitled`).toBeTruthy();
    }
    expect(catalogue('en').leave.breakdown.summaryTip.eligible).toContain('whole leave year');
  });
});

// ── The production shape, seeded ────────────────────────────────────────────────────────────────────

let b: Base;
let emp: string;
let annualId: string;

const AS_OF = '2026-08-04';

/** Mei Ling's ANNUAL ledger, reduced to the two rows that put the balance at −6.50 as at 2026-08-04. */
const LEDGER = [
  { effectiveOn: '2026-01-01', entryType: 'accrual' as const, days: '5.50', reason: null },
  { effectiveOn: '2026-03-01', entryType: 'debit' as const, days: '-12.00', reason: null },
];

/** Her three pending ANNUAL requests, verbatim: one started by the as-at date, two not. */
const PENDING = [
  { startDate: '2026-08-03', endDate: '2026-08-06', days: '4.00' },
  { startDate: '2026-08-05', endDate: '2026-08-05', days: '1.00' },
  { startDate: '2026-09-04', endDate: '2026-09-04', days: '1.00' },
];

const gridRow = async (asOf: string) => {
  const rows = await leaveBalances(adminCtx(b), emp, undefined, { includeHidden: true, asOf });
  const row = rows.find((r) => r.leaveTypeId === annualId);
  expect(row, `ANNUAL row missing at ${asOf}`).toBeTruthy();
  return row!;
};

const panelBreakdown = async (asOf: string) => {
  const bd = await leaveEntitlementBreakdown(adminCtx(b), emp, annualId, asOf);
  expect(bd, `breakdown missing at ${asOf}`).not.toBeNull();
  return bd!;
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  annualId = b.annualLeaveTypeId;
  const hired = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Mei Ling', primaryEmail: `meiling_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  emp = hired.employmentId;
  await owner.db.insert(schema.leaveLedger).values(
    LEDGER.map((r) => ({ tenantId: b.tenantId, employmentId: emp, leaveTypeId: annualId, ...r })),
  );
  await owner.db.insert(schema.leaveRequest).values(
    PENDING.map((r) => ({
      tenantId: b.tenantId,
      employmentId: emp,
      leaveTypeId: annualId,
      status: 'pending' as const,
      ...r,
    })),
  );
});
afterAll(async () => {
  await closeAll();
});

// ── 3. The bug, on the reporter's own numbers ───────────────────────────────────────────────────────

describe('r285 §3: the Explain panel counts the same pending requests the grid counts', () => {
  it('the fixture really is the production shape (guard the guard)', async () => {
    const grid = await gridRow(AS_OF);
    expect(grid.balance).toBe(-6.5);
    // 4.00 has started by 2026-08-04; 1.00 + 1.00 have not. The grid was always right about this.
    expect(grid.pending).toBe(4);
    expect(grid.available).toBe(-10.5);
  });

  it('the panel’s pending figure is bounded by the as-at date, exactly as the grid’s is', async () => {
    const bd = await panelBreakdown(AS_OF);
    // WAS 6.00 — the 2026-08-05 and 2026-09-04 requests were counted against a 2026-08-04 question.
    expect(bd.pendingApproval).toBe(4);
    expect(bd.pendingApproval).toBe((await gridRow(AS_OF)).pending);
  });

  it('…and therefore the panel’s own Available figure matches the grid’s, rather than trailing it by 2.00', async () => {
    const bd = await panelBreakdown(AS_OF);
    // WAS −12.50 against the grid's −10.50.
    expect(bd.totalAvailable).toBe(-10.5);
    expect(bd.totalAvailable).toBe((await gridRow(AS_OF)).available);
  });

  it('a request starting exactly ON the as-at date counts — the boundary is inclusive on both surfaces', async () => {
    for (const [asOf, expected] of [
      ['2026-08-02', 0],
      ['2026-08-03', 4],
      ['2026-08-04', 4],
      ['2026-08-05', 5],
      ['2026-09-04', 6],
      ['2026-12-31', 6],
    ] as const) {
      const bd = await panelBreakdown(asOf);
      expect(bd.pendingApproval, `panel pending at ${asOf}`).toBe(expected);
      expect((await gridRow(asOf)).pending, `grid pending at ${asOf}`).toBe(expected);
    }
  });

  it('once every request has begun the figure is the whole 6.00 — the bound subtracts nothing permanently', async () => {
    const bd = await panelBreakdown('2026-12-31');
    expect(bd.pendingApproval).toBe(6);
    expect(bd.totalAvailable).toBe(r2(bd.balance - 6));
  });
});

// ── 4. The claim the panel config makes about itself ────────────────────────────────────────────────

describe('r285 §4: the Explain column closes onto the Available Balance printed under it', () => {
  /** The panel's own column, built the way the screen builds it: one `bd`, one `available`, from rows.ts. */
  const column = async (asOf: string) => {
    const rows = await employeeBalanceRows(adminCtx(b), emp, asOf, 'en');
    const row = rows.find((r) => r.leaveTypeId === annualId);
    expect(row?.breakdown, `Explain data missing at ${asOf}`).toBeTruthy();
    const data: PanelData = { breakdown: row!.breakdown!, summary: { available: row!.available } };
    const value = (key: string) => pick(key, data) as number;
    return { value, row: row! };
  };

  it('Total − Taken − Pending Approval − Brought Forward Forfeited = Available Balance, on the reporter’s date', async () => {
    const { value } = await column(AS_OF);
    // The line the reporter would read: 4.00, not 6.00.
    expect(value('pendingApproval')).toBe(4);
    // The bottom line: leaveBalances' own figure, which this column must reach.
    expect(value('available')).toBe(-10.5);
    // WAS −12.50 here against a printed −10.50. This is the assertion that fails with the date bound
    // reverted out of core/read.ts.
    expect(r2(value('total') - value('taken') - value('pendingApproval') - value('forfeited'))).toBe(
      value('available'),
    );
  });

  it('the column closes on EVERY date across the fixture, not only the reported one', async () => {
    for (const asOf of ['2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-09-04', '2026-12-31']) {
      const { value } = await column(asOf);
      expect(
        r2(value('total') - value('taken') - value('pendingApproval') - value('forfeited')),
        `column must close at ${asOf}`,
      ).toBe(value('available'));
    }
  });

  it('the two surfaces are driven by ONE breakdown object, so the grid row and the panel cannot disagree', async () => {
    const { value, row } = await column(AS_OF);
    // rows.ts hands the panel the very `bd` the grid row was derived from (r242). Pin both halves.
    expect(row.pending).toBe(value('pendingApproval'));
    expect(row.balance).toBe(-6.5);
    expect(value('eligible')).toBe(row.breakdown!.eligibleDays);
    expect(value('ytdEntitled')).toBe(row.breakdown!.currentYearEntitlement);
  });

  it('the panel config’s comment no longer claims an unqualified identity through the last two lines', () => {
    const body = read('/components/leave/entitlement-panel-config.ts');
    // The claim is kept (it is true down to `balance`) and qualified where it was false.
    expect(body).toContain('is an identity, not an agreement');
    expect(body).toContain('THE IDENTITY STOPS AT `balance`');
    expect(body).toContain('start_date <= asOf');
  });
});
