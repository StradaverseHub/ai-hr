/**
 * r389 (board 62a1bec1) — AN AUTOMATIC ENTITLEMENT RECALCULATION IS EARNED TO DATE, ON EVERY SCREEN.
 *
 * THE REPORT. EMP-0004 / Annual Leave (earned daily, the tenant's custom rounding table). The Employee
 * Balances grid printed Earned to Date 11.50 and Adjustment 0.00; the Explain panel beside it printed Earned
 * to Date 11.68 and Adjustments 0.32. The ledger (production, read-only) holds three earning rows: 11.18
 * accrual, +0.32 `sys:profile_recalc` posted when an entitlement table was created, 0.50 accrual.
 *
 * THE FAULT. The engines count a recalculation as entitlement GRANTED — the accrual run's `already` sum
 * includes it, so the 1 October run topped up AROUND it to 12.00 — while the read model counted only
 * accrual rows as earned and filed the recalculation under the panel's "system corrections". The grid's
 * Adjustment read a third bucket (config only) and so showed the 0.32 nowhere. One ledger, three readings.
 *
 * THE FIX, read-model only (no ledger row is written or rewritten, no migration): one kernel predicate,
 * `isEarnedToDateRow` (core/leave.ts), decides Earned to Date for the breakdown walk AND `leaveBalances`'
 * `accrued`; the grid's Adjustment and the panel's Adjustments read one field (`adjustments`).
 *
 * §1 the reporter's ledger, built by the REAL engines (accrual run → cohort recalc → accrual run) with
 *    production's own rounding table, read on every surface: 12.00 / 0.00, balance unchanged;
 * §2 a genuine HR adjustment still shows as an Adjustment, on both screens, and Earned does not absorb it;
 * §3 a NEGATIVE recalculation lowers Earned, with Adjustment 0.00;
 * §4 what must NOT move: up-front grant, forfeit, pool borrower, and the Anniversary-to-Calendar reversal
 *    (whose superseded recalculations stay beside it — `a2cSupersessionOf`);
 * §5 the automatic reversal of an ineligible grant reads as an automatic correction, not an HR adjustment;
 * §6 the engine predicate (SQL) and the read predicate (JS) select the same rows off a real ledger.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { createTranslator } from 'next-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setLeaveTypeRules, updateLeaveType } from '../core/admin';
import {
  CARRY_FORFEIT_REASON_CAP,
  INELIGIBLE_GRANT_REVERSAL_REASON,
  PROFILE_RECALC_REASON_PREFIX,
  POLICY_RECALC_REASON_PREFIX,
  accrueEarnedLeave,
  entitlementGrantedRowCond,
  isEntitlementGrantedRow,
  isEarnedToDateRow,
  openLeaveYear,
  reprojectEntitlementForLeaveTypeCohort,
} from '../core/leave';
import { updateEntitlementTemplate } from '../core/entitlement-template';
import type { RoundingBand } from '../core/leave-compute';
import { leaveBalances, leaveBalancesAll, leaveEntitlementBreakdown, type LeaveEntitlementBreakdown } from '../core/read';
import { myLeaveDashboard } from '../core/my-leave';
import { applyLeaveAdjustmentBatch } from '../core/leave-adjustment';
import { employeeBalanceRows, type EmployeeBalanceRow } from '../app/leave/employee-balances/rows';
import { ENTITLEMENT_PANEL_SECTIONS, reconciledBalance, type PanelData } from '../components/leave/entitlement-panel-config';
import type { EntitlementBreakdownData } from '../components/leave/EntitlementBreakdown';
import { explainLeaveSummary } from '../lib/leave-summary-explain';
import {
  adminCtx,
  closeAll,
  createAppUser,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;

/** Production's own rounding table (measured 2026-09-24, test/r335-earned-to-date-rounding.test.ts). */
const PRODUCTION_BANDS: RoundingBand[] = [
  { from: 0, to: 0.38, result: 0 },
  { from: 0.39, to: 0.68, result: 0.5 },
  { from: 0.69, to: 0.99, result: 1 },
];

