/**
 * r269 · 9e2a89e9 — THE GRADE-CHANGE RECORD.
 *
 * ── WHAT WAS ALREADY TRUE, AND IS NOT REBUILT HERE ───────────────────────────────────────────────────
 * Job grade, employment type and years of service are ALREADY entitlement criteria; a grade change
 * ALREADY re-evaluates the employee, on save and (for a future-dated promotion) on the morning its
 * effective date arrives; and a table that matches nobody ALREADY leaves the employee alone rather than
 * setting them to zero. Five of the reporter's six requested fields were already recorded.
 *
 * WHAT WAS MISSING IS THE RECORD, and that is what this file pins:
 *   §A  the history row NAMES THE GRADES the change moved between;
 *   §B  it carries THE DATE THE CHANGE TOOK EFFECT, not the date somebody typed it in — and the LEDGER
 *       row deliberately keeps the posting date, which is a decision a future round must see, not undo
 *       by accident;
 *   §C  WHEN A NEW GRADE MATCHES NO TABLE, somebody is told: on the employee's own Leave tab, and in one
 *       list an administrator can open. Including everyone with no job grade recorded at all;
 *   §D  the entitlement tables list gains a COVERS column, through the summariser the scheme list already
 *       uses — one derivation, two columns.
 *
 * ── NON-VACUITY ──────────────────────────────────────────────────────────────────────────────────────
 * Drop `changeEffectiveOn: p.changeEffectiveOn ?? null` from the audit insert in
 * `reprojectEntitlementForEmployment` (core/leave.ts) and §B's "the history carries the date the change
 * took effect, and the ledger keeps the posting date" fails on
 * `expect(audit[0].changeEffectiveOn).toBe(TOOK_EFFECT)` — received null.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

import * as schema from '../db/schema';
import { createJobGrade } from '../core/admin';
import { employmentGradeId, hireEmployee, setEmploymentGrade } from '../core/org';
import {
  changeDateWithinCycle,
  listEntitlementRecalcAudit,
  openLeaveYear,
  reprojectEntitlementForEmployment,
  PROFILE_RECALC_REASON_PREFIX,
} from '../core/leave';
import {
  createEligibilityRule,
  createEntitlementTemplate,
  listEmploymentsWithoutEntitlementTable,
  setLeaveTypeDefaultTemplate,
} from '../core/entitlement-template';
import { benefitSchemeView } from '../core/entitlement-scheme-view';
import { isEveryoneCriteria, summariseOrgCriteria } from '../lib/entitlement-criteria-summary';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Dict = Record<string, unknown>;
const getPath = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

const ASOF = '2026-09-11'; // the day the correction is POSTED
const TOOK_EFFECT = '2026-07-01'; // the day the promotion TOOK EFFECT — the reporter's own example

let b: Base;

const uniqEmail = () => `gradechange_${randomUUID().slice(0, 8)}@t.local`;

const hire = (opts: { hiredOn: string; gradeId?: string | null }) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: `Promoted ${randomUUID().slice(0, 4)}`, primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: opts.hiredOn,
    gradeId: opts.gradeId ?? null,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/** The recalc-audit rows for one employment, read as the OWNER so RLS cannot be what makes a test pass. */
const auditRows = (employmentId: string) =>
  owner.db
    .select({
      reason: schema.leaveEntitlementRecalcAudit.reason,
      effectiveOn: schema.leaveEntitlementRecalcAudit.effectiveOn,
      changeEffectiveOn: schema.leaveEntitlementRecalcAudit.changeEffectiveOn,
      previousGradeId: schema.leaveEntitlementRecalcAudit.previousGradeId,
      newGradeId: schema.leaveEntitlementRecalcAudit.newGradeId,
    })
    .from(schema.leaveEntitlementRecalcAudit)
    .where(eq(schema.leaveEntitlementRecalcAudit.employmentId, employmentId));

