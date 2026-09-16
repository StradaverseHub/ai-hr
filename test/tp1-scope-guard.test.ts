/**
 * 3e3d3fb2 — CAN A COMPANY-SCOPED ADMIN REACH ANOTHER COMPANY'S TP1 DECLARATION?
 *
 * The approved plan calls this a SECURITY GAP: app/payroll/transactions/tp1/page.tsx passes
 * `?employmentId=` straight into employmentSubject() with no membership check, where every sibling
 * transaction screen runs `employees.some(...)` against the admin's scoped list first.
 *
 * IT DOES NOT HOLD, and this file is the evidence. Every exposure the plan implies was attempted here and
 * the database refused it. Reproduced before agreeing, which is this repo's standing rule precisely
 * because the reported fault so often is not the real one.
 * `employment`'s RLS is
 *     tenant_id = current_tenant
 *     AND (can_see_employment(id) OR can_admin_payroll_for(company_id) OR can_admin_perfcomp_for(company_id))
 * and BOTH of those helpers are company-scoped through app.is_admin_for(). If RLS fails closed, the page
 * guard is defence-in-depth and the plan's wording is overstated; if it does not, it is a live hole.
 *
 * This file answers that with a read, not an argument.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { employmentSubject } from '../core/read';
import { hireEmployee, setReportingLine } from '../core/org';
import { adminCtx, closeAll, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';

import { vi } from 'vitest';

let scope: { s: SessionContext; scopeIds: string[] };
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
// `getLocale` joins `getTranslations` here because the TP1 list resolves its MONTH NAMES through
// Intl in the request's locale (7ad37961) rather than from a message catalogue — twelve month
// names in six catalogues would be six copies of the calendar.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
  getLocale: vi.fn(async () => 'en'),
}));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));

import Tp1TransactionPage from '../app/payroll/transactions/tp1/page';

let b: Base;
let otherCompanyId: string;
let outsiderEmploymentId: string;

beforeAll(async () => { await migrateTestDb(); });
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: `Other ${randomUUID().slice(0, 6)}`, country: 'MY' })
    .returning({ id: schema.company.id });
  otherCompanyId = c.id;
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: otherCompanyId, name: 'Other Ops' })
    .returning({ id: schema.department.id });
  const hire = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Outsider', primaryEmail: `out_${randomUUID().slice(0, 8)}@t.local` },
    companyId: otherCompanyId,
    departmentId: d.id,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  outsiderEmploymentId = hire.employmentId;
});

/** An admin whose grant covers ONLY the base company — the shape db/client.ts publishes as app.grants. */
const scopedToBase = (): SessionContext => ({
  tenantId: b.tenantId,
  userId: b.adminUserId,
  roles: ['hr_admin'],
  grants: [{ role: 'hr_admin', companyId: b.companyId }],
  // r292 — a REAL snapshot: the TP1 page reads core/payroll-view.ts, which is module-gated now
  // (core/module-gate.ts). This file is about COMPANY SCOPE, so the tenant must hold Payroll or the
  // green below would be pinning an entitlement refusal instead of the scope guard it names.
  entitlements: harnessSnapshot(b.tenantId),
});