/**
 * THE REPORTER'S DATES. All are in 2026 and in the past, and every engine below is handed its date
 * explicitly, so nothing here reads the clock. 16 days a year, earned daily over a 365-day calendar year:
 *   12 Sep — 255 days ⇒ 11.18 (no rounding table yet, so posted raw: r335's shape);
 *   20 Sep — 263 days ⇒ 11.53 ⇒ table ⇒ 11.50, so the recalculation posts 11.50 − 11.18 = +0.32;
 *    1 Oct — 274 days ⇒ 12.01 ⇒ table ⇒ 12.00, so the accrual run tops up 12.00 − (11.18 + 0.32) = 0.50.
 * Production's first accrual is dated 17 Sep; the engine dates its row on its own `asOf`, so here it is 12
 * Sep. The figures — the only thing the report is about — are the reporter's to the hundredth.
 */
const ANNUAL_DAYS = 16;
const FIRST_RUN = '2026-09-12';
const DEBIT_ON = '2026-09-18';
const RECALC_ON = '2026-09-20';
const SECOND_RUN = '2026-10-01';
const AS_OF = '2026-10-05';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

const r2 = (n: number) => Math.round(n * 100) / 100;

const setTypeRules = (leaveTypeId: string, rules: Partial<typeof schema.leaveType.$inferInsert>) =>
  owner.db.update(schema.leaveType).set(rules).where(eq(schema.leaveType.id, leaveTypeId));

const post = (
  employmentId: string,
  leaveTypeId: string,
  entryType: 'accrual' | 'debit' | 'adjustment' | 'in_lieu_accrual',
  days: number,
  effectiveOn: string,
  reason: string | null = null,
) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType,
    days: days.toFixed(2),
    effectiveOn,
    reason,
  });