const recalcLedgerRows = (employmentId: string) =>
  owner.db
    .select({ effectiveOn: schema.leaveLedger.effectiveOn, days: schema.leaveLedger.days })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        like(schema.leaveLedger.reason, `${PROFILE_RECALC_REASON_PREFIX}:%`),
      ),
    );

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

/** Two grades, each with its own entitlement table: a promotion between them moves the number. */
async function twoGrades() {
  const ctx = adminCtx(b);
  const from = await createJobGrade(ctx, { code: 'G16', name: 'GRADE 16 (PERMANENT)' });
  const to = await createJobGrade(ctx, { code: 'G17', name: 'GRADE 17 (PERMANENT)' });
  await seedEntitlement(ctx, {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: 14,
    gradeId: from.id,
    validFrom: '2020-01-01',
    name: 'Grade 16 table',
  });
  await seedEntitlement(ctx, {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: 16,
    gradeId: to.id,
    validFrom: '2020-01-01',
    name: 'Grade 17 table',
  });
  return { from, to };
}

// ── §A · THE GRADES ──────────────────────────────────────────────────────────────────────────────────
describe('§A · the history row names the grades the change moved between', () => {
  it('a promotion records GRADE 16 → GRADE 17 beside the days before and after', async () => {
    const ctx = adminCtx(b);
    const { from, to } = await twoGrades();
    const emp = await hire({ hiredOn: '2026-01-01', gradeId: from.id });

    // READ BEFORE THE WRITE — the same order every caller uses, and the reason the reader exists.
    const before = await employmentGradeId(ctx, emp.employmentId);
    expect(before).toBe(from.id);
    await setEmploymentGrade(ctx, { employmentId: emp.employmentId, gradeId: to.id });

    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'movement_recorded',
      gradeBefore: { gradeId: before },
      changeEffectiveOn: TOOK_EFFECT,
    });
    expect(res.affected).toBe(1);

    const audit = await auditRows(emp.employmentId);
    expect(audit.length).toBe(1);
    expect(audit[0].previousGradeId).toBe(from.id);
    expect(audit[0].newGradeId).toBe(to.id);

    // …and the READER names them, which is what the screen prints.
    const history = await listEntitlementRecalcAudit(ctx, emp.employmentId);
    const row = history.find((h) => h.leaveTypeId === b.annualLeaveTypeId);
    expect(row?.gradeChanged).toBe(true);
    expect(row?.previousGradeName).toBe('GRADE 16 (PERMANENT)');
    expect(row?.newGradeName).toBe('GRADE 17 (PERMANENT)');
    expect(row?.previousEntitlement).toBe(14);
    expect(row?.newEntitlement).toBe(16);
  });

  it('a recalc that is NOT a grade change records no grades — presence is the signal, not nullness', async () => {
    const ctx = adminCtx(b);
    const { from, to } = await twoGrades();
    const emp = await hire({ hiredOn: '2026-01-01', gradeId: from.id });
    await setEmploymentGrade(ctx, { employmentId: emp.employmentId, gradeId: to.id });

    // No `gradeBefore` — the shape a configuration-triggered cohort recalc uses. Writing today's grade
    // into new_grade_id here would read on screen as a promotion that never happened.
    await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'leave_type_rules',
    });
    const audit = await auditRows(emp.employmentId);
    expect(audit.length).toBe(1);
    expect(audit[0].previousGradeId).toBeNull();
    expect(audit[0].newGradeId).toBeNull();
    const history = await listEntitlementRecalcAudit(ctx, emp.employmentId);
    expect(history[0].gradeChanged).toBe(false);
  });

  it('a first grade — from none to GRADE 17 — is a real change and is recorded as one', async () => {
    const ctx = adminCtx(b);
    const { to } = await twoGrades();
    // seedBase's annual type needs a table the ungraded employee resolves to, or nothing is materialized.
    await seedEntitlement(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 8,
      validFrom: '2020-01-01',
      name: 'Everyone table',
    });
    const emp = await hire({ hiredOn: '2026-01-01' });
    await setEmploymentGrade(ctx, { employmentId: emp.employmentId, gradeId: to.id });

    await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'movement_recorded',
      gradeBefore: { gradeId: null },
      changeEffectiveOn: TOOK_EFFECT,
    });
    const history = await listEntitlementRecalcAudit(ctx, emp.employmentId);
    const row = history.find((h) => h.leaveTypeId === b.annualLeaveTypeId);
    expect(row?.gradeChanged).toBe(true);
    expect(row?.previousGradeName).toBeNull();
    expect(row?.newGradeName).toBe('GRADE 17 (PERMANENT)');
  });
});

