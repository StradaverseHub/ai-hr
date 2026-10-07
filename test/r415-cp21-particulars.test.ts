/**
 * r415 (item 79f3f64d, step 3) — `cp21Particulars`, the read behind the CP21, against a real payroll; the
 * routes and the event screen that reach it; and the proof that the CP22A and EA outputs did not move.
 *
 * THE FIXTURE IS TWO YEARS AND A DRAFT SLIP, because each way the year's sums can be wrong needs its own
 * slip to be wrong ON:
 *   2025-12 processed     — the PREVIOUS year: must not count.
 *   2026-01..03 processed — the year so far: must count.
 *   2026-04 DRAFT         — not yet processed: must not count ("processed payslips only").
 *   2026-05 processed     — AFTER the departure month (or after today): must not count.
 * Every slip's statutory pcb / zakat / epfEmployee is stamped to a distinct figure, so a wrongly included
 * slip shows up as a wrong total rather than as a coincidence.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { upsertCompanyStatutoryAuthority } from '../core/statutory-authority';
import {
  CP21_ESOS_ITEM,
  activeStaff,
  complianceWorklist,
  cp21LinesFrom,
  cp21Particulars,
  cp22aParticulars,
  employeeEaStatement,
} from '../core/reporting';
import { renderCp22aPdf } from '../lib/cp22a-pdf';
import { todayInKualaLumpur } from '../lib/hr-date';
import { MY_OFFICIAL_ARTWORK, MY_PLANNED_FORMS, MY_STATUTORY_LINKS } from '../localization/my/reports';

let scope: { s: SessionContext; scopeIds: string[] };
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  getLocale: async () => 'en',
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { GET as pdfGET } from '../app/payroll/cp21/[employmentId]/pdf/route';
import Cp21PreviewPage from '../app/payroll/cp21/[employmentId]/preview/page';
import EventPage from '../app/payroll/statutory-forms/event/page';
import { GET as continueGET } from '../app/payroll/statutory-forms/event/continue/route';

const ROOT = path.resolve(__dirname, '..');
const BASELINE = 'f6a540b0';
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const STAMP: Record<string, { pcb: number; zakat: number; epf: number }> = {
  '2025-12': { pcb: 7000, zakat: 700, epf: 7700 },
  '2026-01': { pcb: 100, zakat: 10, epf: 550 },
  '2026-02': { pcb: 200, zakat: 20, epf: 551 },
  '2026-03': { pcb: 300, zakat: 30, epf: 552 },
  '2026-04': { pcb: 4000, zakat: 400, epf: 4400 },
  '2026-05': { pcb: 5000, zakat: 500, epf: 5500 },
};
const PROCESSED = new Set(['2025-12', '2026-01', '2026-02', '2026-03', '2026-05']);

const thrown = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'did not throw';
};

const stable = async (bytes: Uint8Array): Promise<string> => {
  const doc = await PDFDocument.load(bytes);
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  return Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
};

let base: Base;
let employmentId: string;
let personId: string;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  const a = adminCtx(base);
  await owner.db.insert(schema.companyStatutoryMy).values({ tenantId: base.tenantId, companyId: base.companyId, lhdnEmployerNo: 'E 1234567890' });
  const e = await hireEmployee(a, {
    person: { fullName: 'Lim Wei Ming', primaryEmail: `weiming_${randomUUID()}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    positionId: base.positionId,
    employmentType: 'full_time',
    hiredOn: '2025-01-01',
  });
  employmentId = e.employmentId;
  personId = e.personId;
  await owner.db.update(schema.person).set({ nationality: 'Malaysian', dateOfBirth: '1990-01-01' }).where(eq(schema.person.id, personId));
  await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2025-01-01' });
  await setStatutoryProfileMY(a, { personId, icNumber: '900101101234', taxNumber: 'IG12345678090', taxCategory: 1, numChildren: 2 });
  for (const period of Object.keys(STAMP)) {
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(a, { batchId: batch.batchId });
    const st = STAMP[period];
    await owner.db
      .update(schema.payslip)
      .set({
        statutory: sql`coalesce(${schema.payslip.statutory}, '{}'::jsonb) || ${JSON.stringify({ pcb: st.pcb, zakat: st.zakat, epfEmployee: st.epf })}::jsonb`,
      })
      .where(and(eq(schema.payslip.batchId, batch.batchId), eq(schema.payslip.employmentId, employmentId)));
    await owner.db
      .update(schema.payrollBatch)
      .set({ status: PROCESSED.has(period) ? 'processed' : 'draft' })
      .where(eq(schema.payrollBatch.id, batch.batchId));
  }
  scope = { s: a, scopeIds: [base.companyId] };
});

describe('r415 · cp21Particulars — the year so far, from processed payroll, up to the departure month', () => {
  /**
   * NON-VACUITY: drop `processedOnly: true` from `lhdnYearSoFar`'s eaStatement call → D2 becomes 4600 (the
   * April draft counts); pass `today.slice(0, 7)` instead of `anchor.slice(0, 7)` as throughPeriod with
   * today 2026-06-10 → 5600 (May counts) on the first case.
   */
  it('sums D2 / D3 / D4 over 2026-01..03 only when leaving in April — not last year, not the draft, not May', async () => {
    const p = (await cp21Particulars(adminCtx(base), { employmentId, today: '2026-06-10', departureDate: '2026-04-15' }))!;
    expect(p).not.toBeNull();
    expect(p.year).toBe('2026');
    expect(p.deductions).toEqual({ pcb: 600, zakat: 60, epf: 1653 });
    expect(p.pay.from).toBe('2026-01-01');
    expect(p.pay.to).toBe('2026-03-31');
  });

  it('without a departure date, counts up to today’s month — May included once it is processed and past', async () => {
    const early = (await cp21Particulars(adminCtx(base), { employmentId, today: '2026-03-25' }))!;
    expect(early.deductions).toEqual({ pcb: 600, zakat: 60, epf: 1653 });
    const later = (await cp21Particulars(adminCtx(base), { employmentId, today: '2026-06-10' }))!;
    expect(later.deductions).toEqual({ pcb: 5600, zakat: 560, epf: 7153 });
    expect(later.pay.to).toBe('2026-05-31');
  });

  /** NON-VACUITY: pass `capAt: null` from cp21Particulars and this returns 2026-04-30. */
  it('caps "hingga" at the typed departure date once the departure month is processed', async () => {
    await owner.db
      .update(schema.payrollBatch)
      .set({ status: 'processed' })
      .where(and(eq(schema.payrollBatch.companyId, base.companyId), eq(schema.payrollBatch.payPeriod, '2026-04')));
    const p = (await cp21Particulars(adminCtx(base), { employmentId, today: '2026-06-10', departureDate: '2026-04-15' }))!;
    expect(p.pay.to).toBe('2026-04-15');
    expect(p.deductions!.pcb).toBe(4600);
  });

  it('takes the year from the departure date — a departure next year with nothing processed is blank', async () => {
    const p = (await cp21Particulars(adminCtx(base), { employmentId, today: '2026-06-10', departureDate: '2027-01-20' }))!;
    expect(p.year).toBe('2027');
    expect(p.pay).toEqual({ from: null, to: null, lines: {}, line11Items: [] });
    expect(p.deductions).toEqual({ pcb: null, zakat: null, epf: null });
  });

  it('takes line 1 from the EA engine over the same slips, and leaves unmapped lines out (blank)', async () => {
    const p = (await cp21Particulars(adminCtx(base), { employmentId, today: '2026-06-10', departureDate: '2026-04-15' }))!;
    const slips = await owner.db
      .select({ basic: schema.payslip.basicSalary, ot: schema.payslip.overtimePay, period: schema.payrollBatch.payPeriod })
      .from(schema.payslip)
      .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
      .where(eq(schema.payslip.employmentId, employmentId));
    const expected = slips
      .filter((s) => ['2026-01', '2026-02', '2026-03'].includes(s.period))
      .reduce((n, s) => n + Number(s.basic) + Number(s.ot ?? 0), 0);
    expect(expected).toBeGreaterThan(0);
    expect(p.pay.lines[1]).toBeCloseTo(expected, 2);
    expect(Object.keys(p.pay.lines).sort()).toEqual(['1', '3', '6']);
    expect(p.pay.line11Items).toEqual([]);
  });

  /** The line-6 rule, CP22A's, through the shared derivation. NON-VACUITY: drop `bearsTax` from the call → fails. */
  it('leaves line 6 blank when the employer bears the tax and no pay item carries it; A17 says Ya', async () => {
    const before = (await cp21Particulars(adminCtx(base), { employmentId, today: '2026-03-25' }))!;
    expect(before.employee.taxBorneByEmployer).toBe(false);
    expect(before.pay.lines[6]).not.toBeUndefined();
    await owner.db.update(schema.employeeStatutoryMy).set({ employerBearsTax: true }).where(eq(schema.employeeStatutoryMy.personId, personId));
    const p = (await cp21Particulars(adminCtx(base), { employmentId, today: '2026-03-25' }))!;
    expect(p.employee.taxBorneByEmployer).toBe(true);
    expect(p.pay.lines[6]).toBeUndefined();
  });

  /**
   * CP21 [Pin.1/2025] has no share-scheme line and its line 11 is CP22A's line 12. NON-VACUITY: drop the
   * `pay.esos` term from `cp21LinesFrom` and the first case fails (575 → 75); map CP22A's 10/11 across and
   * the second fails (a line with no source would appear).
   */
  it('renumbers CP22A’s lines onto CP21’s: 12 + ESOS → 11, named; absent stays absent; a zero stays a zero', () => {
    const full = cp21LinesFrom({ lines: { 1: 100, 3: 0, 6: 5, 12: 75 }, line12Items: ['Tunggakan gaji'], esos: 500 });
    expect(full.lines).toEqual({ 1: 100, 3: 0, 6: 5, 11: 575 });
    expect(full.line11Items).toEqual(['Tunggakan gaji', CP21_ESOS_ITEM]);
    const bare = cp21LinesFrom({ lines: { 1: 100 }, line12Items: [], esos: null });
    expect(bare).toEqual({ lines: { 1: 100 }, line11Items: [] });
    const esosOnly = cp21LinesFrom({ lines: { 1: 1 }, line12Items: [], esos: 0 });
    expect(esosOnly.lines[11], 'a mapped ESOS item that paid nothing is a fact, 0.00').toBe(0);
    expect(esosOnly.line11Items).toEqual([]);
  });

  it('fills the identity boxes from the records CP22 reads: IC, TIN, E number, nationality, title, joining date', async () => {
    const p = (await cp21Particulars(adminCtx(base), { employmentId, today: '2026-03-25' }))!;
    expect(p.employee.icNo).toBe('900101101234');
    expect(p.employee.taxNo).toBe('IG12345678090');
    expect(p.employer.eNumber).toBe('E 1234567890');
    expect(p.employee.citizen).toBe('Malaysian');
    expect(p.employee.dateOfBirth).toBe('1990-01-01');
    expect(p.employee.commencementDate).toBe('2025-01-01');
    const [pos] = await owner.db.select({ title: schema.position.title }).from(schema.position).where(eq(schema.position.id, base.positionId));
    expect(p.employee.natureOfEmployment).toBe(pos.title);
  });

  /**
   * A4 — the configured scheme: employment_tax_selection_my first, else the legacy profile.
   * NON-VACUITY: read only employee_statutory_my.tax_residency and the third case fails (the selection's
   * non_resident is ignored).
   */
  it('reads A4 from the configured tax scheme — resident Ya, non-resident Tidak, the selection winning', async () => {
    const a = adminCtx(base);
    expect((await cp21Particulars(a, { employmentId }))!.employee.resident).toBe(true);
    await owner.db.update(schema.employeeStatutoryMy).set({ taxResidency: 'non_resident', isResident: false }).where(eq(schema.employeeStatutoryMy.personId, personId));
    await owner.db.delete(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId, employmentId));
    expect((await cp21Particulars(a, { employmentId }))!.employee.resident).toBe(false);
    await owner.db.update(schema.employeeStatutoryMy).set({ taxResidency: 'resident', isResident: true }).where(eq(schema.employeeStatutoryMy.personId, personId));
    await owner.db.insert(schema.employmentTaxSelectionMy).values({
      tenantId: base.tenantId,
      employmentId,
      companyId: base.companyId,
      scheme: 'non_resident',
      transitionState: 'resolved',
      source: 'explicit',
      provenance: { reason: 'test', declarationIds: [] },
    });
    expect((await cp21Particulars(a, { employmentId }))!.employee.resident).toBe(false);
    await owner.db.update(schema.employmentTaxSelectionMy).set({ scheme: 'knowledge_worker', version: sql`${schema.employmentTaxSelectionMy.version} + 1` }).where(eq(schema.employmentTaxSelectionMy.employmentId, employmentId));
    expect((await cp21Particulars(a, { employmentId }))!.employee.resident).toBe(true);
  });

  it('leaves A4 and A17 blank (null) when there is no statutory record and no selection', async () => {
    await owner.db.delete(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId, employmentId));
    await owner.db.delete(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, personId));
    const p = (await cp21Particulars(adminCtx(base), { employmentId }))!;
    expect(p).not.toBeNull();
    expect(p.employee.resident).toBeNull();
    expect(p.employee.taxBorneByEmployer).toBeNull();
  });

  it('signs section E with the company’s LHDN signatory when one is set, else leaves it blank for an admin with no person', async () => {
    const a = adminCtx(base);
    expect((await cp21Particulars(a, { employmentId }))!.officer).toEqual({ name: null, designation: null, email: null });
    const officer = await hireEmployee(a, {
      person: { fullName: 'Siti Officer', primaryEmail: `siti_${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      positionId: base.positionId,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    await upsertCompanyStatutoryAuthority(a, { companyId: base.companyId, authority: 'lhdn', signatoryPersonId: officer.personId });
    const signed = (await cp21Particulars(a, { employmentId }))!;
    expect(signed.officer.name).toBe('Siti Officer');
    expect(signed.officer.email).toMatch(/^siti_/);
  });

  it('is still a CP21 for someone with a leaving date (they may still be leaving the country)', async () => {
    await owner.db.update(schema.employment).set({ terminatedOn: '2026-04-20', terminationType: 'voluntary' }).where(eq(schema.employment.id, employmentId));
    expect(await cp21Particulars(adminCtx(base), { employmentId })).not.toBeNull();
  });
});

describe('r415 · CP22A and the EA did not move — the base commit’s own read, run on the same payroll', () => {
  /**
   * The base commit's core/reporting.ts is written beside the current one (so its relative imports resolve
   * to this tree's modules) and imported as it stood. Its cp22aParticulars and employeeEaStatement and
   * this branch's are run on the same record. Equal objects, and byte-identical CP22A PDFs.
   * NON-VACUITY: change `lines[3] = r2(b.bonus + b.directorFee)` in lhdnYearSoFar to `r2(b.bonus)` with a
   * director fee on a slip, or drop the capAt cap, and the CP22A comparison fails.
   */
  it('cp22aParticulars, its rendered PDF and the EA are identical to the base commit’s', async () => {
    const tmp = path.join(ROOT, 'core', `__r415_baseline_reporting_${process.pid}.ts`);
    fs.writeFileSync(tmp, execFileSync('git', ['show', `${BASELINE}:core/reporting.ts`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }));
    try {
      const then = (await import(tmp)) as typeof import('../core/reporting');
      const a = adminCtx(base);
      // A leaver with a death and a retirement exercised elsewhere; here a resignation in April, before and after
      // the April payroll is processed (the "hingga" cap), and with the employer bearing the tax (line 6).
      await owner.db.update(schema.employment).set({ terminatedOn: '2026-04-20', terminationType: 'voluntary' }).where(eq(schema.employment.id, employmentId));
      const template = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public', 'forms', 'cp22a-pin-1-2023.pdf')));
      const compare = async (label: string) => {
        const now = await cp22aParticulars(a, { employmentId, today: '2026-03-25' });
        const old = await then.cp22aParticulars(a, { employmentId, today: '2026-03-25' });
        expect(now, label).not.toBeNull();
        expect(now, label).toEqual(old);
        const [x, y] = await Promise.all([renderCp22aPdf(template, now!), renderCp22aPdf(template, old!)]);
        const [sx, sy] = [await stable(x), await stable(y)];
        expect(sx.length, label).toBeGreaterThan(100_000);
        expect(sx === sy, label).toBe(true);
        for (const year of ['2025', '2026']) {
          expect(await employeeEaStatement(a, { employmentId, year }), `${label} EA ${year}`).toEqual(
            await then.employeeEaStatement(a, { employmentId, year }),
          );
        }
      };
      await compare('resigned, April draft');
      await owner.db.update(schema.payrollBatch).set({ status: 'processed' }).where(and(eq(schema.payrollBatch.companyId, base.companyId), eq(schema.payrollBatch.payPeriod, '2026-04')));
      await compare('April processed (hingga capped)');
      await owner.db.update(schema.employeeStatutoryMy).set({ employerBearsTax: true }).where(eq(schema.employeeStatutoryMy.personId, personId));
      await compare('employer bears tax (line 6)');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    expect(fs.existsSync(tmp)).toBe(false);
  });

  /**
   * The EA engine is `eaStatement` in localization/my/reports.ts plus the routing, non-cash and reporting
   * modules and the payroll kernel. reports.ts changed in this round (the catalog), so the engine is held by
   * its own SLICE, found and long; everything else by its whole file. lib/ea-pdf.ts changed in one comment.
   */
  it('the EA engine is byte-identical to the base commit (eaStatement by slice; lib/ea-pdf.ts but for a comment)', () => {
    const show = (f: string) => execFileSync('git', ['show', `${BASELINE}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
    for (const f of ['localization/my/ea-routing.ts', 'localization/my/ea-noncash.ts', 'localization/my/ea-reporting.ts', 'core/payroll.ts']) {
      const now = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(now.length, f).toBeGreaterThan(1000);
      expect(now === show(f), f).toBe(true);
    }
    const slice = (src: string) => {
      const start = src.indexOf('export async function eaStatement(');
      const end = src.indexOf('\n}\n', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return src.slice(start, end);
    };
    const now = slice(fs.readFileSync(path.join(ROOT, 'localization/my/reports.ts'), 'utf8'));
    expect(now.length).toBeGreaterThan(3000);
    expect(now).toBe(slice(show('localization/my/reports.ts')));
    const ea = fs.readFileSync(path.join(ROOT, 'lib/ea-pdf.ts'), 'utf8');
    expect(code(ea).length).toBeGreaterThan(2000);
    expect(code(ea)).toBe(code(show('lib/ea-pdf.ts')));
  });
});

describe('r415 · the PDF route and the preview', () => {
  const pdfCall = (id: string, qs = 'inline=1') =>
    pdfGET(new Request(`http://localhost/payroll/cp21/${id}/pdf?${qs}`), { params: Promise.resolve({ employmentId: id }) });

  it('serves the CP21 — two pages of LHDN’s A4 form — to an admin scoped to that company', async () => {
    const res = await pdfCall(employmentId, 'inline=1&a3=2026-04-15&a18=yes');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const doc = await PDFDocument.load(Buffer.from(await res.arrayBuffer()));
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize().width).toBeCloseTo(595.32, 2);
    const f = doc.getForm();
    expect(f.getTextField('departureDate').getText()).toBe('15');
    expect(f.getTextField('schemeYes').getText()).toBe('X');
  });

  /**
   * ⚠️ THE CROSS-COMPANY REFUSAL. NON-VACUITY: delete the `scopeIds.includes(...)` line in
   * app/payroll/cp21/[employmentId]/pdf/route.ts and the PDF case returns 200; delete
   * `|| !scopeIds.includes(particulars.companyId)` from the preview page and it renders.
   */
  it('is a bare 404 — PDF and preview — to an admin scoped to ANOTHER company', async () => {
    const [fc] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: `Foreign ${randomUUID().slice(0, 6)}`, country: 'MY' })
      .returning({ id: schema.company.id });
    scope = { s: adminCtx(base), scopeIds: [fc.id] };
    const res = await pdfCall(employmentId);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
    const props = { params: Promise.resolve({ employmentId }), searchParams: Promise.resolve({}) };
    expect(await thrown(Cp21PreviewPage(props))).toBe('NEXT_NOT_FOUND');
  });

  it('is the same bare 404 for a malformed id and for an unknown one', async () => {
    expect((await pdfCall('not-a-uuid')).status).toBe(404);
    expect((await pdfCall(randomUUID())).status).toBe(404);
    expect(await thrown(Cp21PreviewPage({ params: Promise.resolve({ employmentId: randomUUID() }), searchParams: Promise.resolve({}) }))).toBe('NEXT_NOT_FOUND');
  });

  it('the preview renders the A4 viewer, carries the typed answers, and names what it dropped', async () => {
    const html = renderToStaticMarkup(
      await Cp21PreviewPage({
        params: Promise.resolve({ employmentId }),
        searchParams: Promise.resolve({ a3: '2026-04-15', a16: '2026-04-01', a18: 'yes' }),
      }),
    );
    expect(html).toContain('data-statutory-pdf-viewer');
    expect(html).toContain('aspect-[210/297]');
    expect(html).toContain(`/payroll/cp21/${employmentId}/pdf?a3=2026-04-15&amp;a18=yes&amp;inline=1`);
    // A return before the departure is dropped AND said to be dropped.
    expect(html).toContain('data-cp21-rejected');
    expect(html).toContain('rejectedNote:{&quot;codes&quot;:&quot;A16&quot;}');
    expect(html).toContain('data-cp21-blanks');
    expect(html).toContain('periodNoteDeparture');
  });

  it('page and PDF route both run the company-scope check (source guard; slice found and long)', () => {
    for (const f of ['app/payroll/cp21/[employmentId]/preview/page.tsx', 'app/payroll/cp21/[employmentId]/pdf/route.ts']) {
      const src = code(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      expect(src.length, f).toBeGreaterThan(800);
      expect(src, f).toMatch(/scopeIds\.includes\(particulars\.companyId\)/);
      expect(src, f).toContain('scopedAdmin()');
    }
  });
});