const hire = (hiredOn: string, grants = true) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'EMP-0004', primaryEmail: `r389_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    gradeId: null,
    ...(grants ? { grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }] } : {}),
  });

const ledgerOf = (employmentId: string, leaveTypeId: string) =>
  owner.db
    .select({
      entryType: schema.leaveLedger.entryType,
      days: schema.leaveLedger.days,
      effectiveOn: schema.leaveLedger.effectiveOn,
      reason: schema.leaveLedger.reason,
    })
    .from(schema.leaveLedger)
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, leaveTypeId)))
    .orderBy(asc(schema.leaveLedger.effectiveOn), asc(schema.leaveLedger.entryType), asc(schema.leaveLedger.days));

const hrBreakdown = async (employmentId: string, leaveTypeId: string, asOf = AS_OF) => {
  const bd = await leaveEntitlementBreakdown(adminCtx(b), employmentId, leaveTypeId, asOf, 'en', { derivation: true });
  expect(bd).not.toBeNull();
  return bd!;
};

/** The six-bucket identity and the two roll-ups — the property every regrouping here must leave intact. */
const expectReconciles = (bd: LeaveEntitlementBreakdown) => {
  expect(reconciledBalance(bd as unknown as EntitlementBreakdownData)).toBe(r2(bd.balance));
  expect(bd.adjustments).toBe(r2(bd.configAdjustments + bd.systemAdjustments));
  expect(bd.totalEntitlement).toBe(r2(bd.broughtForward + bd.currentYearEntitlement + bd.adjustments));
  expect(r2(bd.balance - bd.pendingApproval)).toBe(bd.totalAvailable);
  // The explanation's lists add up to the figures they sit under (r303's sum-guard).
  const d = bd.derivation!;
  expect(r2(d.earned.credits.reduce((s, c) => s + c.days, 0))).toBe(bd.currentYearEntitlement);
  expect(r2(d.adjustments.manual.reduce((s, c) => s + c.days, 0))).toBe(bd.configAdjustments);
  expect(r2(d.adjustments.system.reduce((s, c) => s + c.days, 0))).toBe(bd.systemAdjustments);
};

/**
 * THE GRID ROW AND THE PANEL READ ONE ADJUSTMENT. For EVERY row Employee Balances builds, the Adjustment
 * column must equal the figure the Explain panel's Adjustments line selects off the very breakdown the row
 * carries — the descriptor's own `select`, not a re-statement of it.
 */
const adjustmentsLine = ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === 'summary')!.fields!.find((f) => f.key === 'adjustment')!;
const expectGridMatchesPanel = (rows: EmployeeBalanceRow[]) => {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    if (!row.breakdown) {
      expect(row.adjustment, `${row.code} has no breakdown`).toBeNull();
      continue;
    }
    const data: PanelData = { breakdown: row.breakdown, summary: { available: row.available } };
    expect(row.adjustment, `${row.code}: grid Adjustment = panel Adjustments`).toBe(adjustmentsLine.select!(data));
  }
};

/** The reporter's ledger, built by the engines in the order production ran them. */
async function reporterLedger() {
  await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: ANNUAL_DAYS, validFrom: '2025-01-01' });
  await setTypeRules(b.annualLeaveTypeId, { accrualMethod: 'earned_daily' });
  const e = await hire('2025-01-01');
  // An earned type gets nothing from the hire grant, so the ledger below is provably only the engines' work.
  expect(await ledgerOf(e.employmentId, b.annualLeaveTypeId)).toEqual([]);

  // 1. The accrual run, before any rounding table existed: 11.18 raw.
  await accrueEarnedLeave(adminCtx(b), { asOf: FIRST_RUN, leaveTypeIds: [b.annualLeaveTypeId] });
  // 2. One day of leave taken (the debit is not what this item is about; it is what makes Balance 11.00).
  await post(e.employmentId, b.annualLeaveTypeId, 'debit', -1, DEBIT_ON);
  // 3. The tenant's rounding table goes on, then the entitlement-table save triggers the cohort recalc —
  //    the path that stamped `sys:profile_recalc` on production with the trigger `entitlement_template_created`.
  await setTypeRules(b.annualLeaveTypeId, { roundingMethod: 'custom', roundingBands: PRODUCTION_BANDS });
  await reprojectEntitlementForLeaveTypeCohort(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    trigger: 'entitlement_template_created',
    asOf: RECALC_ON,
  });
  // 4. The next accrual run, which counts the recalculation as already granted and tops up around it.
  await accrueEarnedLeave(adminCtx(b), { asOf: SECOND_RUN, leaveTypeIds: [b.annualLeaveTypeId] });

  const userId = await createAppUser(b.tenantId, e.personId, 'employee');
  const ctx: SessionContext = { tenantId: b.tenantId, userId, personId: e.personId, roles: ['employee'] };
  return { ...e, ctx };
}

// ── §1 the reporter's case ─────────────────────────────────────────────────────────────────────────────
describe("r389 §1 · the reporter's ledger reads Earned to Date 12.00 and Adjustment 0.00 everywhere", () => {
  it('the engines wrote exactly the production ledger: 11.18 accrual, +0.32 profile recalc, 0.50 accrual', async () => {
    const e = await reporterLedger();
    const rows = (await ledgerOf(e.employmentId, b.annualLeaveTypeId)).map((r) => ({ ...r, days: Number(r.days) }));
    expect(rows).toEqual([
      { entryType: 'accrual', days: 11.18, effectiveOn: FIRST_RUN, reason: null },
      { entryType: 'debit', days: -1, effectiveOn: DEBIT_ON, reason: null },
      { entryType: 'adjustment', days: 0.32, effectiveOn: RECALC_ON, reason: `${PROFILE_RECALC_REASON_PREFIX}:${e.employmentId}` },
      { entryType: 'accrual', days: 0.5, effectiveOn: SECOND_RUN, reason: null },
    ]);
    // The audit row says what production's says: previous 11.18, new 11.50, after a table was created.
    const audit = await owner.db
      .select({
        previous: schema.leaveEntitlementRecalcAudit.previousEntitlement,
        next: schema.leaveEntitlementRecalcAudit.newEntitlement,
        reason: schema.leaveEntitlementRecalcAudit.reason,
      })
      .from(schema.leaveEntitlementRecalcAudit)
      .where(eq(schema.leaveEntitlementRecalcAudit.employmentId, e.employmentId));
    expect(audit.map((a) => ({ previous: Number(a.previous), next: Number(a.next), reason: a.reason }))).toEqual([
      { previous: 11.18, next: 11.5, reason: 'entitlement_template_created' },
    ]);
  });

  it('THE REPORTED FAULT: the Explain panel reads Earned 12.00 and Adjustments 0.00, exact and rounded', async () => {
    const e = await reporterLedger();
    const bd = await hrBreakdown(e.employmentId, b.annualLeaveTypeId);
    // Before r389: 11.68 exact (11.50 rounded) with 0.32 under Adjustments as a "system correction".
    expect(bd.currentYearEntitlement, 'Earned to Date (exact)').toBe(12);
    expect(bd.currentYearEntitlementRounded, 'Earned to Date (shown)').toBe(12);
    expect(bd.adjustments, 'Adjustments').toBe(0);
    expect(bd.configAdjustments).toBe(0);
    expect(bd.systemAdjustments).toBe(0);
    // NOTHING ABOUT THE MONEY MOVED: the balance is the ledger's own sum, as the reporter's screens showed it.
    expect(bd.balance).toBe(11);
    expect(bd.balance).toBe(await ledgerBalance(e.employmentId, b.annualLeaveTypeId));
    expect(bd.totalEntitlement).toBe(12);
    expect(bd.totalAvailable).toBe(11);
    expectReconciles(bd);

    // The recalculation is LISTED under Earned to Date, with its date, as an automatic recalculation.
    expect(bd.derivation!.earned.credits).toEqual([
      { effectiveOn: FIRST_RUN, days: 11.18, kind: 'grant' },
      { effectiveOn: RECALC_ON, days: 0.32, kind: 'profile_recalc' },
      { effectiveOn: SECOND_RUN, days: 0.5, kind: 'grant' },
    ]);
    expect(bd.derivation!.adjustments).toEqual({ manual: [], system: [] });
  });

  it('the Explain panel prints the credit as an automatic recalculation — never "the employee\'s record changed"', async () => {
    const e = await reporterLedger();
    const bd = await hrBreakdown(e.employmentId, b.annualLeaveTypeId);
    const lines = explainLeaveSummary(bd, { available: bd.totalAvailable });
    const credit = lines.ytdEntitled.find((s) => s.key === 'creditItem' && JSON.stringify(s.args?.kind) === JSON.stringify({ choice: 'profile_recalc' }));
    expect(credit, 'the 0.32 is an Earned to Date credit line').toBeDefined();
    expect(lines.adjustment.map((s) => s.key)).toEqual(['adjNone']);
    const t = createTranslator({ locale: 'en', messages: en as never, namespace: 'leave.breakdown.explain' as never }) as unknown as (
      k: string,
      v: Record<string, string>,
    ) => string;
    const sentence = t('creditItem', { date: '20/09/2026', days: '+0.32', kind: 'profile_recalc' });
    expect(sentence).toBe('20/09/2026: +0.32 — entitlement recalculated automatically');
    // A profile_recalc row is also stamped by template, eligibility-rule and earning-method saves, so a
    // caption about the employee's record would be false for this very row.
    for (const [loc, cat] of Object.entries(CATALOGUES)) {
      const msg = (cat as typeof en).leave.breakdown.explain.creditItem;
      expect(msg, `[${loc}] creditItem has a profile_recalc branch`).toMatch(/profile_recalc \{/);
      expect(msg, `[${loc}] creditItem has a policy_recalc branch`).toMatch(/policy_recalc \{/);
    }
    expect(en.leave.breakdown.explain.adjSystemItem).not.toContain("employee's record");
  });

  it('Employee Balances: Earned to Date 12.00, Adjustment 0.00, Balance 11.00 — and every row matches its panel', async () => {
    const e = await reporterLedger();
    const rows = await employeeBalanceRows(adminCtx(b), e.employmentId, AS_OF, 'en');
    const al = rows.find((r) => r.leaveTypeId === b.annualLeaveTypeId)!;
    // Before r389: Earned to Date 11.50 and Adjustment 0.00 here, beside 11.68 + 0.32 in the panel.
    expect(al.ytdEntitled, 'grid Earned to Date').toBe(12);
    expect(al.adjustment, 'grid Adjustment').toBe(0);
    expect(al.balance).toBe(11);
    expect(al.ytdEntitled).toBe(al.breakdown!.currentYearEntitlementRounded);
    expectGridMatchesPanel(rows);
  });

  it('the same 12.00 on My Leave, the Personnel record / My Team / assistant read, and the bulk pivot', async () => {
    const e = await reporterLedger();
    // My Leave's "Earned so far" card.
    const dash = await myLeaveDashboard(e.ctx, e.employmentId, { today: AS_OF });
    const card = dash.cards.find((c) => c.leaveTypeId === b.annualLeaveTypeId)!;
    expect(card.earnedSoFar).toBe(12);
    expect(card.balance).toBe(11);
    // `leaveBalances().accrued` — what the Personnel record's "of N", My Team's Entitled column and the
    // assistant's balance tool print. Undated (the running total) and dated, both 12.00.
    const live = (await leaveBalances(adminCtx(b), e.employmentId)).find((r) => r.leaveTypeId === b.annualLeaveTypeId)!;
    expect(live.accrued).toBe(12);
    expect(live.balance).toBe(11);
    const dated = (await leaveBalances(adminCtx(b), e.employmentId, 'en', { asOf: AS_OF })).find((r) => r.leaveTypeId === b.annualLeaveTypeId)!;
    expect(dated.accrued).toBe(12);
    // An as-at date BEFORE the recalculation counts only what had happened by then.
    const before = (await leaveBalances(adminCtx(b), e.employmentId, 'en', { asOf: '2026-09-19' })).find((r) => r.leaveTypeId === b.annualLeaveTypeId)!;
    expect(before.accrued).toBe(11.18);
    // The bulk pivot agrees (no screen reads it, but two `accrued` for one pair would be this defect again).
    const all = (await leaveBalancesAll(adminCtx(b))).find((r) => r.employmentId === e.employmentId && r.leaveTypeId === b.annualLeaveTypeId)!;
    expect(all.accrued).toBe(12);
    expect(all.balance).toBe(11);
  });
});

// ── §2 a genuine adjustment ────────────────────────────────────────────────────────────────────────────
describe('r389 §2 · an adjustment HR entered is still an Adjustment, on both screens', () => {
  it('+2.00 entered by HR shows as Adjustment 2.00 in the grid and the panel; Earned stays 12.00', async () => {
    const e = await reporterLedger();
    await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [b.annualLeaveTypeId],
      days: 2,
      effectiveOn: '2026-10-02',
      reason: 'Festive grant',
      targetMode: 'criteria',
      criteria: { companyIds: [b.companyId] },
    });
    const bd = await hrBreakdown(e.employmentId, b.annualLeaveTypeId);
    expect(bd.currentYearEntitlement).toBe(12);
    expect(bd.configAdjustments).toBe(2);
    expect(bd.adjustments).toBe(2);
    expect(bd.balance).toBe(13);
    expect(bd.derivation!.adjustments.manual).toEqual([{ effectiveOn: '2026-10-02', days: 2, reason: 'Festive grant' }]);
    expectReconciles(bd);
    const rows = await employeeBalanceRows(adminCtx(b), e.employmentId, AS_OF, 'en');
    const al = rows.find((r) => r.leaveTypeId === b.annualLeaveTypeId)!;
    expect(al.adjustment).toBe(2);
    expect(al.ytdEntitled).toBe(12);
    expectGridMatchesPanel(rows);
  });
});

// ── §3 a negative recalculation ────────────────────────────────────────────────────────────────────────
describe('r389 §3 · a downward recalculation lowers Earned to Date and is not an Adjustment', () => {
  it('a −2.00 recalculation reads Earned 12.00 (from 14.00) with Adjustment 0.00 on every surface', async () => {
    // Up front: 14 days granted on hire, then the table is corrected to 12 and the cohort recalc claws 2 back.
    const tpl = await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 14, validFrom: '2026-01-01' });
    const e = await hire('2026-01-01');
    expect(await ledgerBalance(e.employmentId, b.annualLeaveTypeId)).toBe(14);
    await updateEntitlementTemplate(adminCtx(b), {
      lineageId: tpl.lineageId,
      serviceBands: [{ fromYears: 0, toYears: null, days: 12 }],
      validFrom: '2026-02-01',
    });
    await reprojectEntitlementForLeaveTypeCohort(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, trigger: 'entitlement_template', asOf: '2026-06-15' });
    const recalcRows = (await ledgerOf(e.employmentId, b.annualLeaveTypeId)).filter((r) => r.entryType === 'adjustment');
    expect(recalcRows.map((r) => [Number(r.days), r.reason])).toEqual([[-2, `${PROFILE_RECALC_REASON_PREFIX}:${e.employmentId}`]]);

    const bd = await hrBreakdown(e.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(bd.currentYearEntitlement).toBe(12);
    expect(bd.adjustments).toBe(0);
    expect(bd.balance).toBe(12);
    expect(bd.derivation!.earned.credits.map((c) => [c.days, c.kind])).toEqual([
      [14, 'grant'],
      [-2, 'profile_recalc'],
    ]);
    expectReconciles(bd);
    const rows = await employeeBalanceRows(adminCtx(b), e.employmentId, '2026-12-31', 'en');
    const al = rows.find((r) => r.leaveTypeId === b.annualLeaveTypeId)!;
    expect(al.ytdEntitled).toBe(12);
    expect(al.adjustment).toBe(0);
    expectGridMatchesPanel(rows);
    expect((await leaveBalances(adminCtx(b), e.employmentId)).find((r) => r.leaveTypeId === b.annualLeaveTypeId)!.accrued).toBe(12);
  });
});

// ── §4 what must not move ──────────────────────────────────────────────────────────────────────────────
describe('r389 §4 · up-front grants, forfeits, pool borrowers and the a2c reversal read as before', () => {
  it('an up-front grant with no recalculation: Earned is the grant, Adjustment 0.00 — byte-identical', async () => {
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 14, validFrom: '2026-01-01' });
    const e = await hire('2026-01-01');
    const bd = await hrBreakdown(e.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(bd.currentYearEntitlement).toBe(14);
    expect(bd.adjustments).toBe(0);
    expect(bd.derivation!.earned.credits.map((c) => c.kind)).toEqual(['grant']);
    expect((await leaveBalances(adminCtx(b), e.employmentId)).find((r) => r.leaveTypeId === b.annualLeaveTypeId)!.accrued).toBe(14);
    expectGridMatchesPanel(await employeeBalanceRows(adminCtx(b), e.employmentId, '2026-12-31', 'en'));
  });

  it('a carry-forward cap forfeit stays a forfeit — never Earned, never an Adjustment', async () => {
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2025-01-01' });
    await setLeaveTypeRules(adminCtx(b), {
      id: b.annualLeaveTypeId,
      carryForwardMax: 5,
      carryForwardExpiryMonth: null,
      carryForwardExpiryDay: null,
      maxBalanceDays: null,
    });
    const e = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    const bd = await hrBreakdown(e.employmentId, b.annualLeaveTypeId, '2026-12-31');
    const capRows = (await ledgerOf(e.employmentId, b.annualLeaveTypeId)).filter((r) => r.reason === CARRY_FORFEIT_REASON_CAP);
    expect(capRows.length).toBe(1);
    expect(bd.forfeitedThisCycle).toBe(-Number(capRows[0].days));
    expect(bd.adjustments).toBe(0);
    expect(bd.derivation!.earned.credits.every((c) => c.kind === 'grant')).toBe(true);
    expectReconciles(bd);
  });

  it('a pool borrower: Earned 0.00 of its own, and its Adjustment is still the panel\'s (the pool\'s) figure', async () => {
    const [pool] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: `AL${randomUUID().slice(0, 4).toUpperCase()}`, name: 'Pool Annual', paid: true, counting: 'calendar_days' })
      .returning({ id: schema.leaveType.id });
    const [el] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: `EL${randomUUID().slice(0, 4).toUpperCase()}`, name: 'Pool Emergency', paid: true, counting: 'calendar_days', balanceSourceTypeId: pool.id })
      .returning({ id: schema.leaveType.id });
    await seedEntitlement(adminCtx(b), { leaveTypeId: pool.id, annualDays: 7, validFrom: '2026-01-01' });
    const e = await hire('2020-01-01', false);
    await openLeaveYear(adminCtx(b), { year: 2026 });
    // An automatic recalculation on the POOL, and an HR adjustment beside it.
    await post(e.employmentId, pool.id, 'adjustment', 1, '2026-03-01', `${PROFILE_RECALC_REASON_PREFIX}:${e.employmentId}`);
    await post(e.employmentId, pool.id, 'adjustment', 0.5, '2026-03-02', 'Long service');
    const rows = await employeeBalanceRows(adminCtx(b), e.employmentId, '2026-12-31', 'en');
    const poolRow = rows.find((r) => r.leaveTypeId === pool.id)!;
    const borrower = rows.find((r) => r.leaveTypeId === el.id)!;
    expect(poolRow.ytdEntitled).toBe(8); // 7 granted + 1 recalculated
    expect(poolRow.adjustment).toBe(0.5);
    expect(borrower.ytdEntitled).toBe(0); // 2a57a007: a borrower has no entitlement of its own
    expect(borrower.adjustment).toBe(0.5); // …and its Adjustment is the pool's, exactly as its panel shows
    expectGridMatchesPanel(rows);
  });

  it('the Anniversary-to-Calendar reversal: superseded recalculations stay beside it; Earned is the a2c target', async () => {
    // f3a64d90's reporter case: hired 6 Jan 2026 on 20 days, a stale −9.50 recalculation from the old model,
    // 3.50 taken; HR saves Anniversary to Calendar on 23 Jul and the engine claws the year down to 19.73 and
    // reverses the stale row with ONE combined adjustment.
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 20, validFrom: '2026-01-01' });
    const e = await hire('2026-01-06');
    await post(e.employmentId, b.annualLeaveTypeId, 'adjustment', -9.5, '2026-05-01', `${POLICY_RECALC_REASON_PREFIX}:${randomUUID()}`);
    await post(e.employmentId, b.annualLeaveTypeId, 'debit', -3.5, '2026-06-10');

    // As at a date BEFORE the correction the recalculation is not superseded yet: it is earned entitlement.
    const before = await hrBreakdown(e.employmentId, b.annualLeaveTypeId, '2026-07-01');
    expect(before.currentYearEntitlement).toBe(10.5); // 20 − 9.50
    expect(before.adjustments).toBe(0);
    expectReconciles(before);

    await updateLeaveType(adminCtx(b), { id: b.annualLeaveTypeId, name: 'Annual Leave', yearCycleOverride: 'a2c', asOf: '2026-07-23' });
    const after = await hrBreakdown(e.employmentId, b.annualLeaveTypeId, '2026-07-23');
    // UNCHANGED BY r389 — the figures f3a64d90 promised. Without the supersession rule this read 10.23 with
    // a +9.50 "Anniversary to Calendar correction" under Adjustments: the reported mismatch, one screen over.
    expect(after.currentYearEntitlement).toBe(19.73);
    expect(after.systemAdjustments).toBe(0); // −9.50 superseded + 9.50 reversal
    expect(after.adjustments).toBe(0);
    expect(after.balance).toBe(16.23);
    expect(after.derivation!.adjustments.system.map((s) => s.kind)).toEqual(['policy_recalc', 'a2c_recalc']);
    expect(after.derivation!.earned.credits.map((c) => c.kind)).toEqual(['grant', 'a2c_correction']);
    expectReconciles(after);
    const live = (await leaveBalances(adminCtx(b), e.employmentId)).find((r) => r.leaveTypeId === b.annualLeaveTypeId)!;
    expect(live.accrued).toBe(19.73);
    expect(live.balance).toBe(16.23);
    expectGridMatchesPanel(await employeeBalanceRows(adminCtx(b), e.employmentId, '2026-07-23', 'en'));
  });
});

// ── §5 the ineligible-grant reversal ───────────────────────────────────────────────────────────────────
describe('r389 §5 · the automatic reversal of an ineligible grant is an automatic correction', () => {
  it('reads as a system correction (not HR\'s), on both screens, and leaves Earned showing the grant', async () => {
    const e = await hire('2025-01-01', false);
    const [mat] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: `ML${randomUUID().slice(0, 4).toUpperCase()}`, name: 'Maternity', paid: true, counting: 'calendar_days' })
      .returning({ id: schema.leaveType.id });
    // The shape scripts/reverse-ineligible-leave-grants.ts leaves: the wrong grant kept, a reversal beside it.
    await post(e.employmentId, mat.id, 'accrual', 98, '2026-09-20');
    await post(e.employmentId, mat.id, 'adjustment', -98, '2026-09-25', INELIGIBLE_GRANT_REVERSAL_REASON);
    const bd = await hrBreakdown(e.employmentId, mat.id, '2026-12-31');
    expect(bd.currentYearEntitlement, 'the wrong grant is still on the ledger, and still shown').toBe(98);
    expect(bd.configAdjustments, 'not an adjustment HR entered').toBe(0);
    expect(bd.configAdjustmentItems).toEqual([]);
    expect(bd.systemAdjustments).toBe(-98);
    expect(bd.adjustments).toBe(-98);
    expect(bd.derivation!.adjustments.system).toEqual([{ effectiveOn: '2026-09-25', days: -98, kind: 'ineligible_grant_reversal' }]);
    expect(bd.balance).toBe(0);
    expectReconciles(bd);
    const lines = explainLeaveSummary(bd, { available: bd.totalAvailable });
    expect(lines.adjustment.map((s) => s.key)).toEqual(['adjNoManual', 'adjSystemIntro', 'adjSystemItem', 'addsUpTo']);
    const rows = await employeeBalanceRows(adminCtx(b), e.employmentId, '2026-12-31', 'en');
    expect(rows.find((r) => r.leaveTypeId === mat.id)!.adjustment).toBe(-98);
    expectGridMatchesPanel(rows);
  });
});

// ── §6 one rule, two languages ─────────────────────────────────────────────────────────────────────────
describe('r389 §6 · the engines\' SQL predicate and the read model\'s JS predicate select the same rows', () => {
  it('on a ledger holding every row class, entitlementGrantedRowCond ≡ isEntitlementGrantedRow, and Earned adds only Leave Credits', async () => {
    const e = await reporterLedger();
    const t = b.annualLeaveTypeId;
    // Every other class, so the comparison is not vacuous: an HR adjustment, a typed reason that merely starts
    // like a recalc prefix, a forfeit, a Leave Credit, a policy recalc, an ineligible-grant reversal.
    await post(e.employmentId, t, 'adjustment', 1, '2026-02-01', 'CNY 2026');
    await post(e.employmentId, t, 'adjustment', 1, '2026-02-02', `${PROFILE_RECALC_REASON_PREFIX}ulation note`);
    await post(e.employmentId, t, 'adjustment', -1, '2026-01-01', CARRY_FORFEIT_REASON_CAP);
    await post(e.employmentId, t, 'in_lieu_accrual', 1, '2026-03-01');
    await post(e.employmentId, t, 'adjustment', 0.5, '2026-04-01', `${POLICY_RECALC_REASON_PREFIX}:${randomUUID()}`);
    await post(e.employmentId, t, 'adjustment', -0.5, '2026-04-02', INELIGIBLE_GRANT_REVERSAL_REASON);
    const all = await withTenant(adminCtx(b), (tx) =>
      tx
        .select({ id: schema.leaveLedger.id, entryType: schema.leaveLedger.entryType, reason: schema.leaveLedger.reason, effectiveOn: schema.leaveLedger.effectiveOn })
        .from(schema.leaveLedger)
        .where(eq(schema.leaveLedger.employmentId, e.employmentId)),
    );
    const bySql = await withTenant(adminCtx(b), (tx) =>
      tx
        .select({ id: schema.leaveLedger.id })
        .from(schema.leaveLedger)
        .where(and(eq(schema.leaveLedger.employmentId, e.employmentId), entitlementGrantedRowCond())),
    );
    expect(all.length).toBeGreaterThanOrEqual(10);
    const sqlIds = new Set(bySql.map((r) => r.id));
    for (const r of all) {
      expect(isEntitlementGrantedRow(r), `${r.entryType} ${r.reason ?? ''}`).toBe(sqlIds.has(r.id));
      // Earned to Date = granted + Leave Credits, nothing else.
      expect(isEarnedToDateRow(r), `${r.entryType} ${r.reason ?? ''}`).toBe(sqlIds.has(r.id) || r.entryType === 'in_lieu_accrual');
    }
    // And the breakdown agrees with its own predicate over the same window.
    const bd = await hrBreakdown(e.employmentId, t);
    expect(bd.currentYearEntitlement).toBe(r2(12 + 1 + 0.5)); // + Leave Credit + policy recalc
    expect(bd.configAdjustments).toBe(2); // CNY + the look-alike typed reason
    expect(bd.systemAdjustments).toBe(-0.5); // the ineligible-grant reversal
    expect(bd.forfeitedThisCycle).toBe(1);
    expectReconciles(bd);
  });
});
