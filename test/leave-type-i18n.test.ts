/**
 * ADR-0038 2F-2 (R37) — per-locale leave-type names. leaveBalances + listLeaveTypes resolve the display
 * name to the viewer's locale (leave_type.i18n[locale].name), falling back to the default English name
 * when the locale is en or has no translation.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { leaveBalances, listLeaveTypes } from '../core/read';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let emp: { employmentId: string };

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await owner.db.insert(schema.leaveType).values({
    tenantId: b.tenantId,
    code: 'WD_I18N',
    name: 'Working Leave',
    paid: true,
    counting: 'calendar_days',
    i18n: { ms: { name: 'Cuti Kerja' }, zh: { name: '工作假' } },
  });
  emp = await hireEmployee(adminCtx(b), {
    person: { fullName: 'I18n', primaryEmail: `i18n_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
});
afterAll(async () => {
  await closeAll();
});

const nameInBalances = async (locale?: string) =>
  (await leaveBalances(adminCtx(b), emp.employmentId, locale)).find((r) => /Cuti Kerja|工作假|Working Leave/.test(r.leaveType))?.leaveType;
const nameInTypes = async (locale?: string) =>
  (await listLeaveTypes(adminCtx(b), { locale })).find((t) => t.code === 'WD_I18N')?.name;

describe('ADR-0038 2F-2 (R37) — localized leave-type names', () => {
  it('leaveBalances resolves the name to the viewer locale, falling back otherwise', async () => {
    expect(await nameInBalances('ms')).toBe('Cuti Kerja');
    expect(await nameInBalances('zh')).toBe('工作假');
    expect(await nameInBalances('en')).toBe('Working Leave');
    expect(await nameInBalances('th')).toBe('Working Leave'); // no Thai translation → default
  });

  it('listLeaveTypes localizes the name (admin callers pass no locale → default)', async () => {
    expect(await nameInTypes('ms')).toBe('Cuti Kerja');
    expect(await nameInTypes('en')).toBe('Working Leave');
    expect(await nameInTypes()).toBe('Working Leave'); // no locale → default (admin edit view)
  });
});
