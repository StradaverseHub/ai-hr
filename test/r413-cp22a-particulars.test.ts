/**
 * r413 (item 79f3f64d, step 2) — `cp22aParticulars`, the read behind the CP22A, against a real payroll.
 *
 * THE FIXTURE IS TWO YEARS AND A MID-YEAR LEAVER, because each of the four ways the year's sums can be
 * wrong needs its own slip to be wrong ON:
 *   2025-12 processed  — the PREVIOUS year: must not count.
 *   2026-01..03 processed — the year so far: must count, and 2026-03 is the last processed period.
 *   2026-04 DRAFT      — the leaving month, not yet processed: must not count ("processed payroll only").
 *   2026-05 processed  — AFTER the leaving month: must not count ("pay_period up to the cessation month").
 * Every slip's statutory pcb / zakat / epfEmployee is stamped to a distinct known figure, so a wrongly
 * included slip shows up as a wrong total rather than as a coincidence.
 *
 * And the route: a company-scoped admin cannot open another company's leaver — a bare 404.
 */
import { randomUUID } from 'node:crypto';
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
import { cp22aParticulars, employeeEaStatement } from '../core/reporting';

let scope: { s: SessionContext; scopeIds: string[] };
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
import { GET as pdfGET } from '../app/payroll/cp22a/[employmentId]/pdf/route';

/** The stamped figures per period — distinct, so a wrongly included slip cannot hide in a total. */
const STAMP: Record<string, { pcb: number; zakat: number; epf: number }> = {
  '2025-12': { pcb: 7000, zakat: 700, epf: 7700 },
  '2026-01': { pcb: 100, zakat: 10, epf: 550 },
  '2026-02': { pcb: 200, zakat: 20, epf: 551 },
  '2026-03': { pcb: 300, zakat: 30, epf: 552 },
  '2026-04': { pcb: 4000, zakat: 400, epf: 4400 },
  '2026-05': { pcb: 5000, zakat: 500, epf: 5500 },
};
const PROCESSED = new Set(['2025-12', '2026-01', '2026-02', '2026-03', '2026-05']);