describe('r415 · the event screen lists every ACTIVE employee for CP21', () => {
  // The screen reads the tenant's clock (todayInKualaLumpur), so the fixture does too — never a UTC slice.
  const today = todayInKualaLumpur();
  const dayOffset = (n: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  beforeEach(async () => {
    const a = adminCtx(base);
    const hire = async (name: string, hiredOn: string) =>
      (
        await hireEmployee(a, {
          person: { fullName: name, primaryEmail: `${name.split(' ')[0].toLowerCase()}_${randomUUID()}@acme.test` },
          companyId: base.companyId,
          departmentId: base.deptA,
          positionId: base.positionId,
          employmentType: 'full_time',
          hiredOn,
        })
      ).employmentId;
    const gone = await hire('Gone Already', '2020-01-01');
    await owner.db.update(schema.employment).set({ terminatedOn: dayOffset(-3), terminationType: 'voluntary' }).where(eq(schema.employment.id, gone));
    const notice = await hire('Serving Notice', '2020-01-01');
    await owner.db.update(schema.employment).set({ terminatedOn: dayOffset(20), terminationType: 'voluntary' }).where(eq(schema.employment.id, notice));
    await hire('Future Joiner', dayOffset(10));
  });

  /** NON-VACUITY: drop the `terminatedOn` clause from `activeStaff` and "Gone Already" is listed. */
  it('activeStaff: on the payroll today — not someone who left, not someone yet to join; notice-servers stay', async () => {
    const names = (await activeStaff(adminCtx(base), { companyId: base.companyId, today })).map((r) => r.name);
    expect(names).toContain('Lim Wei Ming');
    expect(names).toContain('Serving Notice');
    expect(names).not.toContain('Gone Already');
    expect(names).not.toContain('Future Joiner');
    expect([...names].sort((x, y) => x.localeCompare(y))).toEqual(names.slice().sort((x, y) => x.localeCompare(y)));
    const hit = await activeStaff(adminCtx(base), { companyId: base.companyId, today, nameQuery: 'wei MING' });
    expect(hit.map((r) => r.name)).toEqual(['Lim Wei Ming']);
  });

  it('the screen draws them with name, position and joining date — no event, due date or status', async () => {
    const html = renderToStaticMarkup(await EventPage({ searchParams: Promise.resolve({ form: 'my.cp21', companyId: base.companyId }) }));
    expect(html).toContain('data-event-active');
    expect(html).toContain('Lim Wei Ming');
    expect(html).toContain('Serving Notice');
    expect(html).not.toContain('Gone Already');
    expect(html).toContain(`value="${employmentId}"`);
    for (const col of ['colName', 'colPosition', 'colJoined', 'colSelect', 'windowActive']) expect(html).toContain(col);
    for (const col of ['colDueBy', 'colStatus', 'colEventDate']) expect(html).not.toContain(col);
    expect(html).toContain('01/01/2025');
  });

  it('says why an empty search is empty and disables Continue', async () => {
    const html = renderToStaticMarkup(await EventPage({ searchParams: Promise.resolve({ form: 'my.cp21', companyId: base.companyId, q: 'nobody' }) }));
    expect(html).toContain('data-event-empty');
    expect(html).toContain('emptySearch');
    expect(html).toMatch(/<button data-event-continue="true" disabled=""/);
  });

  it('CP22A’s list on the same screen is still the worklist’s leavers — the notice-server, not the whole staff', async () => {
    const html = renderToStaticMarkup(await EventPage({ searchParams: Promise.resolve({ form: 'my.cp22a', companyId: base.companyId }) }));
    expect(html).not.toContain('data-event-active');
    expect(html).toContain('Serving Notice');
    expect(html).not.toContain('Lim Wei Ming');
    const rows = await complianceWorklist(adminCtx(base), { companyId: base.companyId, form: 'CP22A' });
    expect(rows.map((r) => r.name).sort()).toEqual(['Gone Already', 'Serving Notice']);
  });

  it('Continue sends a chosen CP21 employee to the CP21 viewer, the catalog’s path', async () => {
    expect(await thrown(continueGET(new Request(`http://localhost/payroll/statutory-forms/event/continue?form=my.cp21&employmentId=${employmentId}`)))).toBe(
      `NEXT_REDIRECT:/payroll/cp21/${employmentId}/preview`,
    );
  });
});

describe('r415 · the catalog', () => {
  it('CP21 left MY_PLANNED_FORMS and joined MY_STATUTORY_LINKS at the same shelf position, official', () => {
    expect(MY_PLANNED_FORMS.map((p) => p.id)).not.toContain('lhdn.cp21');
    const cp21 = MY_STATUTORY_LINKS.find((l) => l.id === 'my.cp21')!;
    expect(cp21).toBeDefined();
    expect(cp21.shelfOrder).toBe(8);
    expect(cp21.body).toBe('lhdn');
    expect(cp21.fidelity).toBe('official');
    expect(cp21.event).toEqual({ form: 'CP21', previewPath: '/payroll/cp21/{employmentId}/preview', people: 'active' });
    expect(MY_OFFICIAL_ARTWORK.find((o) => o.id === 'my.cp21')).toEqual({
      id: 'my.cp21',
      edition: 'CP21 [Pin.1/2025]',
      artwork: 'public/forms/cp21-pin-1-2025.pdf',
      fieldMap: 'lib/cp21-fields.ts',
    });
  });

  it('retires the planned keys in all six catalogues and gives every locale its own CP21 text', () => {
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8'));
    for (const l of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'));
      const sf = m.payroll.statutoryForms;
      expect(sf.planned_lhdn_cp21, l).toMatch(/^\[retired r415/);
      expect(sf.planned_lhdn_cp21_hint, l).toMatch(/^\[retired r415/);
      expect(sf.link_cp21, l).toMatch(/^CP21/);
      expect(Object.keys(m.payroll.cp21).sort(), l).toEqual(Object.keys(en.payroll.cp21).sort());
      if (l !== 'en') expect(sf.link_cp21_hint, `${l} is still English`).not.toBe(en.payroll.statutoryForms.link_cp21_hint);
    }
    // And no source still asks for a retired key.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && /'planned_lhdn_cp21(_hint)?'/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    for (const d of ['app', 'components', 'lib', 'core', 'localization']) walk(path.join(ROOT, d));
    expect(hits).toEqual([]);
  });
});
