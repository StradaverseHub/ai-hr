/**
 * People page structured filters (#18) — listEmployeesPage now filters by company / department /
 * employment-status (active vs terminated) / employment-type, alongside the existing search. Assertions
 * key off specific employmentIds so any base-seed employees don't perturb them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, terminateEmployment } from '../core/org';
import { listEmployeesPage } from '../core/read';
import { deriveEmploymentStatus } from '../core/employment-status';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const hire = (name: string, employmentType: 'full_time' | 'part_time' | 'contract' | 'intern') =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `pf_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType,
    hiredOn: '2024-01-01',
  });

const ids = (rows: { employmentId: string }[]) => new Set(rows.map((r) => r.employmentId));
const page = (p: Parameters<typeof listEmployeesPage>[1]) => listEmployeesPage(adminCtx(b), p);

describe('#18 — people structured filters', () => {
  it('filters by employment type, status, department, and company', async () => {
    const full = await hire('Filter FullTimer', 'full_time');
    const contract = await hire('Filter Contractor', 'contract');
    const leaver = await hire('Filter Leaver', 'full_time');
    await terminateEmployment(adminCtx(b), { employmentId: leaver.employmentId, terminationDate: '2026-06-01' });

    // employment type
    const byType = await page({ employmentType: 'contract', limit: 100, offset: 0 });
    expect(ids(byType.rows).has(contract.employmentId)).toBe(true);
    expect(ids(byType.rows).has(full.employmentId)).toBe(false);

    // status: terminated vs active
    const terminated = await page({ status: 'terminated', limit: 100, offset: 0 });
    expect(ids(terminated.rows).has(leaver.employmentId)).toBe(true);
    expect(ids(terminated.rows).has(full.employmentId)).toBe(false);

    const active = await page({ status: 'active', limit: 100, offset: 0 });
    expect(ids(active.rows).has(full.employmentId)).toBe(true);
    expect(ids(active.rows).has(leaver.employmentId)).toBe(false);

    // department: the real dept includes them; a bogus dept excludes all of them
    const byDept = await page({ departmentId: b.deptA, limit: 100, offset: 0 });
    expect(ids(byDept.rows).has(full.employmentId)).toBe(true);
    const bogusDept = await page({ departmentId: randomUUID(), limit: 100, offset: 0 });
    expect(bogusDept.rows.length).toBe(0);

    // company: the real company includes them; a bogus company excludes all
    const byCompany = await page({ companyId: b.companyId, limit: 100, offset: 0 });
    expect(ids(byCompany.rows).has(contract.employmentId)).toBe(true);
    const bogusCompany = await page({ companyId: randomUUID(), limit: 100, offset: 0 });
    expect(bogusCompany.rows.length).toBe(0);

    // filters compose (AND): contract + active excludes the full-time leaver and the full-timer
    const composed = await page({ employmentType: 'contract', status: 'active', limit: 100, offset: 0 });
    expect(ids(composed.rows).has(contract.employmentId)).toBe(true);
    expect(ids(composed.rows).has(leaver.employmentId)).toBe(false);
    expect(ids(composed.rows).has(full.employmentId)).toBe(false);
  });

  // Employee-code surfacing: the People list select now returns employeeCode, and the q-search
  // predicate matches it. This is load-bearing because listEmployeesPage casts its rows as
  // EmployeeListRow[], which silences TS structural checks on a missing select column.
  it('surfaces a non-null employee code on the list and makes it searchable', async () => {
    const hired = await hire('Code Carrier', 'full_time');

    // (a) the row carries a non-null, EMP-formatted code
    const all = await page({ limit: 100, offset: 0 });
    const row = all.rows.find((r) => r.employmentId === hired.employmentId);
    expect(row).toBeDefined();
    expect(row!.employeeCode).toMatch(/^EMP-\d{4,}$/);

    // (b) searching by that exact code returns the matching row (covers the q predicate)
    const code = row!.employeeCode!;
    const byCode = await page({ q: code, limit: 100, offset: 0 });
    expect(ids(byCode.rows).has(hired.employmentId)).toBe(true);
    // every returned row genuinely matches the code (no over-broad predicate)
    expect(byCode.rows.every((r) => r.employeeCode === code)).toBe(true);
  });
});

/**
 * Employee Details listing (feedback 650b6eb8) — the multi-select narrowings and the company-then-name
 * reading order the HR-admin leave landing page needs. They sit ALONGSIDE the singular #18 filters above,
 * which the two Personnel screens still drive, so both sets are exercised in the same file.
 */