describe('r413 · cp22aParticulars — the year so far, from processed payroll, up to the leaving month', () => {
  let base: Base;
  let employmentId: string;
  let personId: string;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    const a = adminCtx(base);
    await owner.db.insert(schema.companyStatutoryMy).values({
      tenantId: base.tenantId,
      companyId: base.companyId,
      lhdnEmployerNo: 'E 1234567890',
    });
    const e = await hireEmployee(a, {
      person: { fullName: 'Nur Aisyah binti Rahman', primaryEmail: `aisyah_${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      positionId: base.positionId,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    employmentId = e.employmentId;
    personId = e.personId;
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
    // The leaving date is recorded AFTER the slips exist, so the 2026-05 slip is there to be excluded.
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-04-20', terminationType: 'voluntary' })
      .where(eq(schema.employment.id, employmentId));
  });
  afterAll(async () => {
    await closeAll();
  });

  /**
   * NON-VACUITY (mutation-checked in r413): drop `processedOnly: true` from the `eaStatement` call in
   * cp22aParticulars → D2 becomes 4600 (the April draft counts); drop `throughPeriod` → 5600 (May counts);
   * replace the year filter… the 2025-12 slip is already outside `like(year-%)`.
   */
  it('sums D2 / D3 / D4 over 2026-01..03 only — not last year, not the draft, not after leaving', async () => {
    const p = (await cp22aParticulars(adminCtx(base), { employmentId, today: '2026-03-25' }))!;
    expect(p).not.toBeNull();
    expect(p.year).toBe('2026');
    expect(p.deductions).toEqual({ pcb: 600, zakat: 60, epf: 1653 });
  });

  it('dates section B from 1 January to the END OF THE LAST PROCESSED PERIOD, not the leaving date', async () => {
    const p = (await cp22aParticulars(adminCtx(base), { employmentId, today: '2026-03-25' }))!;
    expect(p.pay.from).toBe('2026-01-01');
    expect(p.pay.to).toBe('2026-03-31');
    expect(p.employee.cessationDate).toBe('2026-04-20');
  });

  it('takes line 1 from the EA engine over the same three slips, and leaves unmapped lines out (blank)', async () => {
    const a = adminCtx(base);
    const p = (await cp22aParticulars(a, { employmentId, today: '2026-03-25' }))!;
    // The three processed 2026 slips' basic + overtime, read straight off the slips.
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
    // Lines 1, 3 and 6 always have a source; nothing is mapped to gratuity, compensation, pension, BIK,
    // accommodation, the line-12 parts or ESOS — so those are ABSENT (blank on the form), not 0.
    expect(Object.keys(p.pay.lines).sort()).toEqual(['1', '3', '6']);
    expect(p.pay.esos).toBeNull();
    // The EA itself is untouched by the narrowing: the whole year, drafts and May included.
    const ea = (await employeeEaStatement(a, { employmentId, year: '2026' }))!;
    expect(ea.partD.mtd).toBe(100 + 200 + 300 + 4000 + 5000);
  });

  it('fills the identity boxes from the same records CP22 reads, and the EA’s item-8 child count', async () => {
    const p = (await cp22aParticulars(adminCtx(base), { employmentId, today: '2026-03-25' }))!;
    expect(p.employee.icNo).toBe('900101101234');
    expect(p.employee.taxNo).toBe('IG12345678090');
    expect(p.employer.eNumber).toBe('E 1234567890');
    expect(p.employee.childrenCount).toBe(2);
    expect(p.employee.cessation).toBe('resigned');
  });

  it('maps a death and a retirement onto A2 from the recorded termination type', async () => {
    for (const [type, kind] of [['death', 'death'], ['retired', 'retired'], ['involuntary', 'resigned']] as const) {
      await owner.db.update(schema.employment).set({ terminationType: type }).where(eq(schema.employment.id, employmentId));
      const p = (await cp22aParticulars(adminCtx(base), { employmentId }))!;
      expect(p.employee.cessation, type).toBe(kind);
    }
  });

  it('is null for an employment with no leaving date — no CP22A about an event that is not recorded', async () => {
    await owner.db.update(schema.employment).set({ terminatedOn: null }).where(eq(schema.employment.id, employmentId));
    expect(await cp22aParticulars(adminCtx(base), { employmentId })).toBeNull();
  });

  it('leaves B and D blank when no payroll has been processed in the leaving year yet', async () => {
    await owner.db.update(schema.payrollBatch).set({ status: 'draft' }).where(eq(schema.payrollBatch.companyId, base.companyId));
    const p = (await cp22aParticulars(adminCtx(base), { employmentId }))!;
    expect(p.pay).toEqual({ from: null, to: null, lines: {}, line12Items: [], esos: null });
    expect(p.deductions).toEqual({ pcb: null, zakat: null, epf: null });
  });

  it('signs section E with the company’s LHDN signatory when one is set, else leaves it to the session', async () => {
    const a = adminCtx(base);
    const bare = (await cp22aParticulars(a, { employmentId }))!;
    // adminCtx has no person behind it, so with no signatory the box is blank — never the company name.
    expect(bare.officer).toEqual({ name: null, designation: null, email: null });
    const officer = await hireEmployee(a, {
      person: { fullName: 'Siti Officer', primaryEmail: `siti_${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      positionId: base.positionId,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    await upsertCompanyStatutoryAuthority(a, { companyId: base.companyId, authority: 'lhdn', signatoryPersonId: officer.personId });
    const signed = (await cp22aParticulars(a, { employmentId }))!;
    expect(signed.officer.name).toBe('Siti Officer');
    expect(signed.officer.email).toMatch(/^siti_/);
  });

  describe('the PDF route', () => {
    const url = (id: string) => new Request(`http://localhost/payroll/cp22a/${id}/pdf?inline=1`);
    const call = (id: string) => pdfGET(url(id), { params: Promise.resolve({ employmentId: id }) });

    it('serves the leaver’s CP22A — two pages of LHDN’s US Letter form — to an admin scoped to that company', async () => {
      scope = { s: adminCtx(base), scopeIds: [base.companyId] };
      const res = await call(employmentId);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/pdf');
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      const doc = await PDFDocument.load(Buffer.from(await res.arrayBuffer()));
      expect(doc.getPageCount()).toBe(2);
      expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    });

    /**
     * ⚠️ THE CROSS-COMPANY REFUSAL. An hr_admin grant on ANY company makes `isAdmin` true; RLS alone lets
     * a tenant admin read every company. Only the scope check stands between a company-B admin and a
     * company-A leaver's IC, TIN and pay. NON-VACUITY: delete the `scopeIds.includes(...)` line in
     * app/payroll/cp22a/[employmentId]/pdf/route.ts and this returns 200 (mutation-checked in r413).
     */
    it('is a bare 404 to an admin scoped to ANOTHER company', async () => {
      const [fc] = await owner.db
        .insert(schema.company)
        .values({ tenantId: base.tenantId, legalName: `Foreign ${randomUUID().slice(0, 6)}`, country: 'MY' })
        .returning({ id: schema.company.id });
      scope = { s: adminCtx(base), scopeIds: [fc.id] };
      const res = await call(employmentId);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('Not found');
    });

    it('is the same bare 404 for a malformed id and for an unknown one', async () => {
      scope = { s: adminCtx(base), scopeIds: [base.companyId] };
      expect((await call('not-a-uuid')).status).toBe(404);
      expect((await call(randomUUID())).status).toBe(404);
    });
  });
});
