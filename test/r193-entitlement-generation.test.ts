/**
 * r193 / a9d0a94a — GENERATE ENTITLEMENT GRANTED NOBODY ANYTHING, AND THE REASON WAS A DATE.
 *
 * The reporter ran Generate Entitlement and nothing happened. Two successive diagnoses said an eligibility
 * rule was missing; both were wrong, and this file exists so no third one is needed. What actually happened
 * is that `openLeaveYear` asked every question AT 1 JANUARY:
 *
 *   FAULT 1  "which entitlement tables were in force on 1 January?" — none, because HR built them all in
 *            August. The leave-type list filtered to EMPTY and the run granted nothing for EVERY type,
 *            never reaching eligibility at all. This is why the earlier advice could not have worked.
 *   FAULT 2  "who was employed on 1 January?" — 22 of 40, because 18 joined during the year. Those 18 were
 *            skipped before any entitlement question was asked.
 *   FAULT 3  a leave type with exactly ONE table still refused to apply it without a rule choosing between
 *            the one option there was.
 *
 * ── WHAT THIS FILE IS REALLY GUARDING ────────────────────────────────────────────────────────────────
 * Not the three fixes. THE IDEMPOTENCY GUARD. Until r193 a year-open grant was always dated 1 January, and
 * both engines that ask "has this year already been opened?" keyed on `effective_on = <year>-01-01`. The
 * fixes above move that date to the table's start or the employee's join date — at which point a marker
 * still looking for a 1-January row DOES NOT MATCH THE ROW THE PREVIOUS RUN WROTE, and pressing Generate
 * Entitlement twice grants the same year twice with no error and nothing on screen to say which figure is
 * right. Entitlement handed out twice is not something this system can take back.
 *
 * So the double-run cases below are the deliverable, and they are deliberately run over the ugliest
 * fixture available: a table that starts in August, a joiner from March, a joiner whose hire grant already
 * ran, and a plain full-year employee — four different grant dates in one ledger. They assert the ledger is
 * BYTE-IDENTICAL after the second pass, not merely that the totals agree.
 *
 * Everything else here is the scaffolding that makes those cases mean something: if the first run granted
 * nothing, "unchanged after the second run" is trivially true and guards nothing at all. Each fault case
 * therefore proves days actually moved, and on which date.
 *
 * ── WHY THE CUSTOM LEAVE TYPES ────────────────────────────────────────────────────────────────────────
 * ANNUAL / SICK / HOSPITALIZATION are STANDING_LEAVE_CODES: the sweep visits them whatever the template
 * layer says, and the country pack supplies a statutory floor. Both would mask the behaviour under test.
 * A custom code resolves a floor of 0, so its ONLY source of days is the entitlement table — which is
 * exactly the tenant state the reporter is in. ANNUAL appears only where the point IS the pro-ration.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { effectiveGrantStart, hireYearGrantDays, openLeaveYear } from '../core/leave';
import { createEligibilityRule, createEntitlementTemplate } from '../core/entitlement-template';
import { previewLeaveGeneration, runLeaveGeneration } from '../core/leave-generation';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

/** A leave type whose code is NOT a standing code, so the statutory floor is 0 and the table decides. */
async function customLeaveType(code: string, name: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name, paid: true })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const hire = (hiredOn: string, grantLeaveTypes: { id: string; code: string }[] = [], deptId?: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'R193', primaryEmail: `r193_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: deptId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes,
  });

/** A named entitlement table for a type, with an optional "everyone" rule. */
async function table(p: {
  leaveTypeId: string;
  days: number;
  validFrom: string;
  name?: string;
  withRule?: boolean;
  criteria?: Record<string, unknown>;
}) {
  const tpl = await createEntitlementTemplate(adminCtx(b), {
    leaveTypeId: p.leaveTypeId,
    name: p.name ?? `Table ${randomUUID().slice(0, 6)}`,
    serviceBands: [{ fromYears: 0, toYears: null, days: p.days }],
    validFrom: p.validFrom,
  });
  if (p.withRule) {
    await createEligibilityRule(adminCtx(b), {
      name: `${tpl.name} — eligibility`,
      templateLineageId: tpl.lineageId,
      criteria: (p.criteria ?? {}) as never,
      validFrom: p.validFrom,
    });
  }
  return tpl;
}

async function rowsFor(employmentId: string, leaveTypeId: string) {
  return owner.db
    .select({
      entryType: schema.leaveLedger.entryType,
      days: schema.leaveLedger.days,
      effectiveOn: schema.leaveLedger.effectiveOn,
    })
    .from(schema.leaveLedger)
    .where(
      and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, leaveTypeId)),
    )
    .orderBy(schema.leaveLedger.effectiveOn);
}

/**
 * EVERY ledger row in the tenant, serialised. The double-run cases compare this string, not a balance:
 * a balance would still agree if a run posted +12 and −12, and it would agree if a row's DATE moved. The
 * ledger is append-only, so a stable ordering by primary key makes string equality the strongest available
 * statement of "the second pass changed nothing".
 */
async function ledgerFingerprint(): Promise<string> {
  const rows = await owner.db.select().from(schema.leaveLedger);
  const sorted = rows
    .map((r) => JSON.stringify(r))
    .sort();
  return `${rows.length}\n${sorted.join('\n')}`;
}

// ── FAULT 1 — the table's own start date, not 1 January ──────────────────────────────────────────────
describe('r193 fault 1 — a table written part-way through the year is in force for that year', () => {
  it('a table valid from 1 August grants the 2026 year, dated 1 August', async () => {
    const study = await customLeaveType('STUDY', 'Study Leave');
    const emp = await hire('2020-01-01');
    // The reporter's exact state: every table dated the day HR built it, months after the year opened.
    await table({ leaveTypeId: study, days: 12, validFrom: '2026-08-01', withRule: true });

    const res = await openLeaveYear(adminCtx(b), { year: 2026 });

    // Before r193 this was 0 for every leave type and every employee — the type list filtered to empty.
    expect(await ledgerBalance(emp.employmentId, study)).toBe(12);
    const rows = await rowsFor(emp.employmentId, study);
    expect(rows).toHaveLength(1);
    // ⚠️ NOT 2026-01-01. The table did not exist then, and back-dating it would silently claim it had been
    // in force all year — which is the one thing the plan's design notes forbid.
    expect(rows[0].effectiveOn).toBe('2026-08-01');
    expect(res.rows.find((r) => r.leaveTypeId === study)!.outcome).toBe('granted');
  });

  it('a table already in force on 1 January still grants from 1 January — nothing moves for anyone else', async () => {
    const study = await customLeaveType('STUDY', 'Study Leave');
    const emp = await hire('2020-01-01');
    await table({ leaveTypeId: study, days: 12, validFrom: '2020-01-01', withRule: true });

    await openLeaveYear(adminCtx(b), { year: 2026 });

    const rows = await rowsFor(emp.employmentId, study);
    expect(rows.map((r) => r.effectiveOn)).toEqual(['2026-01-01']);
  });

  it('a table CLOSED before the year opened grants nothing — the window is half-open, not "ever existed"', async () => {
    const study = await customLeaveType('STUDY', 'Study Leave');
    const emp = await hire('2020-01-01');
    const tpl = await table({ leaveTypeId: study, days: 12, validFrom: '2020-01-01', withRule: true });
    // Close the only version at 2026-01-01: in force through 2025, gone on the first day of 2026.
    await owner.db
      .update(schema.entitlementTemplate)
      .set({ validTo: '2026-01-01' })
      .where(eq(schema.entitlementTemplate.lineageId, tpl.lineageId));

    await openLeaveYear(adminCtx(b), { year: 2026 });

    expect(await ledgerBalance(emp.employmentId, study)).toBe(0);
  });
});

// ── FAULT 2 — the people who joined during the year ──────────────────────────────────────────────────
describe('r193 fault 2 — an employee who joined during the leave year is in it', () => {
  it('a March joiner is granted from their join date, not skipped', async () => {
    const study = await customLeaveType('STUDY', 'Study Leave');
    await table({ leaveTypeId: study, days: 12, validFrom: '2020-01-01', withRule: true });
    // No hire grant for STUDY — this employment is reached by the year-open or by nothing.
    const joiner = await hire('2026-03-01');

    await openLeaveYear(adminCtx(b), { year: 2026 });

    // s.60F practice, shared with the hire grant: a non-ANNUAL type is granted in full, never day-sliced.
    expect(await ledgerBalance(joiner.employmentId, study)).toBe(12);
    expect((await rowsFor(joiner.employmentId, study))[0].effectiveOn).toBe('2026-03-01');
  });

  it('an ANNUAL joiner gets EXACTLY what the hire grant would have given them', async () => {
    // ⚠️ THE ONE-COMPOSITION CASE. If the year-open handed a joiner a full twelve months while the hire
    // grant and the recalc kernel both say nine, the next profile save would post a compensating
    // adjustment clawing the difference back and the employee would watch their balance drop. The two
    // engines share `hireYearGrantDays` precisely so this comparison can be made at all.
    await table({ leaveTypeId: b.annualLeaveTypeId, days: 12, validFrom: '2020-01-01', withRule: true });
    const viaHireGrant = await hire('2026-04-01', [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }]);
    const viaYearOpen = await hire('2026-04-01');

    const atHire = await ledgerBalance(viaHireGrant.employmentId, b.annualLeaveTypeId);
    expect(atHire).toBeGreaterThan(0);

    await openLeaveYear(adminCtx(b), { year: 2026 });

    expect(await ledgerBalance(viaYearOpen.employmentId, b.annualLeaveTypeId)).toBe(atHire);
    // …and the one who was already granted at hire is NOT granted a second time.
    expect(await ledgerBalance(viaHireGrant.employmentId, b.annualLeaveTypeId)).toBe(atHire);
  });

  it('somebody hired AFTER the leave year ends is still not in it', async () => {
    const study = await customLeaveType('STUDY', 'Study Leave');
    await table({ leaveTypeId: study, days: 12, validFrom: '2020-01-01', withRule: true });
    const future = await hire('2027-02-01');

    await openLeaveYear(adminCtx(b), { year: 2026 });

    expect(await ledgerBalance(future.employmentId, study)).toBe(0);
  });
});

// ── FAULT 3 — one table, nothing to choose between ───────────────────────────────────────────────────
describe('r193 fault 3 — a leave type with exactly one table needs no rule', () => {
  it('one table and no rule in force: the table is applied', async () => {
    // Hospitalization Leave on the reporting account, exactly: one table, zero rules, no days.
    const hosp = await customLeaveType('HOSP_X', 'Hospitalization (custom)');
    await table({ leaveTypeId: hosp, days: 16, validFrom: '2020-01-01' });
    const emp = await hire('2020-01-01');

    await openLeaveYear(adminCtx(b), { year: 2026 });

    expect(await ledgerBalance(emp.employmentId, hosp)).toBe(16);
  });

  it('TWO tables and no rule: nothing is granted — picking one would be a silent mis-grant', async () => {
    // Annual Leave has SIXTEEN tables in force on the reporting account. "Use the first" would hand most of
    // the company the wrong figure and look like it worked. Answering that needs item 9a65f808, not a guess.
    const exam = await customLeaveType('EXAM_X', 'Examination Leave');
    await table({ leaveTypeId: exam, days: 10, validFrom: '2020-01-01', name: 'Executives' });
    await table({ leaveTypeId: exam, days: 4, validFrom: '2020-01-01', name: 'Contract' });
    const emp = await hire('2020-01-01');

    const res = await openLeaveYear(adminCtx(b), { year: 2026 });

    expect(await ledgerBalance(emp.employmentId, exam)).toBe(0);
    expect(res.rows.find((r) => r.leaveTypeId === exam)!.outcome).toBe('no_entitlement');
  });

  it('a rule that NARROWS the only table is never reversed by this fallback', async () => {
    // The safety condition, and the reason the gate is two conditions rather than one. A tenant with one
    // table AND a rule limiting it to Operations has deliberately excluded Finance; "there is only one
    // table so give it to everyone" would quietly undo that.
    const study = await customLeaveType('STUDY', 'Study Leave');
    await table({
      leaveTypeId: study,
      days: 12,
      validFrom: '2020-01-01',
      withRule: true,
      criteria: { departmentIds: [b.deptB] },
    });
    const included = await hire('2020-01-01', [], b.deptB);
    const excluded = await hire('2020-01-01', [], b.deptA);

    await openLeaveYear(adminCtx(b), { year: 2026 });

    expect(await ledgerBalance(included.employmentId, study)).toBe(12);
    expect(await ledgerBalance(excluded.employmentId, study)).toBe(0);
  });
});

// ── THE DELIVERABLE — a second run must change NOTHING ───────────────────────────────────────────────
describe('r193 — the idempotency guard, on grants that are NOT dated 1 January', () => {
  /**
   * Four different grant dates in one ledger, which is the whole point: under the old
   * `effective_on = <year>-01-01` key, three of these four rows were invisible to the second run.
   */
  async function nastyFixture() {
    const study = await customLeaveType('STUDY', 'Study Leave');
    await table({ leaveTypeId: b.annualLeaveTypeId, days: 12, validFrom: '2020-01-01', withRule: true });
    // Fault 1's shape: this table only starts in August, so its grants are dated 2026-08-01.
    await table({ leaveTypeId: study, days: 12, validFrom: '2026-08-01', withRule: true });
    return {
      study,
      // Grants at 2026-01-01 (ANNUAL) and 2026-08-01 (STUDY).
      veteran: (await hire('2019-06-01')).employmentId,
      // Fault 2's shape: grants at 2026-03-01 (ANNUAL, pro-rated) and 2026-08-01 (STUDY).
      joiner: (await hire('2026-03-01')).employmentId,
      // Already granted at hire — the hire grant IS this employee's year-open marker for 2026.
      alreadyGranted: (await hire('2026-05-01', [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }])).employmentId,
    };
  }

  it('openLeaveYear twice: the ledger is byte-identical after the second pass', async () => {
    const f = await nastyFixture();

    const first = await openLeaveYear(adminCtx(b), { year: 2026 });
    const after = await ledgerFingerprint();
    // A vacuous version of this test would pass with an empty ledger. Prove days actually moved, and that
    // they moved onto more than one date — otherwise it is not exercising the re-keyed guard at all.
    expect(first.granted).toBeGreaterThan(0);
    const dates = new Set((await owner.db.select().from(schema.leaveLedger)).map((r) => r.effectiveOn));
    expect(dates.size).toBeGreaterThan(1);
    expect(dates.has('2026-08-01')).toBe(true);

    const second = await openLeaveYear(adminCtx(b), { year: 2026 });

    expect(await ledgerFingerprint()).toBe(after);
    expect(second.granted).toBe(0);
    expect(second.rows.every((r) => r.outcome === 'already_open')).toBe(true);
    // And a third, because "idempotent" that only survives one repeat is a coincidence.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await ledgerFingerprint()).toBe(after);
    expect(f.veteran).toBeTruthy();
  });

  it('the Generate Entitlement screen twice: the ledger is byte-identical, every line already_open', async () => {
    await nastyFixture();
    const req = { year: 2026, targetMode: 'criteria' as const, criteria: {} };

    const first = await runLeaveGeneration(adminCtx(b), req);
    const after = await ledgerFingerprint();
    expect(first.granted).toBeGreaterThan(0);

    const second = await runLeaveGeneration(adminCtx(b), req);

    expect(await ledgerFingerprint()).toBe(after);
    expect(second.lines.length).toBeGreaterThan(0);
    expect(second.lines.every((l) => l.outcome === 'already_open')).toBe(true);
    // `already_open` counts as PASSED, or a re-run would report the whole company as failed.
    expect(second.employeesFailed).toBe(0);
  });

  it('the preview still leaves no trace once the grant date can move', async () => {
    await nastyFixture();
    const before = await ledgerFingerprint();

    const preview = await previewLeaveGeneration(adminCtx(b), {
      year: 2026,
      targetMode: 'criteria',
      criteria: {},
    });

    expect(preview.granted).toBeGreaterThan(0);
    expect(await ledgerFingerprint()).toBe(before);
  });

  it('a joiner whose hire grant already ran is never granted a second time', async () => {
    await table({ leaveTypeId: b.annualLeaveTypeId, days: 12, validFrom: '2020-01-01', withRule: true });
    const emp = await hire('2026-05-01', [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }]);
    const atHire = await ledgerBalance(emp.employmentId, b.annualLeaveTypeId);
    expect(atHire).toBeGreaterThan(0);

    const res = await openLeaveYear(adminCtx(b), { year: 2026 });

    // ⚠️ THE DOUBLE-GRANT THIS ROUND CAME CLOSEST TO SHIPPING. Fault 2's fix makes the sweep reach this
    // employee for the first time; the hire grant's row is dated their JOIN date, so the old 1-January key
    // could not see it and would have paid them twice.
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(atHire);
    expect(res.rows.find((r) => r.leaveTypeId === b.annualLeaveTypeId)!.outcome).toBe('already_open');
  });
});

// ── The screen's own selection gate — a fourth fault the round's plan did not name ───────────────────
describe('r193 — Generate Entitlement SELECTS the mid-year joiners', () => {
  it('a joiner is reached through the screen, not only through the bare engine', async () => {
    // `resolveOrgCriteriaTargets` excludes anyone hired after `asOf`, and this screen resolved at
    // 1 January — so it dropped every joiner BEFORE openLeaveYear was called. Fixing the engine alone
    // would have changed nothing on the only screen the reporter uses. A PAST year is used deliberately:
    // `asOfForLeaveYear` pins the late pass at 31 December for it, so this case does not depend on when
    // the suite happens to run.
    const study = await customLeaveType('STUDY', 'Study Leave');
    await table({ leaveTypeId: study, days: 12, validFrom: '2020-01-01', withRule: true });
    const joiner = await hire('2024-03-01');

    const res = await runLeaveGeneration(adminCtx(b), { year: 2024, targetMode: 'criteria', criteria: {} });

    expect(res.lines.some((l) => l.employmentId === joiner.employmentId)).toBe(true);
    expect(await ledgerBalance(joiner.employmentId, study)).toBe(12);
  });

  it('an employee who LEFT during the year is still selected — the union only ever adds', async () => {
    const study = await customLeaveType('STUDY', 'Study Leave');
    await table({ leaveTypeId: study, days: 12, validFrom: '2020-01-01', withRule: true });
    const leaver = await hire('2019-01-01');
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2024-03-31' })
      .where(eq(schema.employment.id, leaver.employmentId));

    const res = await runLeaveGeneration(adminCtx(b), { year: 2024, targetMode: 'criteria', criteria: {} });

    expect(res.lines.some((l) => l.employmentId === leaver.employmentId)).toBe(true);
  });
});

// ── The pure date arithmetic, and the shape guards that keep the two engines together ────────────────
describe('r193 — effectiveGrantStart', () => {
  it('is the LATER of the year start, the table start and the join date', () => {
    expect(effectiveGrantStart('2026-01-01', null, '2019-01-01')).toBe('2026-01-01');
    expect(effectiveGrantStart('2026-01-01', '2026-08-01', '2019-01-01')).toBe('2026-08-01');
    expect(effectiveGrantStart('2026-01-01', null, '2026-03-01')).toBe('2026-03-01');
    expect(effectiveGrantStart('2026-01-01', '2026-08-01', '2026-03-01')).toBe('2026-08-01');
    expect(effectiveGrantStart('2026-01-01', '2026-08-01', '2026-10-01')).toBe('2026-10-01');
    // A table in force since long before the year does not drag the start backwards.
    expect(effectiveGrantStart('2026-01-01', '2020-01-01', '2019-01-01')).toBe('2026-01-01');
  });
});

describe('r193 — hireYearGrantDays', () => {
  it('pro-rates ANNUAL by whole months remaining, including the month of hire', () => {
    const shape = (hiredOn: string) =>
      hireYearGrantDays({ days: 12, typeCode: 'ANNUAL', yearCycleOverride: null, hiredOn });
    expect(shape('2026-01-15')).toBe(12);
    expect(shape('2026-04-01')).toBe(9);
    expect(shape('2026-12-31')).toBe(1);
  });

  it('grants s.60F types in full — they are per calendar year and never day-sliced', () => {
    for (const code of ['SICK', 'HOSPITALIZATION', 'STUDY']) {
      expect(hireYearGrantDays({ days: 16, typeCode: code, yearCycleOverride: null, hiredOn: '2026-10-01' })).toBe(16);
    }
  });
});

describe('r193 drift guards — the marker, and the two engines that read it', () => {
  const leaveSrc = read('core/leave.ts');

  it('nothing in core/leave.ts keys a year-open marker on 1 January any more', () => {
    // The single most dangerous regression available here: re-introduce this comparison anywhere and a
    // re-run double-grants entitlement, or carried leave silently stops expiring.
    expect(leaveSrc).not.toMatch(/eq\(leaveLedger\.effectiveOn,\s*yearStart\)/);
  });

  it('openLeaveYear and expireCarriedLeave read the SAME predicate', () => {
    const body = (name: string) => {
      const start = leaveSrc.indexOf(`export async function ${name}(`);
      expect(start).toBeGreaterThan(-1);
      const end = leaveSrc.indexOf('\n}\n', start);
      return leaveSrc.slice(start, end);
    };
    // Two engines asking "was this leave year opened?" in two different ways is how the answer drifts. It
    // already drifted once: this round's plan named openLeaveYear's guard and missed expireCarriedLeave's,
    // which keys on the very same row.
    expect(body('openLeaveYear')).toContain('yearOpenMarkerCond(');
    expect(body('expireCarriedLeave')).toContain('yearOpenMarkerCond(');
  });

  it('the grant and its paired cap forfeit are written on the SAME date', () => {
    // A forfeit dated 1 January while the grant lands in August would strip the employee of their carry
    // for seven months before the replacement days arrived.
    const start = leaveSrc.indexOf('export async function openLeaveYear(');
    const body = leaveSrc.slice(start, leaveSrc.indexOf('\n}\n', start));
    expect(body).not.toMatch(/effectiveOn:\s*yearStart/);
  });

  it('the Generate Entitlement screen resolves its targets across the year, not at 1 January only', () => {
    // The contract lives BETWEEN two files: core/leave.ts can be entirely correct while this selection
    // drops every joiner before the engine is called, and a unit test of either half passes throughout.
    const gen = read('core/leave-generation.ts');
    expect(gen).toContain('asOfForLeaveYear');
    expect(gen).not.toMatch(/openLeaveYear only ever visits employments hired BEFORE the year starts/);
  });
});