describe('650b6eb8 — employee list: plural narrowings + company-then-name order', () => {
  it('narrows on a LIST of companies and a LIST of departments', async () => {
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Zulu Holdings' })
      .returning({ id: schema.company.id });
    const [d2] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: c2.id, name: 'Zulu Ops' })
      .returning({ id: schema.department.id });

    const here = await hire('Plural Homebody', 'full_time');
    const there = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Plural Traveller', primaryEmail: `pf_${randomUUID().slice(0, 8)}@t.local` },
      companyId: c2.id,
      departmentId: d2.id,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });

    // One value behaves like the singular filter; two values admit both.
    const oneCompany = await page({ filterCompanyIds: [c2.id], limit: 100, offset: 0 });
    expect(ids(oneCompany.rows).has(there.employmentId)).toBe(true);
    expect(ids(oneCompany.rows).has(here.employmentId)).toBe(false);

    const bothCompanies = await page({ filterCompanyIds: [b.companyId, c2.id], limit: 100, offset: 0 });
    expect(ids(bothCompanies.rows).has(there.employmentId)).toBe(true);
    expect(ids(bothCompanies.rows).has(here.employmentId)).toBe(true);

    const bothDepts = await page({ departmentIds: [b.deptA, d2.id], limit: 100, offset: 0 });
    expect(ids(bothDepts.rows).has(there.employmentId)).toBe(true);
    expect(ids(bothDepts.rows).has(here.employmentId)).toBe(true);
    const otherDeptOnly = await page({ departmentIds: [d2.id], limit: 100, offset: 0 });
    expect(ids(otherDeptOnly.rows).has(here.employmentId)).toBe(false);

    // The SCOPE fence still wins over what you asked to see: a company outside `companyIds` stays out
    // even when it is named in the filter. Conflating the two would be a privilege escalation.
    const fenced = await page({
      companyIds: [b.companyId],
      filterCompanyIds: [c2.id],
      limit: 100,
      offset: 0,
    });
    expect(fenced.rows.length).toBe(0);
  });

  it('narrows on the DERIVED Employee Status, not the stored assignment enum', async () => {
    const settled = await hire('Status Settled', 'full_time');
    const leaving = await hire('Status Leaving', 'full_time');
    // A resignation dated in the past ⇒ the deriver says `resigned` however the stored enum reads.
    await owner.db
      .update(schema.employment)
      .set({ resignationDate: '2020-01-01' })
      .where(eq(schema.employment.id, leaving.employmentId));

    const resigned = await page({ employmentStatuses: ['resigned'], limit: 200, offset: 0 });
    expect(ids(resigned.rows).has(leaving.employmentId)).toBe(true);
    expect(ids(resigned.rows).has(settled.employmentId)).toBe(false);
    // The SQL twin and the TypeScript deriver agree on every row that came back.
    expect(resigned.rows.every((r) => deriveEmploymentStatus(r) === 'resigned')).toBe(true);

    // Two buckets admit both; a bucket nobody is in admits nobody.
    const either = await page({ employmentStatuses: ['resigned', 'active'], limit: 200, offset: 0 });
    expect(ids(either.rows).has(leaving.employmentId)).toBe(true);
    expect(ids(either.rows).has(settled.employmentId)).toBe(true);
    const blacklisted = await page({ employmentStatuses: ['blacklisted'], limit: 200, offset: 0 });
    expect(ids(blacklisted.rows).has(leaving.employmentId)).toBe(false);
    expect(ids(blacklisted.rows).has(settled.employmentId)).toBe(false);
  });

  it("orders company A→Z then employee name A→Z, case-insensitively, and pages in that order", async () => {
    const [cz] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'zzz last company' })
      .returning({ id: schema.company.id });
    const [dz] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: cz.id, name: 'Z Ops' })
      .returning({ id: schema.department.id });
    const hireIn = (fullName: string, companyId: string, departmentId: string) =>
      hireEmployee(adminCtx(b), {
        person: { fullName, primaryEmail: `pf_${randomUUID().slice(0, 8)}@t.local` },
        companyId,
        departmentId,
        employmentType: 'full_time' as const,
        hiredOn: '2024-01-01',
      });
    // Lower-case names in the LAST company: a case-sensitive sort would strand them in their own half.
    await hireIn('order zebra', cz.id, dz.id);
    await hireIn('order aardvark', cz.id, dz.id);

    const all = await page({ sort: 'company', limit: 500, offset: 0 });
    const key = (r: { company: string; name: string }) =>
      `${r.company.toLowerCase()} ${r.name.toLowerCase()}`;
    const keys = all.rows.map(key);
    expect(keys).toEqual([...keys].sort());
    // 'zzz last company' sorts last despite being lower case, and its two employees are in name order.
    const inZ = all.rows.filter((r) => r.company === 'zzz last company').map((r) => r.name);
    expect(inZ).toEqual(['order aardvark', 'order zebra']);
    expect(all.rows.at(-1)!.company).toBe('zzz last company');

    // Paging follows the SAME order: page 2 starts where page 1 stopped, no repeats, no skips.
    const first = await page({ sort: 'company', limit: 10, offset: 0 });
    const second = await page({ sort: 'company', limit: 10, offset: 10 });
    expect(first.rows.map((r) => r.employmentId)).toEqual(all.rows.slice(0, 10).map((r) => r.employmentId));
    expect(second.rows.map((r) => r.employmentId)).toEqual(all.rows.slice(10, 20).map((r) => r.employmentId));
    expect(first.total).toBe(all.total);
  });
});
