/**
 * 05d2709a — SUSPECTED DUPLICATE PERSON RECORDS.
 *
 * The cases below are about the ways this feature could do HARM, not about the SQL:
 *
 *  1. IT MUST NOT ACCUSE THE SUPPORTED SHAPE. One PERSON holding several EMPLOYMENTS is normal
 *     (CLAUDE.md §1). If that reads as a duplicate, the screen is wrong about the single distinction the
 *     whole item turns on, and the reporter would be asked to "confirm" a merge of somebody with two jobs.
 *  2. IT MUST NOT CLAIM A PRECISION IT DOES NOT HAVE. No confidence score, no percentage, no ranking —
 *     pinned structurally, because a later "helpful" addition is exactly how it would arrive.
 *  3. IT MUST BE ABLE TO SAY "THESE ARE PROBABLY TWO DIFFERENT PEOPLE". A detector that can only ever
 *     argue one way is not evidence. This is the failure mode that matters most.
 *  4. THREE FIELDS CANNOT COUNT AS A DISAGREEMENT, each for its own reason: the IC (the database FORCES
 *     it to differ — employee_statutory_my_ic_uq, migration 0214), the work email (the employer gives it,
 *     not the person) and the exact name spelling (inside a group it can differ only in capitals and
 *     spacing). Counting any of them fires the "may be different people" warning on nearly every pair,
 *     which is how a warning stops being read — and the spelling one said the OPPOSITE of the truth.
 *  5. IT MUST NOT WRITE, and it must not show half a pair as if it were a whole one.
 *
 * ⚠️ TWO SEPARATE FENCES, TESTED SEPARATELY AND LABELLED. `assertMayReadDuplicates` is THIS module's
 * guard; RLS is the data fence. A refusal test that only proves "another tenant sees nothing" pins
 * `employment_rls` and stays green if the guard is deleted, so both are exercised on their own terms.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee, terminateEmployment } from '../core/org';
import type { SessionContext } from '../db/client';
import {
  DUPLICATE_EVIDENCE_FIELDS,
  DUPLICATE_FIELD_NOT_A_CONTRADICTION,
  DuplicatePersonAccessError,
  duplicatePersonCandidates,
  groupDuplicateCandidates,
  namesHeldByMultiplePersons,
  normalizeFullName,
  type DuplicateEvidenceField,
} from '../core/duplicate-person';
import en from '../messages/en.json';

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/** Source with comments removed — the structural guards below are about CODE, never about prose. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

describe('05d2709a — suspected duplicate person records', () => {
  let base: Base;
  let company2: string;
  let dept2: string;
  let seq = 0;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    seq = 0;
    const [c] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Beta Sdn Bhd', country: 'MY' })
      .returning({ id: schema.company.id });
    company2 = c.id;
    const [d] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: company2, name: 'Beta Ops' })
      .returning({ id: schema.department.id });
    dept2 = d.id;
  });
  afterAll(async () => {
    await closeAll();
  });

  /** Hire somebody. `personId` reuses an EXISTING person — the supported multi-employment shape. */
  async function hire(p: {
    name?: string;
    hiredOn?: string;
    second?: boolean;
    personId?: string;
    code?: string;
  }) {
    seq += 1;
    return hireEmployee(adminCtx(base), {
      person: p.personId
        ? { id: p.personId }
        : { fullName: p.name ?? 'Lee Choo Hong', primaryEmail: `dup.${seq}@dup.test` },
      companyId: p.second ? company2 : base.companyId,
      departmentId: p.second ? dept2 : base.deptA,
      employmentType: 'full_time',
      hiredOn: p.hiredOn ?? '2023-07-26',
      employeeCode: p.code ?? `DUP-${String(seq).padStart(3, '0')}`,
    });
  }

  /** Fixture writes go in as the OWNER so the fixture is never the thing under test. */
  const setPerson = (personId: string, v: Partial<typeof schema.person.$inferInsert>) =>
    owner.db.update(schema.person).set(v).where(eq(schema.person.id, personId));
  const setStatutory = (personId: string, v: { icNumber?: string; passportNumber?: string; bankAccountNo?: string }) =>
    owner.db.insert(schema.employeeStatutoryMy).values({ tenantId: base.tenantId, personId, ...v });

  const only = <T>(xs: readonly T[]): T => {
    expect(xs).toHaveLength(1);
    return xs[0];
  };
  const agreementFor = (
    g: { agreement: { field: DuplicateEvidenceField; state: string; recordedBy: number; values: string[] }[] },
    f: DuplicateEvidenceField,
  ) => g.agreement.find((a) => a.field === f)!;

  // ── 1. The supported shape, and the line this whole item is drawn on ──────────────────────────────

  it('does NOT flag one PERSON holding several EMPLOYMENTS — the supported shape', async () => {
    // CLAUDE.md §1: USER ≠ PERSON ≠ EMPLOYEE ≠ EMPLOYMENT. Somebody employed by two companies in the
    // group, entered ONCE, is exactly what the system is built for. Flagging it would send the reporter
    // to "confirm" a merge of a person with two jobs.
    const first = await hire({ code: 'DUP-A' });
    await hire({ personId: first.personId, second: true, code: 'DUP-B' });

    const view = await duplicatePersonCandidates(adminCtx(base));
    expect(view.activeEmployments).toBe(2);
    expect(view.activePersons).toBe(1);
    expect(view.groups).toEqual([]);
    expect(view.extraPersonRecords).toBe(0);
  });

  it('DOES flag two SEPARATE person records sharing a name and a joining date', async () => {
    // The non-vacuity half of the case above: same two employments, two person records instead of one.
    await hire({ code: 'DUP-A' });
    await hire({ second: true, code: 'DUP-B' });

    const view = await duplicatePersonCandidates(adminCtx(base));
    const g = only(view.groups);
    expect(g.personIds).toHaveLength(2);
    expect(g.records.map((r) => r.employeeCode)).toEqual(['DUP-A', 'DUP-B']);
    expect(g.records.map((r) => r.personLabel)).toEqual(['A', 'B']);
    expect(g.companies).toEqual(['Acme Sdn Bhd', 'Beta Sdn Bhd']);
    expect(view.extraPersonRecords).toBe(1);
  });

  it('counts PERSON records, not employments, when a group holds both shapes at once', async () => {
    // LEE CHOO HONG's real shape could be "one person with two jobs PLUS a second record". The extra-record
    // figure the reporter was given is about PERSON records, so two employments of one person must count
    // once — and the two rows have to be visibly one record, which is what the letter is for.
    const a = await hire({ code: 'DUP-A' });
    await hire({ personId: a.personId, second: true, code: 'DUP-B' });
    await hire({ code: 'DUP-C' });

    const g = only((await duplicatePersonCandidates(adminCtx(base))).groups);
    expect(g.records).toHaveLength(3);
    expect(g.personIds).toHaveLength(2);
    // DUP-A and DUP-B are ONE person record; the screen must be able to say so.
    expect(g.records.map((r) => r.personLabel)).toEqual(['A', 'A', 'B']);
    expect(g.records[0].personId).toBe(g.records[1].personId);
  });

  // ── 2. The edge of the heuristic ──────────────────────────────────────────────────────────────────

  it('does not list a shared name whose joining dates DIFFER, and counts it instead', async () => {
    await hire({ hiredOn: '2023-07-26' });
    await hire({ hiredOn: '2024-02-01' });

    const view = await duplicatePersonCandidates(adminCtx(base));
    expect(view.groups).toEqual([]);
    // Stated as a number so the reader knows the edge of the rule rather than assuming the list is all
    // there is. A LIST here would bury the candidates under everybody with a common name.
    expect(view.sharedNamesWithDifferentHireDates).toBe(1);
  });

  it('never counts a name only ONE person record holds — not even one person with two jobs', async () => {
    // ⚠️ THE CASE A MUTATION SLIPPED PAST. "Names shared with different joining dates" is printed on the
    // screen, and if the ≥2-person-records rule stops applying to it, a tenant of 500 uniquely-named
    // employees reports 500 shared names. The rule lives in ONE function
    // (`namesHeldByMultiplePersons`) precisely so this can be asserted once and hold on both sides.
    const solo = await hire({ name: 'Solo Person', code: 'DUP-S1' });
    await hire({ personId: solo.personId, second: true, hiredOn: '2024-05-01', code: 'DUP-S2' });
    await hire({ name: 'Another Name', code: 'DUP-N1' });

    const view = await duplicatePersonCandidates(adminCtx(base));
    expect(view.activeEmployments).toBe(3);
    expect(view.groups).toEqual([]);
    expect(view.sharedNamesWithDifferentHireDates).toBe(0);
    // Pinned on the shared rule itself as well, so it cannot be satisfied by the reader's narrowing alone.
    expect([...namesHeldByMultiplePersons([
      { fullName: 'Solo Person', personId: 'p1' },
      { fullName: 'Solo Person', personId: 'p1' },
      { fullName: 'Another Name', personId: 'p2' },
      { fullName: 'Din Bin Ahmad', personId: 'p3' },
      { fullName: 'din bin  ahmad', personId: 'p4' },
    ])]).toEqual(['DIN BIN AHMAD']);
  });

  it('folds case and repeated spaces, and shows the spelling difference as evidence', async () => {
    // Case and whitespace are the SAME STRING keyed twice, not a judgement about names. The exact
    // spelling is still reported, because a reader comparing two records wants to see it.
    const a = await hire({ name: 'LEE CHOO HONG', code: 'DUP-A' });
    await hire({ name: 'Lee  Choo Hong', code: 'DUP-B' });
    expect(normalizeFullName('Lee  Choo Hong')).toBe('LEE CHOO HONG');
    expect(a.personId).toBeTruthy();

    const g = only((await duplicatePersonCandidates(adminCtx(base))).groups);
    expect(g.records).toHaveLength(2);
    expect(agreementFor(g, 'fullNameExact').state).toBe('differs');
    expect(agreementFor(g, 'fullNameExact').values).toEqual(['LEE CHOO HONG', 'Lee  Choo Hong']);
    // ⚠️ AND IT IS NOT EVIDENCE AGAINST. Caught by RENDERING the screen, not by a unit test: the page
    // told a reader that "LEE CHOO HONG" and "Lee  Choo Hong" MAY BE DIFFERENT PEOPLE. Within a group the
    // key IS the folded name, so two spellings can differ ONLY in capitals and spacing — which points AT
    // one human entered twice, the exact opposite of what the warning claimed.
    expect(g.contradictions).not.toContain('fullNameExact');
    expect(g.contradictions).toEqual([]);
    expect(DUPLICATE_FIELD_NOT_A_CONTRADICTION.fullNameExact).toBe('cosmetic_only');
  });

  it('ignores a terminated employment: a leaver is not a record to go and reconcile', async () => {
    const a = await hire({ code: 'DUP-A' });
    await hire({ code: 'DUP-B' });
    await terminateEmployment(adminCtx(base), { employmentId: a.employmentId, terminationDate: '2025-12-31' });

    const view = await duplicatePersonCandidates(adminCtx(base));
    expect(view.activeEmployments).toBe(1);
    expect(view.groups).toEqual([]);
  });

  // ── 3. The finding that matters most: they may be DIFFERENT people ────────────────────────────────

  it('surfaces a DISAGREEMENT on a recorded fact — the evidence they are two different people', async () => {
    const a = await hire({ code: 'DUP-A' });
    const b = await hire({ code: 'DUP-B' });
    await setPerson(a.personId, { dateOfBirth: '1988-03-04', gender: 'male' });
    await setPerson(b.personId, { dateOfBirth: '1994-11-21', gender: 'female' });

    const g = only((await duplicatePersonCandidates(adminCtx(base))).groups);
    expect(g.contradictions).toContain('dateOfBirth');
    expect(g.contradictions).toContain('gender');
    expect(agreementFor(g, 'dateOfBirth').values).toEqual(['1988-03-04', '1994-11-21']);
  });

  it('reports a fact both records agree on as SAME, and one recorded only once as UNKNOWN', async () => {
    // Three states, and the third is the point: "only one of them has a date of birth" is not
    // corroboration and is not a disagreement. A score could express neither.
    const a = await hire({ code: 'DUP-A' });
    const b = await hire({ code: 'DUP-B' });
    await setPerson(a.personId, { dateOfBirth: '1988-03-04', gender: 'male' });
    await setPerson(b.personId, { gender: 'male' });

    const g = only((await duplicatePersonCandidates(adminCtx(base))).groups);
    expect(agreementFor(g, 'gender').state).toBe('same');
    expect(agreementFor(g, 'dateOfBirth').state).toBe('unknown');
    expect(agreementFor(g, 'dateOfBirth').recordedBy).toBe(1);
    expect(g.contradictions).not.toContain('dateOfBirth');
  });

  it('a field NOBODY recorded is UNKNOWN with no values, and is still listed', async () => {
    // A field that vanished when it was blank would read as corroboration by omission.
    await hire({ code: 'DUP-A' });
    await hire({ code: 'DUP-B' });
    const g = only((await duplicatePersonCandidates(adminCtx(base))).groups);
    expect(g.agreement.map((a) => a.field)).toEqual([...DUPLICATE_EVIDENCE_FIELDS]);
    expect(agreementFor(g, 'bankAccountNo')).toMatchObject({ state: 'unknown', recordedBy: 0, values: [] });
  });

  // ── 4. The constraint that changes what a difference MEANS ────────────────────────────────────────

  it('a different IC is shown but is NOT a disagreement — the database forces it to differ', async () => {
    // FACT: employee_statutory_my_ic_uq (migration 0214) makes a non-null IC unique per tenant, so two
    // person records CANNOT carry the same one. Counting that as evidence would fire the "may be
    // different people" warning on nearly every fully-recorded pair.
    const a = await hire({ code: 'DUP-A' });
    const b = await hire({ code: 'DUP-B' });
    await setStatutory(a.personId, { icNumber: '880304101234' });
    await setStatutory(b.personId, { icNumber: '880304101235' });

    const g = only((await duplicatePersonCandidates(adminCtx(base))).groups);
    expect(agreementFor(g, 'icNumber').state).toBe('differs');
    expect(agreementFor(g, 'icNumber').values).toEqual(['880304101234', '880304101235']);
    expect(g.contradictions).not.toContain('icNumber');
    expect(DUPLICATE_FIELD_NOT_A_CONTRADICTION.icNumber).toBe('unique_by_constraint');
  });

  it('a different WORK EMAIL is not a disagreement either — the employer gives it, not the person', async () => {
    // `person.primary_email` is NOT NULL and is a fact about the EMPLOYMENT: one person at two companies
    // in a group has two work addresses. It would therefore resolve on every single pair, and counting it
    // would make the "may be different people" warning permanent and meaningless. Its values are still
    // shown — a reader recognises a name in an address — it simply carries no verdict.
    await hire({ code: 'DUP-A' });
    await hire({ second: true, code: 'DUP-B' });

    const g = only((await duplicatePersonCandidates(adminCtx(base))).groups);
    expect(agreementFor(g, 'primaryEmail').state).toBe('differs');
    expect(agreementFor(g, 'primaryEmail').values).toHaveLength(2);
    expect(g.contradictions).toEqual([]);
    expect(DUPLICATE_FIELD_NOT_A_CONTRADICTION.primaryEmail).toBe('assigned_by_employer');
    // …and the PERSONAL email is deliberately NOT excluded: that one belongs to the human.
    expect(DUPLICATE_FIELD_NOT_A_CONTRADICTION.personalEmail).toBeUndefined();
  });

  it('…and the non-vacuity half: an UNCONSTRAINED field differing IS a disagreement', async () => {
    // Without this, the case above would pass for the wrong reason — a `contradictions` array that is
    // simply always empty.
    const a = await hire({ code: 'DUP-A' });
    const b = await hire({ code: 'DUP-B' });
    await setStatutory(a.personId, { passportNumber: 'A1234567' });
    await setStatutory(b.personId, { passportNumber: 'B7654321' });

    const g = only((await duplicatePersonCandidates(adminCtx(base))).groups);
    expect(g.contradictions).toEqual(['passportNumber']);
  });

  it('the IC constraint still permits the blank-second-record shape, and reads as UNKNOWN', async () => {
    // The plausible MECHANISM behind these records: an IC that is already taken is refused, so the second
    // record tends to be created with it left blank. That is not a disagreement, and the module says so.
    const a = await hire({ code: 'DUP-A' });
    await hire({ code: 'DUP-B' });
    await setStatutory(a.personId, { icNumber: '880304101234' });

    const g = only((await duplicatePersonCandidates(adminCtx(base))).groups);
    expect(agreementFor(g, 'icNumber')).toMatchObject({ state: 'unknown', recordedBy: 1 });
    expect(g.contradictions).toEqual([]);
  });

  // ── 5. The operational evidence the plan promised ─────────────────────────────────────────────────

  it('carries per-record payslip and leave evidence: "has this one been paid?"', async () => {
    const a = await hire({ code: 'DUP-A' });
    await hire({ code: 'DUP-B' });

    const [period] = await owner.db
      .insert(schema.payPeriod)
      .values({ tenantId: base.tenantId, companyId: base.companyId, period: '2025-11', status: 'closed' })
      .returning({ id: schema.payPeriod.id });
    const [batch] = await owner.db
      .insert(schema.payrollBatch)
      .values({
        tenantId: base.tenantId,
        companyId: base.companyId,
        payPeriodId: period.id,
        payPeriod: '2025-11',
        batchDate: '2025-11-30',
        status: 'closed',
        employeeCount: 1,
      })
      .returning({ id: schema.payrollBatch.id });
    await owner.db.insert(schema.payslip).values({
      tenantId: base.tenantId,
      batchId: batch.id,
      employmentId: a.employmentId,
      basicSalary: '5000.00',
      grossPay: '5000.00',
      statutory: {},
      totalDeductions: '0.00',
      netPay: '5000.00',
      employerCost: '5000.00',
    });
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: base.tenantId,
      employmentId: a.employmentId,
      leaveTypeId: base.annualLeaveTypeId,
      entryType: 'accrual',
      days: '8.00',
      effectiveOn: '2025-01-01',
    });

    const g = only((await duplicatePersonCandidates(adminCtx(base))).groups);
    expect(g.anyPayslip).toBe(true);
    expect(g.anyLeaveLedger).toBe(true);
    expect(g.records.map((r) => [r.employeeCode, r.payslipCount, r.leaveLedgerEntries])).toEqual([
      ['DUP-A', 1, 1],
      ['DUP-B', 0, 0],
    ]);
  });

  // ── 6. Ordering — pinned as an invariant of the data, never a position ────────────────────────────

  it('orders groups by name and records by employee ID, whatever order the rows arrive in', async () => {
    await hire({ name: 'Zainal Bin Yusof', code: 'DUP-Z2' });
    await hire({ name: 'Zainal Bin Yusof', code: 'DUP-Z1' });
    await hire({ name: 'Ahmad Bin Ali', code: 'DUP-A2' });
    await hire({ name: 'Ahmad Bin Ali', code: 'DUP-A1' });

    const view = await duplicatePersonCandidates(adminCtx(base));
    expect(view.groups.map((g) => g.displayName)).toEqual(['Ahmad Bin Ali', 'Zainal Bin Yusof']);
    expect(view.groups.flatMap((g) => g.records.map((r) => r.employeeCode))).toEqual([
      'DUP-A1',
      'DUP-A2',
      'DUP-Z1',
      'DUP-Z2',
    ]);
    // The letter is read off that order, so it is stable rather than "whichever row came back first".
    expect(view.groups[0].records.map((r) => r.personLabel)).toEqual(['A', 'B']);
  });

  // ── 7. The two fences, tested separately ──────────────────────────────────────────────────────────

  it("THIS MODULE'S GUARD refuses a non-admin caller (not RLS — same tenant, same rows)", async () => {
    await hire({ code: 'DUP-A' });
    await hire({ code: 'DUP-B' });
    const employee: SessionContext = { ...adminCtx(base), roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };

    await expect(duplicatePersonCandidates(employee)).rejects.toBeInstanceOf(DuplicatePersonAccessError);
    // Non-vacuity: the SAME tenant and the SAME rows, read by an admin, do return the group. So the
    // refusal above is the guard and not an empty database.
    expect((await duplicatePersonCandidates(adminCtx(base))).groups).toHaveLength(1);
  });

  it('RLS fences another tenant out entirely (this pins employment_rls, not the guard above)', async () => {
    await hire({ code: 'DUP-A' });
    await hire({ code: 'DUP-B' });
    const other = await seedBase();

    const view = await duplicatePersonCandidates(adminCtx(other));
    expect(view.activeEmployments).toBe(0);
    expect(view.groups).toEqual([]);
  });

  it('RLS company scope: half a cross-company pair is NOT presented as a duplicate', async () => {
    // A company-scoped hr_admin can see only one of the two records. Reporting "a duplicate" on the
    // strength of a record they cannot read would be an accusation they have no way to check — so a group
    // needs TWO VISIBLE person records. (This pins RLS + the ≥2-visible rule, not the admin guard.)
    await hire({ code: 'DUP-A' });
    await hire({ second: true, code: 'DUP-B' });
    const scopedToBase: SessionContext = {
      tenantId: base.tenantId,
      userId: base.adminUserId,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: base.companyId }],
    };

    const view = await duplicatePersonCandidates(scopedToBase);
    expect(view.activeEmployments).toBe(1);
    expect(view.groups).toEqual([]);
    // Non-vacuity: the group-wide admin, on the same data, DOES see the pair.
    expect((await duplicatePersonCandidates(adminCtx(base))).groups).toHaveLength(1);
  });

  // ── 8. Structural guards: no score, no writes, no missing strings ─────────────────────────────────

  it('NEVER produces a confidence score, a percentage or a ranking', async () => {
    // The constraint the approved plan states twice. It is pinned structurally because the way it would
    // be lost is somebody helpfully ADDING one later, and no behavioural test would notice.
    const a = await hire({ code: 'DUP-A' });
    await hire({ code: 'DUP-B' });
    await setPerson(a.personId, { dateOfBirth: '1988-03-04' });
    const view = await duplicatePersonCandidates(adminCtx(base));

    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') {
        for (const [k, inner] of Object.entries(v)) {
          keys.add(k.toLowerCase());
          walk(inner);
        }
      }
    };
    walk(view);
    for (const banned of ['score', 'confidence', 'similarity', 'probability', 'likelihood', 'percent', 'match']) {
      expect([...keys].filter((k) => k.includes(banned)), `no "${banned}" on the view`).toEqual([]);
    }
    // …and not in the CODE either. Comments are stripped first, deliberately: these files DESCRIBE the
    // prohibition at length, and a guard that a header cannot mention the thing it forbids would be
    // reworded away rather than obeyed.
    for (const file of ['core/duplicate-person.ts', 'app/admin/personnel/duplicates/page.tsx']) {
      const code = stripComments(readFileSync(path.join(ROOT, file), 'utf8'));
      const offenders = [...code.matchAll(/\b(confidence|similarity|likelihood|probability|score)[A-Za-z]*/gi)].map(
        (m) => m[0],
      );
      expect(offenders, `${file} must not compute one`).toEqual([]);
    }
  });

  it('is READ-ONLY by construction: the module and the report script contain no write', async () => {
    for (const file of [
      'core/duplicate-person.ts',
      'scripts/report-duplicate-person-records.ts',
      'app/admin/personnel/duplicates/page.tsx',
    ]) {
      const code = stripComments(readFileSync(path.join(ROOT, file), 'utf8'));
      // Drizzle's writers and raw SQL alike. A merge in this round is out of scope by decision, and an
      // UPDATE repointing a person_id is precisely what the plan says to stop and report instead of write.
      for (const writer of [/\.insert\s*\(/, /\.update\s*\(/, /\.delete\s*\(/, /\binsert\s+into\b/i, /\bupdate\s+\w+\s+set\b/i, /\bdelete\s+from\b/i]) {
        expect(writer.test(code), `${file} must not ${writer}`).toBe(false);
      }
    }
  });

  it('every string the screen renders resolves in en.json AND in all six locales', async () => {
    // §8 "a key is not a screen": the field and state labels are looked up through a map, so the i18n
    // coverage test's static scan cannot see them. Without this they would ship as raw keys.
    const dotted = (o: unknown, k: string) =>
      k.split('.').reduce<unknown>((acc, seg) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[seg] : undefined), o);
    const keys = [
      'title',
      'description',
      'backToPersonnel',
      'howToReadTitle',
      'howToReadSuggestion',
      'howToReadMultiEmployment',
      'howToReadNothingChanged',
      'statNames',
      'statExtraRecords',
      'statChecked',
      'activeOnlyNote',
      'sharedDifferentDates',
      'noneFound',
      'groupSubtitle',
      'mayBeDifferentPeople',
      'hasBeenPaid',
      'acrossCompanies',
      'colRecord',
      'colEmployeeId',
      'colCompany',
      'colJoined',
      'colIc',
      'colPassport',
      'colDob',
      'colEmail',
      'colBank',
      'colPayslips',
      'colLeaveEntries',
      'openRecord',
      'notRecorded',
      'evidenceTitle',
      'stateSame',
      'stateDiffers',
      'stateNotRecorded',
      'statePartiallyRecorded',
      ...DUPLICATE_EVIDENCE_FIELDS.map((f) => `field.${f}`),
      // Looked up as `notCounted.<reason>` from the map, so nothing static can see them. Driven off the
      // map itself: a field given a NEW reason with no translation fails here rather than on screen.
      ...[...new Set(Object.values(DUPLICATE_FIELD_NOT_A_CONTRADICTION))].map((r) => `notCounted.${r}`),
    ];
    for (const loc of LOCALES) {
      const cat = JSON.parse(readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
      for (const k of keys) {
        expect(typeof dotted(cat, `people.duplicates.${k}`), `${loc}: people.duplicates.${k}`).toBe('string');
      }
    }
    // The entry point on the employee list, and the function-access column's own label + scope note.
    expect(typeof dotted(en, 'people.list.duplicateRecords')).toBe('string');
    expect(typeof dotted(en, 'admin.users.screen.duplicatePersonRecords')).toBe('string');
    expect(typeof dotted(en, 'admin.users.scope.duplicatePersonRecords')).toBe('string');

    // ⚠️ AND THE PLACEHOLDERS MATCH, IN EVERY LOCALE. A key that EXISTS but whose translation renamed or
    // dropped a placeholder throws FORMATTING_ERROR at render time in that locale only — invisible to
    // tsc, to `next build` and to a render check done in English. `{n}` vs `{count}` is a one-character
    // mistake that takes a screen down for Malay readers alone.
    const placeholders = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    const enCat = JSON.parse(readFileSync(path.join(ROOT, 'messages', 'en.json'), 'utf8'));
    for (const loc of LOCALES) {
      const cat = JSON.parse(readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
      for (const k of keys) {
        const a = [...placeholders(dotted(enCat, `people.duplicates.${k}`) as string)].sort();
        const b = [...placeholders(dotted(cat, `people.duplicates.${k}`) as string)].sort();
        expect(b, `${loc}: people.duplicates.${k} placeholders`).toEqual(a);
      }
    }
  });

  it('groupDuplicateCandidates is the ONE definition the script and the screen share', async () => {
    // The script runs as the migration role over every tenant; the screen runs under RLS for one. If each
    // grouped rows its own way, the list the reporter is handed and the list they open could disagree
    // about the same people. Pinned by driving the exported function directly.
    const rowOf = (over: Partial<Parameters<typeof groupDuplicateCandidates>[0][number]>) => ({
      employmentId: '00000000-0000-0000-0000-000000000001',
      personId: '00000000-0000-0000-0000-00000000000a',
      employeeCode: 'X',
      companyId: 'c1',
      company: 'Acme',
      fullName: 'Din Bin Ahmad',
      hiredOn: '2025-08-04',
      joinDate: null,
      dateOfBirth: null,
      gender: null,
      maritalStatus: null,
      primaryEmail: 'x@y.test',
      personalEmail: null,
      icNumber: null,
      passportNumber: null,
      bankAccountNo: null,
      payslipCount: 0,
      leaveLedgerEntries: 0,
      ...over,
    });
    const { groups } = groupDuplicateCandidates([
      rowOf({ employmentId: 'e1', personId: 'p1', employeeCode: 'A' }),
      rowOf({ employmentId: 'e2', personId: 'p2', employeeCode: 'B' }),
      rowOf({ employmentId: 'e3', personId: 'p1', employeeCode: 'C' }),
    ]);
    const g = only(groups);
    expect(g.personIds).toEqual(['p1', 'p2']);
    expect(g.records.map((r) => r.personLabel)).toEqual(['A', 'B', 'A']);
    expect(g.key).toBe('DIN BIN AHMAD|2025-08-04');
  });
});
