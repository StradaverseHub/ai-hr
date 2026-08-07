/**
 * 6babf4f6 — DOES THE NEW PER-FORM STATUTORY SCREEN LEAK ANOTHER COMPANY'S RETURN?
 *
 * Verification flagged an asymmetry that is real and visible in the diff: the export route fences with
 * `scopedAdmin` + `scopeIds.includes(companyId)`, while the page beside it calls `requireAdmin()` and takes
 * `companyId` straight off the query string.
 *
 * Whether that EXPOSES anything is a separate question from whether the check is missing, and this session
 * has already been wrong about one of these in each direction. So: measure.
 *
 * payroll_batch's RLS is
 *   tenant_id = current_tenant
 *   AND (can_admin_payroll_for(company_id) OR EXISTS(payslip in batch the caller can_see_employment))
 * and can_admin_payroll_for = is_admin_for(company) OR has_role_for('payroll_partner', company).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as schema from '../db/schema';
import { reportPreview } from '../core/reporting';
import { listCompanies } from '../core/read';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';

let b: Base;
let otherCompanyId: string;

beforeAll(async () => { await migrateTestDb(); });
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Other Payroll Sdn Bhd', country: 'MY' })
    .returning({ id: schema.company.id });
  otherCompanyId = c.id;
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: otherCompanyId, name: 'Other Ops' })
    .returning({ id: schema.department.id });
  // A real payroll run in the OTHER company: a return that WOULD carry names, ICs and contributions.
  const a = adminCtx(b);
  const E = await hireEmployee(a, {
    person: { fullName: 'Outsider Payroll', primaryEmail: `op_${randomUUID().slice(0, 8)}@t.local` },
    companyId: otherCompanyId, departmentId: d.id, employmentType: 'full_time', hiredOn: '2020-01-01',
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: 5000, effectiveFrom: '2020-01-01' });
  await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101015555', taxCategory: 1, numChildren: 0 });
  const batch = await createBatch(a, { companyId: otherCompanyId, payPeriod: '2026-01' });
  await generatePayslips(a, { batchId: batch.batchId });
});

/** An admin granted ONLY the base company. */
const scopedToBase = (): SessionContext => ({
  tenantId: b.tenantId, userId: b.adminUserId, roles: ['hr_admin'],
  grants: [{ role: 'hr_admin', companyId: b.companyId }],
});

describe('6babf4f6 — the per-form screen takes companyId from the URL with no membership check', () => {
  it('the report read itself returns NOTHING for a company the admin does not administer', async () => {
    // If this returns rows, the missing page check is the ONLY thing between a scoped admin and another
    // company's statutory return, and it is a live exposure.
    const rep = await reportPreview(scopedToBase(), {
      companyId: otherCompanyId, reportId: 'my.cp39', periodKey: '2026-01',
    });
    expect(rep.rows, 'an out-of-scope company must yield no employee rows').toEqual([]);
  });

  it('and returns the real thing for a company it DOES administer', async () => {
    const a = adminCtx(b);
    const E = await hireEmployee(a, {
      person: { fullName: 'Inside Payroll', primaryEmail: `ip_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01',
    });
    await setCompensation(a, { employmentId: E.employmentId, basicSalary: 4000, effectiveFrom: '2020-01-01' });
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900202025555', taxCategory: 1, numChildren: 0 });
    const batch = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: batch.batchId });
    const rep = await reportPreview(scopedToBase(), {
      companyId: b.companyId, reportId: 'my.cp39', periodKey: '2026-01',
    });
    expect(rep.rows.length, 'the guard must not refuse everything').toBeGreaterThan(0);
  });

  it('listCompanies IS tenant-wide — which is why the PAGE has to narrow it, not trust it', async () => {
    // The measured fact behind the fix. listCompanies returns every company in the tenant, so the picker
    // offered one this admin cannot administer; choosing it rendered an EMPTY return under that company's
    // name while the export route 404'd on the same selection. The page now filters by scopeIds itself.
    // Asserting the raw read here rather than "the dropdown is safe" keeps the reason visible: if
    // listCompanies is ever scoped at source, this fails and the page's filter can be reconsidered.
    const visible = await listCompanies(scopedToBase());
    expect(visible.map((c) => c.id), 'listCompanies is deliberately tenant-wide').toContain(otherCompanyId);
  });

  it('the PAGE narrows to the admin scope, so its picker and its export cannot disagree', async () => {
    // The behaviour that actually changed: source-level, because the page is a 200-line server component
    // whose render needs a session mock. What matters is that BOTH the option list and the honoured
    // companyId go through scopeIds — the export route has always done that.
    const src = readFileSync(
      new URL('../app/payroll/statutory-forms/[formId]/page.tsx', import.meta.url), 'utf8',
    );
    expect(src, 'must not use the unscoped session helper').not.toMatch(/await requireAdmin\(\)/);
    expect(src, 'options filtered to the admin scope').toMatch(/scopeIds\.includes\(c\.id\)/);
    expect(src, 'a URL companyId is only honoured inside the scope').toMatch(/sp\.companyId && scopeIds\.includes\(sp\.companyId\)/);
  });
});
