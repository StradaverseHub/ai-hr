/**
 * r397 — MY LEAVE (app/leave/page.tsx) RENDERS FASTER, AND NOT ONE FIGURE MOVED.
 *
 * The page's reads were a sequential chain of ~200 statements. r397 runs the independent ones concurrently
 * (app/leave/my-leave-data.ts) and removes per-leave-type re-reads inside the dashboard. Leave balances are
 * money-adjacent, so the proof is equivalence, not a spot check:
 *
 *   (1) For every employee and configuration below, `loadMyLeave` (the page's loader, new) returns a
 *       structure DEEP-EQUAL to `loadMyLeaveBefore` (test/fixtures/r397-leave-before.ts — the page's reads
 *       as they were, verbatim, sequential, against the pre-r397 kernel functions).
 *   (2) The statement count of one load is pinned, with its breakdown, so a reintroduced N+1 fails here.
 *
 * Configurations: an earned-accrual ANNUAL type with a prior-year carry forward, an approved and a pending
 * request (the pending one a HALF DAY), Sick with an entitlement template, Replacement Leave with the toil
 * module ON (a ledger credit and a PENDING claim), a shared leave group over two member types, a HIDDEN and
 * an ARCHIVED type with ledger rows, an anniversary-cycle type; an employee with TWO employments (rehired,
 * history on the first); an employee with nothing at all; the leave-year selector on an earlier year, on a
 * malformed value and on the current year; a non-English locale.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const nodeFs = await import('node:fs');
  const cache = new Map<string, unknown>();
  const messages = (locale: string) => {
    if (!cache.has(locale)) cache.set(locale, JSON.parse(nodeFs.readFileSync(`messages/${locale}.json`, 'utf8')));
    return cache.get(locale) as Record<string, unknown>;
  };
  return {
    getTranslations: async (arg: string | { locale?: string; namespace?: string }) =>
      createTranslator({
        locale: 'en',
        messages: messages('en'),
        namespace: (typeof arg === 'string' ? arg : arg.namespace) as never,
      }),
    getLocale: async () => 'en',
  };
});

import * as schema from '../db/schema';
import { client, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { decideLeave, requestLeave } from '../core/leave';
import { myEmployment } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';
import { setToilPolicy } from '../core/toil';
import { createEntitlementTemplate } from '../core/entitlement-template';
import { leaveEntitlementBreakdown, leaveEntitlementBreakdowns } from '../core/read';
import { leaveTypeApplySummary, leaveTypeApplySummaries } from '../core/leave';
import { loadMyLeaveBefore } from './fixtures/r397-leave-before';
import { loadMyLeave } from '../app/leave/my-leave-data';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  setModule,
  type Base,
} from './harness';

const TODAY = todayInKualaLumpur();
const YEAR = Number(TODAY.slice(0, 4));
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let b: Base;
type Emp = { personId: string; employmentId: string; ctx: SessionContext };
const emps: Record<string, Emp> = {};

/** Every statement the app pool sends (BEGIN/COMMIT bookkeeping excluded), in order. */
async function captureQueries<T>(fn: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
  const sqlClient = client as unknown as { options: { debug?: unknown } };
  const statements: string[] = [];
  sqlClient.options.debug = (_id: number, str: string) => {
    const s = str.trim().toLowerCase();
    if (/^(begin|commit|rollback|savepoint|release)/.test(s)) return;
    statements.push(str.trim());
  };
  try {
    const result = await fn();
    return { result, statements };
  } finally {
    sqlClient.options.debug = undefined;
  }
}

async function leaveType(values: Partial<typeof schema.leaveType.$inferInsert>): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: `R397_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Type ${randomUUID().slice(0, 6)}`,
      paid: true,
      counting: 'calendar_days',
      visibleToEmployee: true,
      allowNegativeBalance: true,
      ...values,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const ledger = (
  employmentId: string,
  leaveTypeId: string,
  entryType: 'accrual' | 'debit' | 'adjustment' | 'in_lieu_accrual',
  days: number,
  effectiveOn: string,
) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType,
    days: days.toFixed(2),
    effectiveOn,
  });

async function employeeCtx(personId: string): Promise<SessionContext> {
  const base = await entitledCtx(b, ['employee']);
  return {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, personId, 'employee'),
    personId,
    roles: ['employee'],
    entitlements: base.entitlements,
  };
}