// ── §B · THE DATE ────────────────────────────────────────────────────────────────────────────────────
describe('§B · the history carries the date the change took effect; the ledger keeps the posting date', () => {
  it('a promotion effective 1 July recorded in September reads 1 July on the history and 11 September on the ledger', async () => {
    const ctx = adminCtx(b);
    const { from, to } = await twoGrades();
    const emp = await hire({ hiredOn: '2026-01-01', gradeId: from.id });
    const before = await employmentGradeId(ctx, emp.employmentId);
    await setEmploymentGrade(ctx, { employmentId: emp.employmentId, gradeId: to.id });

    await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'movement_recorded',
      gradeBefore: { gradeId: before },
      changeEffectiveOn: TOOK_EFFECT,
    });

    const audit = await auditRows(emp.employmentId);
    expect(audit[0].changeEffectiveOn).toBe(TOOK_EFFECT);
    // `effective_on` keeps the meaning it has on every row ever written: when the correction was POSTED.
    expect(audit[0].effectiveOn).toBe(ASOF);
    // …and the screen prints the first, falling back to the second.
    const history = await listEntitlementRecalcAudit(ctx, emp.employmentId);
    expect(history.find((h) => h.leaveTypeId === b.annualLeaveTypeId)?.tookEffectOn).toBe(TOOK_EFFECT);

    /**
     * ⚠️ THE LEDGER ROW IS DELIBERATELY NOT RE-DATED, and this assertion is the record of that decision.
     *
     * Dating a money row from a backdated effective date interacts with the cycle window guard, with
     * ADR-0069 encashment freezes and with a change crossing a closed leave year. The approved plan
     * promises the HISTORY row's date and nothing more. A future round that moves it must come here,
     * read this, and decide on purpose — rather than discovering it from a red test with no explanation.
     */
    const ledger = await recalcLedgerRows(emp.employmentId);
    expect(ledger.length).toBe(1);
    expect(ledger[0].effectiveOn).toBe(ASOF);
  });

  /**
   * ⚠️ THE CASE THE FIRST CUT GOT WRONG, and it is the one that would have misled somebody about money.
   *
   * A promotion effective 15 Dec 2025 recorded on 11 Sep 2026: the recalc re-projects the CURRENT cycle
   * (2026) and posts +2.00 into it — 2025 is closed and is never rewritten. Writing the effective date
   * unclamped put "Took effect 15 Dec 2025" beside figures that are 2026's, which reads as though the
   * +2 had landed in 2025. It had not.
   *
   * Dropped rather than clamped to the window start: 1 January 2026 is a date the change did not take
   * effect on, and a wrong value asserts something false where an absent one asserts nothing. With null
   * the screen falls back to the posting date and reads what actually happened.
   */
  it('a change dated in a CLOSED leave year quotes no date — the figures belong to the current cycle', async () => {
    const ctx = adminCtx(b);
    const { from, to } = await twoGrades();
    // Hired in 2024 so 2025 is a real, CLOSED leave year for them, and 2026 opened so the current cycle
    // is materialized — the recalc kernel only ever corrects a cycle something has already granted into.
    const emp = await hire({ hiredOn: '2024-01-01', gradeId: from.id });
    await openLeaveYear(ctx, { year: 2026, employmentIds: [emp.employmentId] });
    const before = await employmentGradeId(ctx, emp.employmentId);
    await setEmploymentGrade(ctx, { employmentId: emp.employmentId, gradeId: to.id });

    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF, // 2026-09-11
      trigger: 'movement_recorded',
      gradeBefore: { gradeId: before },
      changeEffectiveOn: '2025-12-15', // LAST leave year
    });
    expect(res.affected).toBe(1);

    const audit = await auditRows(emp.employmentId);
    expect(audit.length).toBe(1);
    // The grades ARE still recorded — they describe the change, not a cycle.
    expect(audit[0].previousGradeId).toBe(from.id);
    expect(audit[0].newGradeId).toBe(to.id);
    // The DATE is not, because these figures are 2026's.
    expect(audit[0].changeEffectiveOn).toBeNull();
    expect(audit[0].effectiveOn).toBe(ASOF);
    const history = await listEntitlementRecalcAudit(ctx, emp.employmentId);
    expect(history[0].tookEffectOn).toBe(ASOF);
  });

  it('the window rule is pure and has one definition, boundaries included', () => {
    // Inclusive at both ends — the same closed interval the already-posted days are summed over.
    expect(changeDateWithinCycle('2026-07-01', '2026-01-01', '2026-12-31')).toBe('2026-07-01');
    expect(changeDateWithinCycle('2026-01-01', '2026-01-01', '2026-12-31')).toBe('2026-01-01');
    expect(changeDateWithinCycle('2026-12-31', '2026-01-01', '2026-12-31')).toBe('2026-12-31');
    // Outside on either side ⇒ nothing quoted, never clamped to a boundary.
    expect(changeDateWithinCycle('2025-12-31', '2026-01-01', '2026-12-31')).toBeNull();
    expect(changeDateWithinCycle('2027-01-01', '2026-01-01', '2026-12-31')).toBeNull();
    expect(changeDateWithinCycle(null, '2026-01-01', '2026-12-31')).toBeNull();
    expect(changeDateWithinCycle(undefined, '2026-01-01', '2026-12-31')).toBeNull();
  });

  it('a caller with no effective date to give leaves it null, and the screen falls back to the posting date', async () => {
    const ctx = adminCtx(b);
    const { from, to } = await twoGrades();
    const emp = await hire({ hiredOn: '2026-01-01', gradeId: from.id });
    const before = await employmentGradeId(ctx, emp.employmentId);
    await setEmploymentGrade(ctx, { employmentId: emp.employmentId, gradeId: to.id });

    // The rollback path: a reversal takes effect now and has no date of its own to quote.
    await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'movement_recorded',
      gradeBefore: { gradeId: before },
    });
    const audit = await auditRows(emp.employmentId);
    expect(audit[0].changeEffectiveOn).toBeNull();
    const history = await listEntitlementRecalcAudit(ctx, emp.employmentId);
    expect(history[0].tookEffectOn).toBe(ASOF);
  });

  it('the callers pass both — the contract lives across two files, so it is pinned across both', () => {
    const actions = read('app/admin/personnel/[employmentId]/actions.ts');
    // Read BEFORE the write, or the "previous" grade is the new one.
    const create = actions.slice(actions.indexOf('export async function createMovementEventAction'));
    const head = create.slice(0, create.indexOf('await createMovementEvent('));
    expect(head).toContain('await employmentGradeId(s, employmentId)');
    expect(create).toContain('changeEffectiveOn: p.effectiveDate ?? null');
    expect(create).toContain('gradeBefore,');

    // The sweep: the movement's own effective date, never the morning the cron ran.
    const sweep = read('core/movement-apply.ts');
    expect(sweep).toContain('await employmentGradeId(ctx, c.employmentId)');
    expect(sweep).toContain('changeEffectiveOn: r.appliedEffectiveDate');
    expect(sweep).not.toContain('changeEffectiveOn: today');

    // And `asOf` is NOT moved anywhere: that would change the arithmetic, which is money.
    const leave = read('core/leave.ts');
    expect(leave).toContain('const asOf = p.asOf ?? todayInKualaLumpur();');
    expect(leave).not.toContain('const asOf = p.changeEffectiveOn');
  });
});

