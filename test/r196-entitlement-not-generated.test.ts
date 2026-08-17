/**
 * 31e39d74 / r196 — "CONFIGURED BUT NOT YET GENERATED" IS NOW A VALUE, NOT A SILENCE.
 *
 * The reporter configured entitlement tables for Medical and Hospitalization Leave and saw 0.00 on My
 * Leave. r193 (`a9d0a94a`) fixed the ENGINE that produced the zero — tables read from the date they apply,
 * mid-year joiners visited, a sole table applied without a rule — and this file guards the other half they
 * asked for in their own words:
 *
 *   "If a separate Generate Entitlement / Run Accrual action is required, the system should clearly
 *    indicate that the entitlement is configured but not yet generated, rather than silently showing 0.00."
 *
 * ── WHAT MAKES THIS HARD, AND WHAT THESE CASES ARE REALLY PINNING ────────────────────────────────────
 * The state CANNOT be read off the ledger, and the two ways of getting that wrong are opposite:
 *
 *   • `openLeaveYear` SKIPS a pair whose composed entitlement is <= 0 (`no_entitlement`) and writes NO row.
 *     So "no accrual rows" does not mean "never generated".
 *   • the `accrual_unconfigured` path DOES write a row — a 0.00 accrual, deliberately, because that row is
 *     openLeaveYear's own idempotency marker AND the expiry sweep's "year was opened" marker. So
 *     "currentYearEntitlement === 0" does not mean "never generated" either.
 *
 * Hence three inputs (a table in force · the earning-method marker · an accrual ROW in the cycle), and
 * hence the two cases below that would pass under either naive rule and fail under the other:
 *   – `earning method missing, AFTER a generation run` — a 0.00 accrual row exists and the type must STILL
 *     say "earning method not set", not "generated". A sum-based test cannot tell these apart.
 *   – `a table that resolves no band` — a real table applies, so 0.00 is NOT "not configured".
 *
 * ── AND WHY `earning_method_missing` OUTRANKS `not_generated` ────────────────────────────────────────
 * Both are true of Hospitalization Leave on the reporter's account. Saying "not generated yet" sends them
 * to press Generate Entitlement, which writes a 0.00 row and returns them to a silent zero. The earning
 * method is the thing they can fix, so it is the thing they are told. That precedence is asserted directly
 * (`earning method missing outranks…`) because it is a decision, not an accident of the if-order.
 *
 * The plan is explicit that the earning method is the reporter's own DATA state: this surfaces it and
 * changes nothing. Nothing in this file, and nothing it exercises, writes a leave-type setting.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { openLeaveYear } from '../core/leave';
import { leaveEntitlementBreakdown } from '../core/read';
import { createEntitlementTemplate } from '../core/entitlement-template';
import {
  ENTITLEMENT_STATUS_LABEL_KEY,
  ENTITLEMENT_STATUS_TIP_KEY,
  entitlementStatusNeedsNotice,
  resolveEntitlementStatus,
  type EntitlementStatus,
} from '../lib/entitlement-status';
import { deriveBalanceRow, type BalanceInput, type BreakdownInput } from '../components/leave/leave-balance-row';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const msgs = (loc: string) => JSON.parse(read(`messages/${loc}.json`)) as Record<string, never>;

const ALL_STATUSES: EntitlementStatus[] = [
  'granted',
  'not_generated',
  'earning_method_missing',
  'not_configured',
];

// ── The pure derivation ─────────────────────────────────────────────────────────────────────────────

describe('resolveEntitlementStatus: the three facts, and the order they are asked in', () => {
  it('no table in force ⇒ not_configured, whatever the other two say', () => {
    for (const accrualUnconfigured of [false, true]) {
      for (const hasAccrualRowInCycle of [false, true]) {
        expect(
          resolveEntitlementStatus({ hasTemplateInForce: false, accrualUnconfigured, hasAccrualRowInCycle }),
          `${accrualUnconfigured}/${hasAccrualRowInCycle}`,
        ).toBe('not_configured');
      }
    }
  });

  it('a table, a chosen earning method and no accrual row ⇒ not_generated — the reporter’s case', () => {
    expect(
      resolveEntitlementStatus({
        hasTemplateInForce: true,
        accrualUnconfigured: false,
        hasAccrualRowInCycle: false,
      }),
    ).toBe('not_generated');
  });

  it('a table and an accrual row ⇒ granted', () => {
    expect(
      resolveEntitlementStatus({
        hasTemplateInForce: true,
        accrualUnconfigured: false,
        hasAccrualRowInCycle: true,
      }),
    ).toBe('granted');
  });

  it('earning method missing outranks BOTH not_generated and granted', () => {
    // Before a run: telling HR "not generated" sends them to press Generate, which grants 0.00 and returns
    // them here. After a run: a 0.00 accrual row exists, and calling that "granted" is the silent zero the
    // item is about. One answer covers both, and it is the one HR can act on.
    for (const hasAccrualRowInCycle of [false, true]) {
      expect(
        resolveEntitlementStatus({
          hasTemplateInForce: true,
          accrualUnconfigured: true,
          hasAccrualRowInCycle,
        }),
        `row=${hasAccrualRowInCycle}`,
      ).toBe('earning_method_missing');
    }
  });

  it('exactly the two middle states are announced on screen', () => {
    expect(ALL_STATUSES.filter(entitlementStatusNeedsNotice)).toEqual([
      'not_generated',
      'earning_method_missing',
    ]);
  });

  it('every status has a label; only the announced two carry an explanation', () => {
    for (const s of ALL_STATUSES) expect(ENTITLEMENT_STATUS_LABEL_KEY[s], s).toBeTruthy();
    expect(Object.keys(ENTITLEMENT_STATUS_TIP_KEY).sort()).toEqual(
      ['earning_method_missing', 'not_generated'].sort(),
    );
  });
});

// ── The pure row derivation both balance grids share ────────────────────────────────────────────────

const balanceInput = (over: Partial<BalanceInput> = {}): BalanceInput => ({
  leaveTypeId: 'lt1',
  leaveType: 'Hospitalization Leave',
  color: null,
  icon: null,
  code: 'HOSP',
  balance: 0,
  available: 0,
  taken: 0,
  essView: {},
  ...over,
});

const breakdownInput = (status: EntitlementStatus): BreakdownInput => ({
  monthlyAccruedToDate: null,
  currentYearEntitlement: 0,
  carriedForward: 0,
  forfeited: 0,
  otherAdjustments: 0,
  configAdjustments: 0,
  entitlementStatus: status,
});

describe('deriveBalanceRow carries the status to every grid that shows a 0.00', () => {
  it('picks the server’s status through unchanged — it is never re-derived from the figures', () => {
    for (const s of ALL_STATUSES) {
      expect(deriveBalanceRow(balanceInput(), breakdownInput(s)).entitlementStatus, s).toBe(s);
    }
  });

  it('no breakdown loaded ⇒ not_configured, so no screen claims a table it never saw', () => {
    expect(deriveBalanceRow(balanceInput(), null).entitlementStatus).toBe('not_configured');
    expect(deriveBalanceRow(balanceInput(), null).ytdEntitled).toBeNull();
  });

  it('survives ESS hiding — the REASON for a zero is not one of the figures HR can hide', () => {
    // A tenant that hides Available/Taken from self-service still owes the employee an explanation for a
    // 0.00 entitlement. Blanking the caption with the figures would recreate the silence exactly.
    const row = deriveBalanceRow(
      balanceInput({ essView: { available: false, taken: false } }),
      breakdownInput('not_generated'),
    );
    expect(row.available).toBeNull();
    expect(row.taken).toBeNull();
    expect(row.entitlementStatus).toBe('not_generated');
  });
});

// ── End to end, against a real ledger ───────────────────────────────────────────────────────────────

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

/** A leave type whose code is NOT a standing code, so no statutory floor masks the table's decision.
 *  `unconfigured` stamps bc36c768's marker exactly as migration 0376 did on the reporter's account. */