async function hire(name: string, hiredOn: string, personId?: string) {
  const e = await hireEmployee(adminCtx(b), {
    person: personId ? { id: personId } : { fullName: name, primaryEmail: `r397_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  } as Parameters<typeof hireEmployee>[1]);
  return e;
}

const types: Record<string, string> = {};

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'toil', 'active');
  await setToilPolicy(adminCtx(b), {
    companyId: b.companyId,
    enabled: true,
    accrualBasis: 'hours_worked',
    expiryDays: 90,
    onExpiry: 'convert_to_pay',
    allowFirstScheduleEligible: true,
    autoAccrueOnApproval: false,
    carryForwardAtYearEnd: false,
    employeeRequestEnabled: true,
  });

  // ── The catalogue ────────────────────────────────────────────────────────────────────────────────
  types.annual = b.annualLeaveTypeId;
  await owner.db.update(schema.leaveType).set({ role: 'annual', essPlacement: 'primary', durations: ['full_day', 'half_day_am', 'half_day_pm'] }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
  types.sick = await leaveType({ code: 'SICK', name: 'Sick Leave', essPlacement: 'primary' });
  // setToilPolicy already ensured the tenant's Replacement Leave type (core/toil.ts ensureReplacementLeaveType).
  const [repl] = await owner.db
    .select({ id: schema.leaveType.id })
    .from(schema.leaveType)
    .where(and(eq(schema.leaveType.tenantId, b.tenantId), sql`lower(${schema.leaveType.code}) = 'replacement'`));
  types.repl = repl.id;
  await owner.db.update(schema.leaveType).set({ role: 'replacement', visibleToEmployee: true }).where(eq(schema.leaveType.id, repl.id));
  types.sg1 = await leaveType({ code: 'CPL', name: 'Compassionate Leave' });
  types.sg2 = await leaveType({ code: 'MRG', name: 'Marriage Leave' });
  types.hidden = await leaveType({ code: 'HIDE', name: 'Hidden Leave', visibleToEmployee: false });
  types.archived = await leaveType({ code: 'OLD', name: 'Retired Leave', archivedAt: new Date(`${YEAR - 1}-06-01T00:00:00Z`) } as never);
  types.a2a = await leaveType({ code: 'STUDY', name: 'Study Leave', yearCycleOverride: 'a2a' });
  types.unpaid = await leaveType({ code: 'UNPAID', name: 'Unpaid Leave', paid: false });
  // A type that BORROWS Annual Leave's balance (Balance Deduction Source): its pending days reserve Annual's.
  types.borrower = await leaveType({ code: 'EMERG', name: 'Emergency Leave', balanceSourceTypeId: b.annualLeaveTypeId });
  // A type with ONE table and NO rule (the sole-table path) and one whose only rule points at another company
  // (no_eligibility_match, which reads the eligibility explanation) — the resolver's two short-circuit shapes.
  types.sole = await leaveType({ code: 'HOSP', name: 'Hospitalisation Leave' });
  types.nomatch = await leaveType({ code: 'MAT', name: 'Maternity Leave' });
  await createEntitlementTemplate(adminCtx(b), {
    leaveTypeId: types.sole,
    name: 'Hospitalisation table',
    serviceBands: [{ fromYears: 0, toYears: null, days: 60 }],
    validFrom: `${YEAR - 3}-01-01`,
  });
  const [otherCo] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' }).returning({ id: schema.company.id });
  await seedEntitlement(adminCtx(b), { leaveTypeId: types.nomatch, annualDays: 60, companyId: otherCo.id, validFrom: `${YEAR - 3}-01-01` });
  await seedEntitlement(adminCtx(b), { leaveTypeId: types.sick, annualDays: 14, validFrom: `${YEAR - 3}-01-01` });
  await seedEntitlement(adminCtx(b), { leaveTypeId: types.annual, annualDays: 14, validFrom: `${YEAR - 3}-01-01` });
  const [grp] = await owner.db
    .insert(schema.leaveSharedGroup)
    .values({ tenantId: b.tenantId, name: 'Special Leave', totalLimitDays: '5.00', maxDaysPerApplication: '3.00', essPlacement: 'secondary' } as never)
    .returning({ id: schema.leaveSharedGroup.id });
  await owner.db.insert(schema.leaveSharedGroupMember).values([
    { tenantId: b.tenantId, groupId: grp.id, leaveTypeId: types.sg1 },
    { tenantId: b.tenantId, groupId: grp.id, leaveTypeId: types.sg2 },
  ]);

  // ── Rich: every kind of row ──────────────────────────────────────────────────────────────────────
  const rich = await hire('Rich Employee', `${YEAR - 3}-01-15`);
  emps.rich = { ...rich, ctx: await employeeCtx(rich.personId) };
  const r = rich.employmentId;
  await ledger(r, types.annual, 'accrual', 12, `${YEAR - 1}-01-01`);
  await ledger(r, types.annual, 'debit', -4, `${YEAR - 1}-03-10`);
  await ledger(r, types.annual, 'adjustment', 3, `${YEAR}-01-01`); // carry forward from last year
  await ledger(r, types.annual, 'accrual', 14, `${YEAR}-01-01`);
  await ledger(r, types.sick, 'accrual', 14, `${YEAR}-01-01`);
  await ledger(r, types.repl, 'in_lieu_accrual', 2, addDays(TODAY, -10));
  await ledger(r, types.sg1, 'accrual', 3, `${YEAR}-01-01`);
  await ledger(r, types.sg2, 'accrual', 3, `${YEAR}-01-01`);
  await ledger(r, types.hidden, 'accrual', 5, `${YEAR}-01-01`);
  await ledger(r, types.archived, 'accrual', 2, `${YEAR - 1}-01-01`);
  await ledger(r, types.a2a, 'accrual', 4, `${YEAR - 1}-01-15`);
  await ledger(r, types.sole, 'accrual', 60, `${YEAR}-01-01`);
  await ledger(r, types.nomatch, 'accrual', 1, `${YEAR}-01-01`);
  await ledger(r, types.annual, 'accrual', 1.5, `${YEAR}-02-01`); // a later grant inside the cycle
  // An approved full day (admin files it — no backdating gate), a pending HALF DAY, a pending shared-group day.
  const appr = await requestLeave(adminCtx(b), { employmentId: r, leaveTypeId: types.annual, startDate: addDays(TODAY, 14), endDate: addDays(TODAY, 15), today: TODAY });
  await decideLeave(adminCtx(b), { leaveRequestId: appr.leaveRequestId, decision: 'approved' });
  await requestLeave(adminCtx(b), { employmentId: r, leaveTypeId: types.annual, startDate: addDays(TODAY, 30), endDate: addDays(TODAY, 30), durationType: 'half_day_am', today: TODAY });
  await requestLeave(adminCtx(b), { employmentId: r, leaveTypeId: types.sg1, startDate: addDays(TODAY, 40), endDate: addDays(TODAY, 40), today: TODAY });
  // A pending request on the BORROWER: it reserves Annual Leave's balance.
  await requestLeave(adminCtx(b), { employmentId: r, leaveTypeId: types.borrower, startDate: addDays(TODAY, 60), endDate: addDays(TODAY, 61), today: TODAY });
  const rej = await requestLeave(adminCtx(b), { employmentId: r, leaveTypeId: types.sick, startDate: addDays(TODAY, 50), endDate: addDays(TODAY, 50), today: TODAY });
  await decideLeave(adminCtx(b), { leaveRequestId: rej.leaveRequestId, decision: 'rejected', rejectReason: 'Clash' });
  // A PENDING replacement claim.
  await owner.db.insert(schema.replacementLeaveRequest).values({
    tenantId: b.tenantId,
    employmentId: r,
    unit: 'day',
    totalDays: '1.00',
    submittedOn: addDays(TODAY, -2),
    status: 'pending',
  } as never);

  // ── Rehired: two employments, history on the terminated first one ────────────────────────────────
  const first = await hire('Rehired Employee', `${YEAR - 4}-02-01`);
  await ledger(first.employmentId, types.annual, 'accrual', 10, `${YEAR - 3}-01-01`);
  const old = await requestLeave(adminCtx(b), { employmentId: first.employmentId, leaveTypeId: types.annual, startDate: addDays(TODAY, 3), endDate: addDays(TODAY, 3), today: TODAY });
  await decideLeave(adminCtx(b), { leaveRequestId: old.leaveRequestId, decision: 'approved' });
  await owner.db.update(schema.employment).set({ terminatedOn: `${YEAR - 1}-12-31` }).where(eq(schema.employment.id, first.employmentId));
  const second = await hire('Rehired Employee', `${YEAR}-01-01`, first.personId);
  await ledger(second.employmentId, types.annual, 'accrual', 7, `${YEAR}-01-01`);
  await requestLeave(adminCtx(b), { employmentId: second.employmentId, leaveTypeId: types.sick, startDate: addDays(TODAY, 5), endDate: addDays(TODAY, 6), today: TODAY });
  emps.rehired = { ...second, personId: first.personId, ctx: await employeeCtx(first.personId) };

  // ── Empty: nothing at all ────────────────────────────────────────────────────────────────────────
  const empty = await hire('Empty Employee', addDays(TODAY, -3));
  emps.empty = { ...empty, ctx: await employeeCtx(empty.personId) };
}, 240_000);

afterAll(async () => {
  await closeAll();
});

type Case = { name: string; emp: string; sp: Record<string, string | string[]>; locale: string };
const CASES: Case[] = [
  { name: 'rich · no year', emp: 'rich', sp: {}, locale: 'en' },
  { name: 'rich · earlier leave year', emp: 'rich', sp: { leaveYear: String(YEAR - 1) }, locale: 'en' },
  { name: 'rich · current leave year written out', emp: 'rich', sp: { leaveYear: String(YEAR) }, locale: 'en' },
  { name: 'rich · malformed leave year', emp: 'rich', sp: { leaveYear: '20x6' }, locale: 'en' },
  { name: 'rich · a year with no rows', emp: 'rich', sp: { leaveYear: String(YEAR - 9) }, locale: 'en' },
  { name: 'rich · apply deep link with a history tab', emp: 'rich', sp: { apply: '1', hTab: 'approved', hType: [types.annual ?? ''] }, locale: 'en' },
  { name: 'rich · Malay', emp: 'rich', sp: {}, locale: 'ms' },
  { name: 'rehired · two employments', emp: 'rehired', sp: {}, locale: 'en' },
  { name: 'rehired · earlier leave year', emp: 'rehired', sp: { leaveYear: String(YEAR - 1) }, locale: 'en' },
  { name: 'empty · nothing at all', emp: 'empty', sp: {}, locale: 'en' },
];

async function inputs(c: Case) {
  const e = emps[c.emp];
  const me = await myEmployment(e.ctx);
  expect(me, `${c.name}: the employee resolves`).not.toBeNull();
  // `hType` is filled in after the catalogue exists.
  const sp = { ...c.sp, ...(c.sp.hType ? { hType: [types.annual] } : {}) };
  return { session: e.ctx, scopeIds: [b.companyId], me: me!, sp, locale: c.locale, today: TODAY };
}

describe('r397 · the My Leave loader returns exactly what the sequential reads returned', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const p = await inputs(c);
      const before = await loadMyLeaveBefore(p);
      const after = await loadMyLeave(p);
      expect(after).toEqual(before);
      // Non-vacuity: the rich cases really carry the configurations they claim to.
      if (c.emp === 'rich' && !c.sp.leaveYear) {
        expect(before.dashboard!.cards.length).toBeGreaterThanOrEqual(5);
        expect(before.replacementLedger, 'a Replacement Leave card ⇒ its ledger was read').not.toBeNull();
        expect(before.replacementRequests.some((q) => q.status === 'pending')).toBe(true);
        expect(before.sharedGroupBalances.length).toBe(1);
        expect(before.replacementRequest.allowed).toBe(true);
        expect(before.leaveCreditOffer).not.toBeNull();
        expect(before.upcoming.length).toBeGreaterThanOrEqual(3);
      }
    }, 60_000);
  }
});

describe('r397 · the batched per-type reads answer what the single reads answer, item for item', () => {
  it('leaveEntitlementBreakdowns = leaveEntitlementBreakdown for every type × several dates, both employments', async () => {
    const all = Object.values(types);
    const dates = [TODAY, `${YEAR}-12-31`, `${YEAR - 1}-12-31`, `${YEAR - 1}-06-30`, addDays(TODAY, 45)];
    for (const e of [emps.rich, emps.rehired, emps.empty]) {
      const items = all.flatMap((leaveTypeId) => dates.map((asOf) => ({ leaveTypeId, asOf })));
      const batched = await leaveEntitlementBreakdowns(e.ctx, e.employmentId, items, 'en');
      const single = [];
      for (const i of items) single.push(await leaveEntitlementBreakdown(e.ctx, e.employmentId, i.leaveTypeId, i.asOf, 'en'));
      expect(batched).toEqual(single);
      if (e === emps.rich) {
        // Non-vacuity: the comparison crossed every entitlement shape the resolver short-circuits on.
        const statuses = new Set(single.map((x) => x?.entitlementStatus));
        expect(statuses.has('no_eligibility_match'), [...statuses].join()).toBe(true);
        expect(single.some((x) => x?.entitlementTemplateName === 'Hospitalisation table'), 'the sole-table path').toBe(true);
        expect(single.some((x) => x != null && x.balance !== 0)).toBe(true);
      }
    }
  }, 120_000);

  it('leaveTypeApplySummaries = leaveTypeApplySummary for every type, borrower and source included', async () => {
    const all = Object.values(types);
    for (const e of [emps.rich, emps.rehired, emps.empty]) {
      const batched = await leaveTypeApplySummaries(e.ctx, e.employmentId, all);
      for (const leaveTypeId of all) {
        expect(batched.get(leaveTypeId), leaveTypeId).toEqual(await leaveTypeApplySummary(e.ctx, { employmentId: e.employmentId, leaveTypeId }));
      }
      expect(batched.size).toBe(all.length);
    }
    // Non-vacuity: the borrower's pending days reserve ANNUAL's balance, and both report it.
    const rich = await leaveTypeApplySummaries(emps.rich.ctx, emps.rich.employmentId, [types.annual, types.borrower, types.repl]);
    expect(rich.get(types.annual)!.pending).toBeGreaterThan(0.5); // the half day + the two borrower days
    expect(rich.get(types.borrower)!.pending).toBe(rich.get(types.annual)!.pending);
    expect(rich.get(types.annual)!.balance).not.toBe(0);
    expect(rich.get(types.repl)!.expiringSoon).not.toBeNull();
  }, 120_000);
});

describe('r397 · statement budget for one My Leave load', () => {
  it('one load: 271 statements / 46 transactions before r397, 134 / 18 after', async () => {
    const p = await inputs(CASES[0]);
    const before = await captureQueries(() => loadMyLeaveBefore(p));
    const after = await captureQueries(() => loadMyLeave(p));
    const tally = (xs: string[]) => {
      const m = new Map<string, number>();
      for (const s of xs) {
        const k = s.replace(/\s+/g, ' ').slice(0, 160);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return [...m.entries()].sort((a, z) => z[1] - a[1]).map(([k, n]) => `${n}\t${k}`).join('\n');
    };
    if (process.env.R397_PROFILE_OUT) {
      fs.writeFileSync(`${process.env.R397_PROFILE_OUT}/before.txt`, `${before.statements.length}\n${tally(before.statements)}\n`);
      fs.writeFileSync(`${process.env.R397_PROFILE_OUT}/after.txt`, `${after.statements.length}\n${tally(after.statements)}\n`);
    }
    const txCount = (xs: string[]) => xs.filter((x) => x.startsWith("select set_config('app.tenant_id'")).length;
    // PINNED, for the 'rich' employee (10 dashboard cards, Replacement Leave on, one shared group, 4 upcoming rows).
    //
    // BEFORE r397: 271 statements in 46 transactions, all sequential. The dashboard alone opened 2 transactions
    // per card — leaveEntitlementBreakdown (type row + employment row + template resolver + 4 ledger reads) and
    // leaveTypeApplySummary (6 statements) — and the page also ran the whole history card's reads it discarded.
    //
    // AFTER r397: 134 statements in 18 transactions, in four concurrent chains (app/leave/my-leave-data.ts):
    //   catalogue 3 tx (listEmployees, listLeaveTypes, listEligibleLeaveTypesFor) → canApplyLeaveOnBehalf 1;
    //   replacementRequestAvailability 1 → leaveCreditOfferForEmployment 1;
    //   myLeaveDashboard 5 — leaveBalances, the employment/cycle read, offeredLeaveYears, ONE
    //     leaveEntitlementBreakdowns (1 type read + 1 employment read + 1 resolver per distinct asOf + the 4
    //     per-card ledger reads × 10 cards = the 40 statements that remain per card), ONE leaveTypeApplySummaries
    //     (6 statements whatever the card count) → replacementLeaveLedger 1 ∥ listReplacementLeaveRequests 1;
    //   sharedLeaveGroupBalances 2 (groups/members/usage, then leaveBalances);
    //   loadOwnUpcomingLeave 3 (myEmploymentIdsAll, myUpcomingLeave's list + count, the Upcoming rows' trails).
    // A reintroduced per-card transaction or a history read on this page breaks these exact numbers.
    expect(txCount(before.statements)).toBe(46);
    expect(before.statements.length).toBe(271);
    expect(txCount(after.statements), 'transactions').toBe(18);
    expect(after.statements.length, 'statements').toBe(134);
  }, 60_000);
});
