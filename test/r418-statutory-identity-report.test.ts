/**
 * r418 (items e74af58c and 5c31d379) — THE IDENTITY NUMBER AND THE ZERO-EPF ROWS, against a real database.
 *
 * test/r418-statutory-identity.test.ts pins the rule with no database. This file pins that the READS feed it:
 * Borang 8A, the EIS (SIP) schedule that re-shapes the 8A read, Borang A, and the BBCD projected from Borang A.
 *   • the reported case — a non-citizen with a passport and no IC ("Employee D") — is on both forms, by
 *     passport, and blocks neither;
 *   • a non-citizen with no passport is held, named, with "Passport number";
 *   • a Singaporean recorded as a citizen with an IC keeps the IC; a permanent resident prints the IC field;
 *   • Borang A leaves off anyone whose employer AND employee shares are both zero, BEFORE pagination, so the
 *     sheets, Bil Pekerja, the totals and the BBCD all follow; a one-share-nonzero row stays.
 * No EPF, SOCSO or EIS figure is computed here: every expected amount is read off the stored payslips.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { reportPreview } from '../core/reporting';
import { borangAFrom } from '../lib/borang-a';
import { borangBbcdFrom } from '../lib/borang-bbcd';
import { borang8AFrom } from '../lib/borang-8a';
import { borangAHasContributions } from '../app/payroll/borang-a/query';

let b: Base;
const PERIOD = '2026-07';

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setCompanyStatutoryMY(adminCtx(b), {
    companyId: b.companyId,
    epfEmployerNo: '019632261',
    socsoEmployerCode: 'B3201005082P',
    ssmRegistrationNo: '202301012345',
  });
});

let seq = 0;
async function hire(p: {
  name: string;
  salary?: number;
  ic?: string | null;
  passport?: string | null;
  citizenship?: 'citizen' | 'pr' | 'non_citizen';
  nationality?: string | null;
  /** Leave the person with NO employee_statutory_my row at all. */
  noStatutoryRow?: boolean;
}) {
  seq += 1;
  const a = adminCtx(b);
  const E = await hireEmployee(a, {
    person: { fullName: p.name, primaryEmail: `r418_${seq}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2024-03-01',
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: p.salary ?? 4000, effectiveFrom: '2024-03-01' });
  if (!p.noStatutoryRow) {
    await setStatutoryProfileMY(a, {
      personId: E.personId,
      icNumber: p.ic ?? '',
      epfNumber: String(17000000 + seq),
      taxCategory: 1,
      numChildren: 0,
      epfCitizenship: p.citizenship ?? 'citizen',
    });
    if (p.passport) {
      await owner.db
        .update(schema.employeeStatutoryMy)
        .set({ passportNumber: p.passport })
        .where(eq(schema.employeeStatutoryMy.personId, E.personId));
    }
  }
  if (p.nationality !== undefined) {
    await owner.db.update(schema.person).set({ nationality: p.nationality }).where(eq(schema.person.id, E.personId));
  }
  return E;
}

async function runMonth() {
  const a = adminCtx(b);
  const batch = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
  await generatePayslips(a, { batchId: batch.batchId });
  return a;
}
const view = (reportId: string) =>
  reportPreview(adminCtx(b), { companyId: b.companyId, reportId, periodKey: PERIOD });

/** Overwrite one person's stored EPF shares — how a zero-EPF month is made without inventing a rule. */
async function setEpf(employmentId: string, employer: number, employee: number) {
  const slips = await owner.db
    .select({ id: schema.payslip.id, statutory: schema.payslip.statutory })
    .from(schema.payslip)
    .where(eq(schema.payslip.employmentId, employmentId));
  expect(slips.length).toBeGreaterThan(0);
  for (const s of slips) {
    await owner.db
      .update(schema.payslip)
      .set({ statutory: { ...(s.statutory as Record<string, unknown>), epfEmployer: employer, epfEmployee: employee } })
      .where(eq(schema.payslip.id, s.id));
  }
}

/** The month's EPF straight off the stored payslips, in sen — the independent route to the form total. */
async function storedEpfSen(): Promise<number> {
  const slips = await owner.db
    .select({ statutory: schema.payslip.statutory })
    .from(schema.payslip)
    .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
    .where(and(eq(schema.payrollBatch.companyId, b.companyId), eq(schema.payrollBatch.payPeriod, PERIOD)));
  return slips.reduce((acc, x) => {
    const st = (x.statutory ?? {}) as Record<string, number>;
    return acc + Math.round(Number(st.epfEmployer ?? 0) * 100) + Math.round(Number(st.epfEmployee ?? 0) * 100);
  }, 0);
}

const rowOf = (rows: Record<string, unknown>[], name: string) => rows.find((r) => r.name === name);

describe('r418 — the identity number on Borang 8A, the EIS (SIP) schedule and Borang A', () => {
  it('the REPORTED case: a non-citizen with a passport and no IC is on Borang 8A AND Borang A, by passport, and blocks neither', async () => {
    await hire({ name: 'EMPLOYEE A', ic: '900101015555' });
    await hire({ name: 'EMPLOYEE D', ic: null, passport: 'PA1234567', citizenship: 'non_citizen', nationality: 'Australian' });
    await runMonth();

    const r8a = await view('my.borang-8a');
    expect(rowOf(r8a.rows, 'EMPLOYEE D')?.ic).toBe('PA1234567');
    expect(rowOf(r8a.rows, 'EMPLOYEE D')?.idKind).toBe('passport');
    // The stored IC field rides beside it for the ASSIST file, and it is empty.
    expect(rowOf(r8a.rows, 'EMPLOYEE D')?.icNumber).toBe('');
    expect(r8a.readiness.map((x) => x.name)).not.toContain('EMPLOYEE D');
    expect(r8a.readiness).toEqual([]);
    // The printed form, through the same reconstruction the loader uses.
    const f8a = borang8AFrom({ header: r8a.meta.formHeader, rows: r8a.rows });
    expect(f8a.pages.flatMap((p) => p.rows).find((x) => x.name === 'EMPLOYEE D')?.ic).toBe('PA1234567');

    const ra = await view('my.borang-a');
    expect(rowOf(ra.rows, 'EMPLOYEE D')?.ic).toBe('PA1234567');
    expect(ra.readiness).toEqual([]);
    const fa = borangAFrom({ header: ra.meta.formHeader, rows: ra.rows });
    expect(fa.pages.flatMap((p) => p.rows).find((x) => x.name === 'EMPLOYEE D')?.ic).toBe('PA1234567');

    // The EIS (SIP) schedule re-shapes the 8A read: if the run charged EPF D any EIS, his line is the
    // passport; either way he cannot hold the schedule for an identity number.
    const sip = await view('my.sip-contribution');
    const sipD = rowOf(sip.rows, 'EMPLOYEE D');
    if (sipD) expect(sipD.ic).toBe('PA1234567');
    expect(sip.readiness).toEqual([]);
    expect(rowOf(sip.rows, 'EMPLOYEE A')?.ic).toBe('900101015555');
  });

  it('a non-citizen WITHOUT a passport is held on both forms, named, with "Passport number"', async () => {
    await hire({ name: 'EMPLOYEE A', ic: '900101015555' });
    await hire({ name: 'NO PASSPORT', ic: null, citizenship: 'non_citizen', nationality: 'Australian' });
    await runMonth();

    const r8a = await view('my.borang-8a');
    expect(r8a.readiness).toEqual([
      expect.objectContaining({ name: 'NO PASSPORT', missing: ['Passport number'] }),
    ]);
    expect(rowOf(r8a.rows, 'NO PASSPORT')?.ic).toBe('');
    const ra = await view('my.borang-a');
    expect(ra.readiness).toEqual([
      expect.objectContaining({ name: 'NO PASSPORT', missing: ['Passport number'] }),
    ]);
  });

  it('a Singaporean recorded as a citizen with an IC keeps the IC; a permanent resident prints the IC field as MyPR', async () => {
    await hire({ name: 'SINGAPOREAN', ic: '880808085555', passport: 'K1234567', citizenship: 'citizen', nationality: 'Singaporean' });
    await hire({ name: 'PERMANENT RESIDENT', ic: '850505055555', citizenship: 'pr', nationality: 'Indonesian' });
    await hire({ name: 'NO STATUTORY ROW', noStatutoryRow: true });
    await runMonth();
    for (const id of ['my.borang-8a', 'my.borang-a']) {
      const r = await view(id);
      expect(rowOf(r.rows, 'SINGAPOREAN')?.ic, id).toBe('880808085555');
      expect(rowOf(r.rows, 'SINGAPOREAN')?.idKind, id).toBe('ic');
      expect(rowOf(r.rows, 'PERMANENT RESIDENT')?.ic, id).toBe('850505055555');
      expect(rowOf(r.rows, 'PERMANENT RESIDENT')?.idKind, id).toBe('mypr');
      // No statutory row at all: read as a citizen with nothing on file — named, with "IC", never dropped
      // for that reason (Borang A may leave them off for having no EPF; Borang 8A lists whoever SOCSO charged).
      const noRow = r.readiness.find((x) => x.name === 'NO STATUTORY ROW');
      if (rowOf(r.rows, 'NO STATUTORY ROW')) expect(noRow?.missing, id).toContain('IC');
    }
  });
});

describe('r418 — Borang A leaves off people with no EPF, before pagination', () => {
  async function fixture() {
    const names = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG'];
    const E: Record<string, string> = {};
    for (const [i, n] of names.entries()) {
      E[n] = (await hire({ name: n, ic: String(900101015500 + i), salary: 3000 + i * 250 })).employmentId;
    }
    await runMonth();
    // Two people with BOTH shares zero; one with only the employer share zero (stays).
    await setEpf(E.BBB, 0, 0);
    await setEpf(E.EEE, 0, 0);
    const [eee] = await owner.db
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, E.FFF));
    const fffEmployee = Number((eee.statutory as Record<string, number>).epfEmployee);
    expect(fffEmployee).toBeGreaterThan(0);
    await setEpf(E.FFF, 0, fffEmployee);
    return E;
  }

  it('drops the both-zero rows from rows, readiness, totals and the count; keeps a one-share-nonzero row', async () => {
    await fixture();
    const r = await view('my.borang-a');
    expect(r.rows.map((x) => x.name)).toEqual(['AAA', 'CCC', 'DDD', 'FFF', 'GGG']);
    expect(rowOf(r.rows, 'FFF')?.employer).toBe(0);
    expect(Number(rowOf(r.rows, 'FFF')?.employee)).toBeGreaterThan(0);
    const sen = (n: unknown) => Math.round(Number(n) * 100);
    expect(sen(r.totals.employer) + sen(r.totals.employee)).toBe(await storedEpfSen());
    expect(sen(r.totals.wage)).toBe(r.rows.reduce((a, x) => a + sen(x.wage), 0));
    // The reconciliation strip still agrees: the dropped people carried no EPF.
    const tile = (label: string) => Number((r.meta.summary ?? []).find((s) => s.label === label)!.value);
    expect(sen(tile('EPF in this run (EE+ER)'))).toBe(sen(tile('Amaun Caruman (form)')));
  });

  it('page totals, carry chain, Bil Pekerja and grand totals are worked out from the remaining rows at 1, 2 and 3 sheets', async () => {
    await fixture();
    const r = await view('my.borang-a');
    const stored = await storedEpfSen();
    for (const [perPage, sheets] of [
      [5, 1],
      [3, 2],
      [2, 3],
    ] as const) {
      const form = borangAFrom({ header: r.meta.formHeader, rows: r.rows, perPage });
      expect(form.pages.length, `perPage ${perPage}`).toBe(sheets);
      expect(form.employees).toBe(5);
      expect(form.pages.flatMap((p) => p.rows).map((x) => x.name)).toEqual(['AAA', 'CCC', 'DDD', 'FFF', 'GGG']);
      const sen = (n: number) => Math.round(n * 100);
      expect(form.pages.reduce((a, p) => a + sen(p.pageEmployer) + sen(p.pageEmployee), 0)).toBe(stored);
      expect(sen(form.totalContribution)).toBe(stored);
      const last = form.pages[form.pages.length - 1];
      expect(sen(last.carryOutEmployer)).toBe(sen(form.totalEmployer));
      expect(sen(last.carryOutEmployee)).toBe(sen(form.totalEmployee));
      for (let i = 1; i < form.pages.length; i += 1) {
        expect(form.pages[i].carryInEmployer).toBe(form.pages[i - 1].carryOutEmployer);
      }
      // The BBCD is the projection of exactly this form: its Amaun Caruman is the Borang A total.
      expect(borangBbcdFrom(form).amount).toBe(form.totalContribution);
      expect(sen(borangBbcdFrom(form).amount)).toBe(stored);
    }
  });

  it('a zero-EPF person with a gap is NOT a reason the form is held (they are not on it)', async () => {
    const E = await fixture();
    await owner.db
      .update(schema.employeeStatutoryMy)
      .set({ epfNumber: null })
      .where(
        eq(
          schema.employeeStatutoryMy.personId,
          (await owner.db.select({ p: schema.employment.personId }).from(schema.employment).where(eq(schema.employment.id, E.BBB)))[0].p,
        ),
      );
    const r = await view('my.borang-a');
    expect(r.readiness).toEqual([]);
    // r418 verify D2 — but they are NAMED: a zero from a data slip must not vanish without a word.
    const leftOff = (r.meta.notes ?? []).find((n) => n.startsWith('Not on this form'));
    expect(leftOff, 'the review screen names who was left off').toBeTruthy();
    expect(leftOff).toMatch(/BBB/i);
    expect(leftOff).toMatch(/EEE/i);
    expect(leftOff).not.toMatch(/AAA/i);
  });

  it('everybody zero: no rows remain, so the form’s "nothing to file" refusal applies', async () => {
    const E = await fixture();
    for (const id of Object.values(E)) await setEpf(id, 0, 0);
    const r = await view('my.borang-a');
    expect(r.meta.hasBatch).toBe(true);
    expect(r.rows).toEqual([]);
    expect(r.readiness).toEqual([]);
    expect(borangAHasContributions(r.rows)).toBe(false);
  });
});
