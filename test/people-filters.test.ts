/**
 * People page structured filters (#18) — listEmployeesPage now filters by company / department /
 * employment-status (active vs terminated) / employment-type, alongside the existing search. Assertions
 * key off specific employmentIds so any base-seed employees don't perturb them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, terminateEmployment } from '../core/org';
import { listEmployeesPage } from '../core/read';

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