async function customLeaveType(code: string, name: string, unconfigured = false): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code,
      name,
      paid: true,
      accrualUnconfigured: unconfigured ? new Date('2026-01-01T00:00:00Z') : null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** One entitlement table for a type and NO eligibility rule — the reporter's Hospitalization shape, which
 *  r193's fault-3 fix made resolvable (exactly one table in force, nothing to choose between). */
const table = (leaveTypeId: string, days: number, validFrom: string, name: string) =>
  createEntitlementTemplate(adminCtx(b), {
    leaveTypeId,
    name,
    serviceBands: [{ fromYears: 0, toYears: null, days }],
    validFrom,
  });

/** Hired with NO hire grant, so the only entitlement that can reach the ledger is a year-open. */
const hire = (hiredOn: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'R196', primaryEmail: `r196_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });

const ASOF = '2026-12-31';

describe('31e39d74: the breakdown says WHY a leave type reads 0.00', () => {
  it('a table written in August, before Generate Entitlement is run ⇒ not_generated, and it names the table', async () => {
    const typeId = await customLeaveType('MED196', 'Medical Leave');
    await table(typeId, 14, '2026-08-01', 'Medical — all staff');
    const emp = await hire('2024-03-01');

    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(bd).not.toBeNull();
    // The defect as reported: the figure IS zero. What changes is that the zero now carries a reason.
    expect(bd!.currentYearEntitlement).toBe(0);
    expect(bd!.entitlementStatus).toBe('not_generated');
    expect(bd!.entitlementTemplateName).toBe('Medical — all staff');
    // And it is not merely "nothing configured" — the table resolved, which is what makes 0.00 wrong.
    expect(bd!.eligibleDays).toBe(14);
  });

  it('running the year-open flips it to granted', async () => {
    const typeId = await customLeaveType('MED196', 'Medical Leave');
    await table(typeId, 14, '2026-08-01', 'Medical — all staff');
    const emp = await hire('2024-03-01');

    await openLeaveYear(adminCtx(b), { year: 2026 });

    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(bd!.currentYearEntitlement).toBe(14);
    expect(bd!.entitlementStatus).toBe('granted');
  });

  it('a leave type with no table at all stays not_configured — 0.00 is the true answer there', async () => {
    const typeId = await customLeaveType('UNCONF196', 'Unconfigured Leave');
    const emp = await hire('2024-03-01');

    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(bd!.entitlementStatus).toBe('not_configured');
    expect(bd!.entitlementTemplateName).toBeNull();
    // Announcing this one on every unconfigured type would bury the two that matter.
    expect(entitlementStatusNeedsNotice(bd!.entitlementStatus)).toBe(false);
  });

  it('the Hospitalization shape: a table, no earning method — said BEFORE and AFTER a generation run', async () => {
    // THE CASE THE ITEM EXISTS FOR. On the reporter's account Hospitalization has exactly one table and no
    // earning method, so a year-open writes a 0.00 accrual row (it is the idempotency marker) and every
    // sum-based reading of the ledger reports "granted 0.00" — the silent zero, one layer deeper.
    const typeId = await customLeaveType('HOSP196', 'Hospitalization Leave', true);
    await table(typeId, 60, '2026-01-01', 'Hospitalization — all staff');
    const emp = await hire('2024-03-01');

    const before = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(before!.entitlementStatus).toBe('earning_method_missing');

    await openLeaveYear(adminCtx(b), { year: 2026 });

    // The 0.00 marker row really is there — this is what would fool a sum-based or row-count-only test.
    const ledger = await owner.db
      .select({ days: schema.leaveLedger.days, entryType: schema.leaveLedger.entryType })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.leaveTypeId, typeId));
    expect(ledger.filter((r) => r.entryType === 'accrual').map((r) => Number(r.days))).toEqual([0]);

    const after = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(after!.currentYearEntitlement).toBe(0);
    expect(after!.entitlementStatus).toBe('earning_method_missing');
    // Surfaced, never fixed: the marker is exactly as HR left it (the plan's explicit instruction).
    const [lt] = await owner.db
      .select({ marker: schema.leaveType.accrualUnconfigured })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, typeId));
    expect(lt.marker).not.toBeNull();
  });

  it('a mid-year joiner reads not_generated too — they are in the leave year (r193 fault 2)', async () => {
    const typeId = await customLeaveType('MED196', 'Medical Leave');
    await table(typeId, 14, '2026-01-01', 'Medical — all staff');
    const emp = await hire('2026-05-04');

    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(bd!.entitlementStatus).toBe('not_generated');

    await openLeaveYear(adminCtx(b), { year: 2026 });
    const after = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(after!.entitlementStatus).toBe('granted');
  });

  it('the status is dated at asOf, so a table is never claimed for a period it did not cover', async () => {
    // ⚠️ THIS CASE FAILED FIRST TIME ROUND AND THE CODE WAS RIGHT. The obvious expectation — "before the
    // run it says not_generated, at every date" — is wrong and would be a NEW false alarm: as at 31 July a
    // table dated 1 August is not in force, nothing was owed, and 0.00 is the correct and complete answer.
    // Announcing "configured but not yet generated" for a period the table never covered would send HR
    // chasing an entitlement that did not exist then. The status is resolved through the SAME dated
    // template resolver every other figure in this breakdown uses, which is what makes that fall out.
    const typeId = await customLeaveType('MED196', 'Medical Leave');
    await table(typeId, 14, '2026-08-01', 'Medical — all staff');
    const emp = await hire('2024-03-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const july = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, '2026-07-31');
    const december = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(july!.entitlementStatus).toBe('not_configured');
    expect(july!.entitlementTemplateName).toBeNull();
    expect(december!.entitlementStatus).toBe('granted');
    expect(december!.entitlementTemplateName).toBe('Medical — all staff');
  });
});

// ── The surfaces the reporter listed ────────────────────────────────────────────────────────────────

describe('31e39d74: every surface that shows the figure also shows the reason', () => {
  it('My Leave’s balance grid captions the YTD Entitled cell without displacing the figure', () => {
    const src = read('components/leave/leave-balance-table.tsx');
    expect(src).toContain('entitlementStatusNeedsNotice(r.entitlementStatus)');
    expect(src).toContain('ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus]');
    expect(src).toContain('ENTITLEMENT_STATUS_TIP_KEY[r.entitlementStatus]');
    // The number stays: YTD Entitled = currentYearEntitlement + carriedForward, so an ungenerated type
    // with a carry-in has a REAL non-zero figure here and replacing it would be a second wrong reading.
    expect(src).toContain('{fmt(r.ytdEntitled)}');
  });

  it('Employee Balances captions the same cell, in the same column count', () => {
    const src = read('app/leave/employee-balances/page.tsx');
    expect(src).toContain('entitlementStatusNeedsNotice(r.entitlementStatus)');
    expect(src).toContain('{num(r.ytdEntitled)}');
    // No new column: eleven is what the header row and the empty-state colSpan agree on, and 026e16b9
    // already measured this table to the pixel.
    expect(src).toContain('colSpan={11}');
  });

  it('the export carries it as a column, so the file cannot disagree with the screen', () => {
    const src = read('app/leave/employee-balances/export/route.ts');
    expect(src).toContain("tInq('colEntitlementStatus')");
    expect(src).toContain('tMe(ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus])');
    // Header and cell must move together — a column added to one list only silently shifts every figure.
    const columns = src.slice(src.indexOf('columns: ['), src.indexOf('rows: rows.map'));
    const cells = src.slice(src.indexOf('rows: rows.map'));
    expect(columns.includes('colEntitlementStatus')).toBe(true);
    expect(cells.includes('ENTITLEMENT_STATUS_LABEL_KEY')).toBe(true);
  });

  it('the balance breakdown panel states it in full, above the column of figures', () => {
    const src = read('components/leave/LeaveDetailsPanel.tsx');
    expect(src).toContain('entitlementStatusNeedsNotice(data.entitlementStatus)');
    expect(src).toContain("statusNotGeneratedTitle");
    expect(src).toContain("statusEarningMethodMissingTitle");
    expect(src).toContain("t('statusEntitlementTable', { name: data.entitlementTemplateName })");
    // It is NOT a descriptor field: ENTITLEMENT_PANEL_SECTIONS is the reconciliation column, and every
    // entry in it is a signed addend that must close onto Available Balance. A status is not an addend.
    expect(read('components/leave/entitlement-panel-config.ts')).not.toContain('entitlementStatus');
  });

  it('the HR-side personnel record captions it too — an em dash is not an answer either', () => {
    const src = read('app/admin/personnel/[employmentId]/page.tsx');
    expect(src).toContain('entitlementStatusNeedsNotice(st)');
    expect(src).toContain('ENTITLEMENT_STATUS_LABEL_KEY[st]');
  });

  it('the derivation is DB-free and framework-free, so server and client share one definition', () => {
    const src = read('lib/entitlement-status.ts');
    expect(src).not.toContain('drizzle-orm');
    expect(src).not.toContain("from 'react'");
    expect(src).not.toContain('use client');
    expect(src).not.toContain('@/db');
  });

  it('ships every string in all six locales', () => {
    const balanceKeys = [
      'statusGenerated',
      'statusNotGenerated',
      'statusEarningMethodMissing',
      'statusNotConfigured',
      'statusNotGeneratedTip',
      'statusEarningMethodMissingTip',
    ];
    const breakdownKeys = [
      'statusNotGeneratedTitle',
      'statusNotGeneratedBody',
      'statusEarningMethodMissingTitle',
      'statusEarningMethodMissingBody',
      'statusEntitlementTable',
    ];
    for (const loc of LOCALES) {
      const m = msgs(loc) as unknown as {
        me: { leaveBalanceTable: Record<string, string> };
        leave: { breakdown: Record<string, string>; inquiry: Record<string, string> };
      };
      for (const k of balanceKeys) expect(m.me.leaveBalanceTable?.[k], `${loc} me.leaveBalanceTable.${k}`).toBeTruthy();
      for (const k of breakdownKeys) expect(m.leave.breakdown?.[k], `${loc} leave.breakdown.${k}`).toBeTruthy();
      expect(m.leave.inquiry?.colEntitlementStatus, `${loc} leave.inquiry.colEntitlementStatus`).toBeTruthy();
      // Every status the code can produce must have a label to print in that locale.
      for (const s of ALL_STATUSES) {
        expect(m.me.leaveBalanceTable?.[ENTITLEMENT_STATUS_LABEL_KEY[s]], `${loc} label for ${s}`).toBeTruthy();
      }
      expect(m.leave.breakdown.statusEntitlementTable).toContain('{name}');
    }
  });
});