// ── §C · THE WARNING ─────────────────────────────────────────────────────────────────────────────────
describe('§C · when a new grade matches no entitlement table, somebody is told', () => {
  it('the employee’s Leave tab names the leave types nothing reaches them on', async () => {
    const ctx = adminCtx(b);
    const { from } = await twoGrades();
    const unreachable = await createJobGrade(ctx, { code: 'G99', name: 'GRADE 99 (PERMANENT)' });
    const emp = await hire({ hiredOn: '2026-01-01', gradeId: from.id });

    // Promoted into a grade no table covers: the engine leaves them alone — correctly, and silently.
    await setEmploymentGrade(ctx, { employmentId: emp.employmentId, gradeId: unreachable.id });

    const view = await benefitSchemeView(ctx, emp.employmentId, ASOF);
    expect(view.perType).toEqual([]);
    expect(view.unmatched.map((u) => u.leaveTypeId)).toContain(b.annualLeaveTypeId);
    expect(view.noJobGrade).toBe(false);
  });

  it('an employee with NO job grade at all is flagged as that, which no configuration change can fix', async () => {
    const ctx = adminCtx(b);
    await twoGrades();
    const emp = await hire({ hiredOn: '2026-01-01' }); // ungraded — 47 of 74 on production
    const view = await benefitSchemeView(ctx, emp.employmentId, ASOF);
    expect(view.noJobGrade).toBe(true);
    expect(view.unmatched.map((u) => u.leaveTypeId)).toContain(b.annualLeaveTypeId);
  });

  it('THE DEFAULT TABLE SUPPRESSES THE WARNING — and its absence is what makes the warning fire', async () => {
    const ctx = adminCtx(b);
    const { from } = await twoGrades();
    const fallback = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Company standard',
      serviceBands: [{ fromYears: 0, toYears: null, days: 10 }],
      validFrom: '2020-01-01',
    });
    const unreachable = await createJobGrade(ctx, { code: 'G99', name: 'GRADE 99 (PERMANENT)' });
    const emp = await hire({ hiredOn: '2026-01-01', gradeId: from.id });
    await setEmploymentGrade(ctx, { employmentId: emp.employmentId, gradeId: unreachable.id });

    expect((await benefitSchemeView(ctx, emp.employmentId, ASOF)).unmatched.length).toBeGreaterThan(0);

    // 76ffdcf2's default now reaches them, so the two items agree instead of contradicting each other:
    // nothing is invented, and nobody is silently left with nothing.
    await setLeaveTypeDefaultTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      templateLineageId: fallback.lineageId,
    });
    const after = await benefitSchemeView(ctx, emp.employmentId, ASOF);
    expect(after.unmatched).toEqual([]);
    expect(after.coveredByDefaultOnly).toBe(true);
  });

  it('the administrator’s list names every unreached employee, and counts the ungraded among them', async () => {
    const ctx = adminCtx(b);
    const { from } = await twoGrades();
    const covered = await hire({ hiredOn: '2026-01-01', gradeId: from.id });
    const ungraded = await hire({ hiredOn: '2026-01-01' });

    const out = await listEmploymentsWithoutEntitlementTable(ctx, { asOf: ASOF });
    const ids = out.rows.map((r) => r.employmentId);
    expect(ids).toContain(ungraded.employmentId);
    expect(ids).not.toContain(covered.employmentId);
    expect(out.withoutJobGrade).toBeGreaterThanOrEqual(1);
    const row = out.rows.find((r) => r.employmentId === ungraded.employmentId);
    expect(row?.gradeId).toBeNull();
    expect(row?.gradeName).toBeNull();
    // Named leave types, not a count — the administrator's next action is per type.
    expect(row?.leaveTypeNames.length).toBeGreaterThan(0);

    // A leave type with NO table at all is excluded: nobody was ever meant to get days there.
    const [bare] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: `BARE_${randomUUID().slice(0, 5).toUpperCase()}`, name: 'Unconfigured Leave', paid: true })
      .returning({ id: schema.leaveType.id });
    const again = await listEmploymentsWithoutEntitlementTable(ctx, { asOf: ASOF });
    for (const r of again.rows) expect(r.leaveTypeNames).not.toContain('Unconfigured Leave');
    expect(bare).toBeTruthy();
  });

  it('the list is capped AFTER counting, so the screen can say how many it is not showing', async () => {
    const ctx = adminCtx(b);
    await twoGrades();
    for (let i = 0; i < 3; i += 1) await hire({ hiredOn: '2026-01-01' });
    const out = await listEmploymentsWithoutEntitlementTable(ctx, { asOf: ASOF, limit: 2 });
    expect(out.rows.length).toBe(2);
    expect(out.total).toBeGreaterThanOrEqual(3);
  });

  /**
   * bb2b2e86 (r338) — THE DEFAULT CAP IS FIFTY, and the card is now the only thing that reads it.
   *
   * The test above passes an explicit `limit: 2`, so until now nothing anywhere pinned the DEFAULT:
   * `p.limit ?? 50` could have been raised to 500 and the whole suite would still have been green.
   * Collapsing the card behind a toggle made that worth closing — an opened section that dumps every
   * unreached employee is the defect the collapse exists to avoid, one click later.
   *
   * The employments are inserted directly rather than hired through the service: what is under test is
   * the `slice(0, limit)`, and fifty-one entitlement projections would be fifty-one seconds spent
   * proving something none of them touch.
   */
  it('FIFTY is the default, and the screen asks for no limit — so fifty is what bounds the page', async () => {
    const ctx = adminCtx(b);
    await twoGrades();
    const people = await owner.db
      .insert(schema.person)
      .values(
        Array.from({ length: 51 }, (_, i) => ({
          tenantId: b.tenantId,
          fullName: `Capped ${String(i).padStart(3, '0')}`,
          primaryEmail: `capped_${i}_${randomUUID().slice(0, 8)}@t.local`,
        })),
      )
      .returning({ id: schema.person.id });
    await owner.db.insert(schema.employment).values(
      people.map((pr) => ({
        tenantId: b.tenantId,
        personId: pr.id,
        companyId: b.companyId,
        hiredOn: '2026-01-01',
      })),
    );

    const out = await listEmploymentsWithoutEntitlementTable(ctx, { asOf: ASOF });
    expect(out.total).toBeGreaterThanOrEqual(51);
    // Mutate `const limit = p.limit ?? 50` in core/entitlement-template.ts and THIS is the line that reddens.
    expect(out.rows.length).toBe(50);
    // …and "Showing 50 of 70." renders only because the cap bit, which is the other half of the contract.
    expect(out.total).toBeGreaterThan(out.rows.length);
    // The card passes no limit at all — pinned in the rendering test, quoted here so the two stay a pair.
    const card = read('app/admin/leave/entitlements/templates/uncovered-employees.tsx');
    expect(card).toContain('listEmploymentsWithoutEntitlementTable(s, { asOf })');
  });
});