describe('3e3d3fb2 — the TP1 screen’s employmentId, against the database', () => {
  it('employmentSubject REFUSES an employment outside the admin’s company scope', async () => {
    // If this returns a row, the page guard the plan asks for is the ONLY thing standing between a
    // company-scoped admin and another company's tax declaration, and the plan's wording is right.
    const subject = await employmentSubject(scopedToBase(), outsiderEmploymentId);
    expect(subject, 'RLS must fail closed on an out-of-scope employment').toBeNull();
  });

  it('and ALLOWS one inside it — the guard must not refuse everything', async () => {
    const inside = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Insider', primaryEmail: `in_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    const subject = await employmentSubject(scopedToBase(), inside.employmentId);
    expect(subject?.employmentId).toBe(inside.employmentId);
  });

  it('EVEN a manager of an out-of-scope employee is refused — the page guard is defence in depth', async () => {
    /**
     * This is the case that decides whether the guard is a real narrowing or decoration.
     *
     * can_see_employment does not only ask is_admin_for(company). It also returns true through the
     * administrative-manager and head-of-department branches, which cross company boundaries BY DESIGN —
     * a manager should see their own report. So an hr_admin scoped to company A who line-manages somebody
     * in company B passes RLS for that person. Fine for a profile screen. Wrong for a tax declaration,
     * and the sibling screens' `employees.some(...)` against the COMPANY-scoped picker list refuses it.
     */
    // A real login bound to a real person with an employment in company A.
    const [mgrPerson] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Scoped Manager', primaryEmail: `mgr_${randomUUID().slice(0, 8)}@t.local` })
      .returning({ id: schema.person.id });
    const [mgrEmp] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, personId: mgrPerson.id, companyId: b.companyId, hiredOn: '2019-01-01' })
      .returning({ id: schema.employment.id });
    const [mgrUser] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: b.tenantId, workosUserId: `wos_${randomUUID().slice(0, 8)}`, personId: mgrPerson.id })
      .returning({ id: schema.appUser.id });

    // …who administratively manages the OUTSIDER, who sits in the other company.
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: outsiderEmploymentId,
      managerEmploymentId: mgrEmp.id,
      lineType: 'administrative',
      validFrom: '2020-01-01',
    });

    const mgrCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: mgrUser.id,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: b.companyId }],
      entitlements: harnessSnapshot(b.tenantId), // r292 — see scopedToBase above.
    };

    // MEASURED, AND IT REFUSES. The plan predicted this branch would let a manager cross the company
    // boundary; it does not. Whatever app.is_admin_report_of requires, a reporting line alone is not
    // enough to surface an employment outside the caller's admin companies. Recorded as an assertion so
    // that if the manager branch is ever loosened, this fails HERE rather than on a tax screen.
    const viaRls = await employmentSubject(mgrCtx, outsiderEmploymentId);
    expect(viaRls, 'RLS refuses even the manager path — the database is what protects this').toBeNull();

    // The PAGE must still refuse: the picker never offers this person, so neither may the URL.
    scope = { s: mgrCtx, scopeIds: [b.companyId] };
    const tree = await Tp1TransactionPage({ searchParams: Promise.resolve({ employmentId: outsiderEmploymentId }) } as any);
    expect(textIn(tree), 'the page must not render an employee its own picker excludes').not.toContain('Outsider');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Every React element in a rendered tree, descending through every element-valued prop. */
function walk(node: unknown, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { for (const n of node) walk(n, acc); return acc; }
  const el = node as any;
  if (el.type !== undefined) acc.push(el);
  for (const v of Object.values(el.props ?? {})) if (v && typeof v === 'object') walk(v, acc);
  return acc;
}
/** Every STRING anywhere in the tree — children, and any string-valued prop (the employee name arrives
 *  as a prop on EmployeeName, not as a text child, so a children-only reader sees nothing). */
const textIn = (tree: unknown): string => {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (n: unknown): void => {
    if (typeof n === 'string') { out.push(n); return; }
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { n.forEach(visit); return; }
    // Descend into EVERY object value, not just `props`: the subject the page resolved is passed as a
    // plain data object, so a props-only walk never reaches the employee's name.
    for (const v of Object.values(n as Record<string, unknown>)) visit(v);
  };
  visit(tree);
  return out.join(' ');
};

describe('3e3d3fb2 — the RENDERED TP1 screen, not its source', () => {
  it('an out-of-scope ?employmentId= selects nobody — the outsider’s name never reaches the page', async () => {
    // The assertion the plan asked for: on the RENDERED output, not a grep for `employees.some`. Before
    // the guard, an id the picker never offers still resolved a subject and printed their name and company
    // in the header card.
    scope = { s: scopedToBase(), scopeIds: [b.companyId] };
    const tree = await Tp1TransactionPage({ searchParams: Promise.resolve({ employmentId: outsiderEmploymentId }) } as any);
    expect(textIn(tree)).not.toContain('Outsider');
  });

  it('and an IN-scope one still selects — the guard must not refuse everything', async () => {
    scope = { s: scopedToBase(), scopeIds: [b.companyId] };
    const inside = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Zulkifli Insider', primaryEmail: `zi_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    const tree = await Tp1TransactionPage({ searchParams: Promise.resolve({ employmentId: inside.employmentId }) } as any);
    expect(textIn(tree)).toContain('Zulkifli Insider');
  });
});