// ── §D · THE COVERS COLUMN ───────────────────────────────────────────────────────────────────────────
describe('§D · one criteria summariser, two Covers columns', () => {
  const SECTIONS = [
    {
      fields: [
        {
          name: 'gradeIds',
          label: 'Job Grade',
          options: [
            { value: 'g16', label: 'GRADE 16 (PERMANENT)' },
            { value: 'g17', label: 'GRADE 17 (PERMANENT)' },
          ],
        },
        { name: 'employmentTypes', label: 'Employment Type', options: [{ value: 'full_time', label: 'Full time' }] },
        { name: 'minYearsOfService', label: 'Minimum years of service' },
      ],
    },
  ];

  it('names the axis and the values through the picker’s own labels', () => {
    const out = summariseOrgCriteria({ gradeIds: ['g16', 'g17'], employmentTypes: ['full_time'] }, SECTIONS);
    expect(out.map((a) => a.label)).toEqual(['Job Grade', 'Employment Type']);
    expect(out[0].values).toEqual(['GRADE 16 (PERMANENT)', 'GRADE 17 (PERMANENT)']);
    expect(out[1].values).toEqual(['Full time']);
  });

  it('NEVER prints a stored id: a value whose catalogue row is gone is counted, not rendered', () => {
    const out = summariseOrgCriteria({ gradeIds: ['g16', '7f6e5d4c-0000-0000-0000-000000000000'] }, SECTIONS);
    expect(out[0].values).toEqual(['GRADE 16 (PERMANENT)']);
    expect(out[0].unresolved).toBe(1);
  });

  it('an axis that narrows nothing is not an axis, and an EMPTY criteria object means EVERYONE', () => {
    expect(summariseOrgCriteria({ gradeIds: [], employmentTypes: null, minYearsOfService: '' }, SECTIONS)).toEqual([]);
    expect(isEveryoneCriteria({})).toBe(true);
    expect(isEveryoneCriteria({ gradeIds: [] })).toBe(true);
    expect(isEveryoneCriteria({ gradeIds: ['g16'] })).toBe(false);
    // A scalar axis carries its value, not a list.
    expect(summariseOrgCriteria({ minYearsOfService: 5 }, SECTIONS)[0].scalar).toBe('5');
  });

  it('the tables list renders the column, and BOTH columns go through the one summariser', () => {
    const block = read('app/admin/leave/entitlements/templates/entitlement-tables-block.tsx');
    // r271 (6d29e11c) — the grid and the tables list MERGED, so the Covers column and the grid's Job
    // grade column became one column. `colCovers` is retired with the header it named; `gridColGrade` is
    // the header that survives, and it is the same fact under the name the reporter drew.
    expect(block).toContain("t('gridColGrade')");
    expect(block).toContain("t('coversDefaultTable')");
    // ONE renderer, and every surface that shows a criteria object goes through it. r270 added a third
    // surface (the flat grid) and a thin alias `coversOfScheme` naming the question the tables list and
    // the grid share, so a bare `coversCell(` count stopped measuring what this line claims: it read 2
    // while three surfaces rendered a criteria object. Count the CALLS, through either name, so the
    // number on the right is the number of places a scheme's criteria reach a screen from this file.
    const renderings =
      (block.match(/coversCell\(/g) ?? []).length + (block.match(/coversOfScheme\(/g) ?? []).length;
    // -1: the alias's own body calls coversCell, and a definition is not a surface.
    // r271: THREE became TWO when the two tables became one — the merged table's Job grade cell and the
    // schemes list's own Covers column. The count going DOWN as surfaces merge is the number doing its
    // job; it is updated deliberately here rather than loosened to "at least one".
    expect(renderings - 1).toBe(2);
    // And there is still exactly ONE implementation behind all three.
    expect((block.match(/const coversCell = /g) ?? []).length).toBe(1);
    expect(block).not.toMatch(/Object\.entries\(x\.criteria as Record<string, unknown>\)/);
  });

  it('the employee’s warning and the administrator’s list are both wired to the screens', () => {
    const profile = read('app/admin/personnel/[employmentId]/page.tsx');
    expect(profile).toContain("tScheme('unmatchedWarning'");
    expect(profile).toContain("tScheme('unmatchedNoGrade')");
    expect(profile).toContain("t('recalcColGrade')");
    expect(profile).toContain('{r.tookEffectOn}');
    // Rendered in BOTH states of the card: the one that matters most is "some types resolved, some did not".
    expect((profile.match(/\{schemeUnmatchedNotice\}/g) ?? []).length).toBe(2);

    const page = read('app/admin/leave-config/entitlement-tables/page.tsx');
    expect(page).toContain('<UncoveredEmployeesCard s={s} asOf={data.today} />');
    // NEVER inside the block: the Entitlements screen composes that block once per leave type.
    const block = read('app/admin/leave/entitlements/templates/entitlement-tables-block.tsx');
    expect(block).not.toContain('UncoveredEmployeesCard');
  });

  it('every key this item minted exists in all six catalogues and is translated', () => {
    const KEYS = [
      // r271 — `colCovers` retired: the Covers column and the grid's Job grade column merged into one,
      // and `gridColGrade` (asserted above) is the header that survives.
      'admin.entitlementTemplates.coversMore',
      'admin.entitlementTemplates.coversDefaultTable',
      'admin.entitlementTemplates.uncoveredTitle',
      'admin.entitlementTemplates.uncoveredHelp',
      'admin.entitlementTemplates.uncoveredNone',
      'admin.entitlementTemplates.uncoveredNoGrade',
      'admin.entitlementTemplates.uncoveredNoGradeCell',
      'admin.entitlementTemplates.uncoveredColEmployee',
      'admin.entitlementTemplates.uncoveredColGrade',
      'admin.entitlementTemplates.uncoveredColTypes',
      'admin.entitlementTemplates.uncoveredMore',
      'admin.personnel.benefitScheme.unmatchedWarning',
      'admin.personnel.benefitScheme.unmatchedNoGrade',
      'people.detail.recalcColGrade',
      'people.detail.recalcGradeUnchanged',
      'people.detail.recalcColEffective',
      'people.detail.recalcHistoryHelp',
    ];
    for (const key of KEYS) {
      const enValue = getPath(en, key);
      expect(typeof enValue, key).toBe('string');
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        const v = getPath(cat, key);
        expect(typeof v, `${loc} ${key}`).toBe('string');
        expect((v as string).length, `${loc} ${key}`).toBeGreaterThan(0);
        if (loc !== 'en') expect(v, `${loc} ${key} untranslated`).not.toBe(enValue);
      }
    }
    // The column heading says what it now means, and the help says which of the two dates it is.
    expect(en.people.detail.recalcColEffective).toBe('Took effect');
    expect(en.people.detail.recalcHistoryHelp).toContain('not the date it was recorded');
    // …and it discloses the one case where the column shows the posting date instead, rather than
    // leaving a reader to assume a correction landed in a leave year it never touched.
    expect(en.people.detail.recalcHistoryHelp).toContain('earlier leave year');
  });

  it('the plan DECLINES the mid-year split, and nothing here builds one', () => {
    // "the employee's previous entitlement shall be retained for the period before the change" was
    // declined in writing: a promotion re-projects the whole current cycle at the new grade under the
    // existing proration, and the audit trail — which is what the reporter's stated purpose asked for —
    // is what this item completes. A future round must reverse that decision deliberately, not by
    // finding a helpful-looking hook.
    const leave = read('core/leave.ts');
    expect(leave).not.toMatch(/splitCycleAtGradeChange|midCycleReband|prorateAcrossGradeChange/);
  });
});

// ── the eligibility rule fixture used by §D's screen assertions ──────────────────────────────────────
describe('§D2 · the summariser over a real stored rule', () => {
  it('reads a rule written by the real writer, with the grades it was built from', async () => {
    const ctx = adminCtx(b);
    const grade = await createJobGrade(ctx, { code: 'G16', name: 'GRADE 16 (PERMANENT)' });
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Grade Permanent 16 - 19',
      serviceBands: [{ fromYears: 0, toYears: null, days: 20 }],
      validFrom: '2020-01-01',
    });
    const rule = await createEligibilityRule(ctx, {
      name: 'Permanent 16 - 19',
      templateLineageId: tpl.lineageId,
      criteria: { gradeIds: [grade.id], employmentTypes: ['full_time'] },
      validFrom: '2020-01-01',
    });
    const sections = [
      {
        fields: [
          { name: 'gradeIds', label: 'Job Grade', options: [{ value: grade.id, label: 'GRADE 16 (PERMANENT)' }] },
          { name: 'employmentTypes', label: 'Employment Type', options: [{ value: 'full_time', label: 'Full time' }] },
        ],
      },
    ];
    const summary = summariseOrgCriteria(rule.criteria as Record<string, unknown>, sections);
    expect(summary.map((a) => `${a.label}: ${a.values.join(', ')}`)).toEqual([
      'Job Grade: GRADE 16 (PERMANENT)',
      'Employment Type: Full time',
    ]);
  });
});
