/**
 * Employee ID Auto Running Number Setup (feedback 3d0031e6) — configurable auto-numbering for employee_code.
 *  - GLOBAL config: a blank-code hire auto-generates prefix + zero-padded, sequential, advancing IDs
 *  - COMPANY-SPECIFIC config wins over GLOBAL; two companies keep independent sequences
 *  - a MANUAL code still bypasses the generator
 *  - NO active config → legacy EMP-#### fallback (seed/test byte-identical)
 *  - validation: prefix+length+suffix > 30 rejected (de2823cc lifted the old 9-char cap); two active per
 *    scope rejected; colliding prefixes rejected; long real-world formats (CHINHIN-HQ-000001-MY) generate
 *  - CP39 guard (de2823cc): templates composing > 10 chars flag the non-blocking note; the CP39 file
 *    builder REFUSES an over-long employee no (listing the employee) instead of silently truncating
 *  - deactivating the config falls the hire back to the legacy counter
 *  - update currentRunningNumber then the next hire continues from it; CRUD emits employee-id-config.* events
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  createConfig,
  deleteConfig,
  DuplicateActiveConfigError,
  EmployeeCodeTooLongError,
  exceedsCp39EmployeeNoLength,
  formatEmployeeCode,
  getConfig,
  listConfigs,
  PrefixCollisionError,
  setStatus,
  updateConfig,
} from '../core/employee-id-config';
import { buildCp39File } from '../localization/my/cp39-file';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

async function secondCompany() {
  const [c2] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  const [d2] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: c2.id, name: 'Beta Ops' })
    .returning({ id: schema.department.id });
  return { companyId: c2.id, deptId: d2.id };
}

/** Hire (no manual employee code) and return the assigned employee_code. */
async function hireAndCode(name: string, companyId = b.companyId, departmentId = b.deptA): Promise<string> {
  const { employmentId } = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `eic_${randomUUID().slice(0, 8)}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  const [row] = await owner.db
    .select({ code: schema.employment.employeeCode })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return row.code!;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('Employee ID Auto Running Number Setup — generation', () => {
  it('a GLOBAL config auto-generates sequential, padded, prefixed IDs at hire and advances the counter', async () => {
    const a = adminCtx(b);
    await createConfig(a, { companyId: null, prefix: 'EMP', startNumber: 1, numberLength: 4, increment: 1 });
    expect(await hireAndCode('One')).toBe('EMP0001');
    expect(await hireAndCode('Two')).toBe('EMP0002');
    expect(await hireAndCode('Three')).toBe('EMP0003');
    // current_running_number reflects the last issued number.
    const [cfg] = await listConfigs(a);
    expect(cfg.currentRunningNumber).toBe(3);
  });

  it('honours startNumber and increment', async () => {
    const a = adminCtx(b);
    await createConfig(a, { companyId: null, prefix: 'STAFF', startNumber: 1000, numberLength: 4, increment: 5 });
    expect(await hireAndCode('One')).toBe('STAFF1000');
    expect(await hireAndCode('Two')).toBe('STAFF1005');
  });

  it('a COMPANY-SPECIFIC config wins over GLOBAL, and two companies keep independent sequences', async () => {
    const a = adminCtx(b);
    const { companyId: c2, deptId: d2 } = await secondCompany();
    await createConfig(a, { companyId: null, prefix: 'G', startNumber: 1, numberLength: 3, increment: 1 });
    await createConfig(a, { companyId: b.companyId, prefix: 'KL', startNumber: 1, numberLength: 4, increment: 1 });
    await createConfig(a, { companyId: c2, prefix: 'JB', startNumber: 1, numberLength: 4, increment: 1 });
    // Company A uses its own KL sequence; company B uses JB; a company with no config would fall to G.
    expect(await hireAndCode('A1', b.companyId, b.deptA)).toBe('KL0001');
    expect(await hireAndCode('B1', c2, d2)).toBe('JB0001');
    expect(await hireAndCode('A2', b.companyId, b.deptA)).toBe('KL0002');
    expect(await hireAndCode('B2', c2, d2)).toBe('JB0002');
  });

  it('falls back to GLOBAL when a company has no company-specific config', async () => {
    const a = adminCtx(b);
    await createConfig(a, { companyId: null, prefix: 'GLB', startNumber: 1, numberLength: 3, increment: 1 });
    expect(await hireAndCode('X')).toBe('GLB001');
  });

  it('a MANUAL employee code still bypasses the generator', async () => {
    const a = adminCtx(b);
    await createConfig(a, { companyId: null, prefix: 'EMP', startNumber: 1, numberLength: 4, increment: 1 });
    const { employmentId } = await hireEmployee(a, {
      person: { fullName: 'Manual', primaryEmail: `m_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
      employeeCode: 'X-777',
    });
    const [row] = await owner.db
      .select({ code: schema.employment.employeeCode })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    expect(row.code).toBe('X-777');
    // The config counter did NOT advance (manual bypasses generation).
    const [cfg] = await listConfigs(a);
    expect(cfg.currentRunningNumber).toBe(0);
  });

  it('with NO active config the legacy EMP-#### counter still runs (byte-identical fallback)', async () => {
    expect(await hireAndCode('Legacy')).toBe('EMP-0001');
  });

  it('a DEACTIVATED config falls the hire back to the legacy counter', async () => {
    const a = adminCtx(b);
    const { id } = await createConfig(a, { companyId: null, prefix: 'EMP', startNumber: 1, numberLength: 4, increment: 1 });
    expect(await hireAndCode('One')).toBe('EMP0001');
    await setStatus(a, { id, status: 'inactive' });
    expect(await hireAndCode('Two')).toBe('EMP-0001'); // legacy tenant_counter path
  });

  it('editing currentRunningNumber makes the next hire continue from it', async () => {
    const a = adminCtx(b);
    const { id } = await createConfig(a, { companyId: null, prefix: 'E', startNumber: 1, numberLength: 5, increment: 1 });
    await updateConfig(a, { id, currentRunningNumber: 100 });
    expect(await hireAndCode('One')).toBe('E00101');
  });

  it('a LONG real-world format (de2823cc) — prefix CHINHIN-HQ-, 6 digits, suffix -MY — generates at hire', async () => {
    const a = adminCtx(b);
    await createConfig(a, {
      companyId: null,
      prefix: 'CHINHIN-HQ-',
      suffix: '-MY',
      startNumber: 1,
      numberLength: 6,
      increment: 1,
    });
    expect(await hireAndCode('Long One')).toBe('CHINHIN-HQ-000001-MY'); // 20 chars — over the old 9 cap
    expect(await hireAndCode('Long Two')).toBe('CHINHIN-HQ-000002-MY');
  });
});

describe('Employee ID Auto Running Number Setup — validation + substrate', () => {
  it('accepts prefix + number length over the OLD 9-char cap (de2823cc removed it)', async () => {
    const a = adminCtx(b);
    await expect(
      createConfig(a, { companyId: null, prefix: 'STAFFX', startNumber: 1, numberLength: 6, increment: 1 }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('rejects prefix + number length + suffix > 30 characters (the practical ceiling)', async () => {
    const a = adminCtx(b);
    await expect(
      // 27-char prefix + 4 digits = 31 > 30.
      createConfig(a, { companyId: null, prefix: 'A'.repeat(27), startNumber: 1, numberLength: 4, increment: 1 }),
    ).rejects.toBeInstanceOf(EmployeeCodeTooLongError);
  });

  it('rejects a second ACTIVE config in the same scope', async () => {
    const a = adminCtx(b);
    await createConfig(a, { companyId: null, prefix: 'AAA', startNumber: 1, numberLength: 4, increment: 1 });
    await expect(
      createConfig(a, { companyId: null, prefix: 'BBB', startNumber: 1, numberLength: 4, increment: 1 }),
    ).rejects.toBeInstanceOf(DuplicateActiveConfigError);
  });

  it('rejects two ACTIVE configs sharing a prefix (would break tenant-wide code uniqueness)', async () => {
    const a = adminCtx(b);
    const { companyId: c2 } = await secondCompany();
    await createConfig(a, { companyId: b.companyId, prefix: 'SAME', startNumber: 1, numberLength: 4, increment: 1 });
    await expect(
      createConfig(a, { companyId: c2, prefix: 'SAME', startNumber: 1, numberLength: 4, increment: 1 }),
    ).rejects.toBeInstanceOf(PrefixCollisionError);
  });

  it('allows a second config in the same scope once the first is INACTIVE', async () => {
    const a = adminCtx(b);
    const { id } = await createConfig(a, { companyId: null, prefix: 'AAA', startNumber: 1, numberLength: 4, increment: 1 });
    await setStatus(a, { id, status: 'inactive' });
    await expect(
      createConfig(a, { companyId: null, prefix: 'BBB', startNumber: 1, numberLength: 4, increment: 1 }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('CRUD emits employee-id-config.* domain events', async () => {
    const a = adminCtx(b);
    const { id } = await createConfig(a, { companyId: null, prefix: 'EV', startNumber: 1, numberLength: 4, increment: 1 });
    await updateConfig(a, { id, increment: 2 });
    await setStatus(a, { id, status: 'inactive' });
    await setStatus(a, { id, status: 'active' });
    await deleteConfig(a, { id });
    expect(await eventTypesFor(b.tenantId, id)).toEqual(
      expect.arrayContaining([
        'employee-id-config.created',
        'employee-id-config.updated',
        'employee-id-config.deactivated',
        'employee-id-config.activated',
        'employee-id-config.deleted',
      ]),
    );
  });

  it('getConfig round-trips the stored fields', async () => {
    const a = adminCtx(b);
    const { id } = await createConfig(a, { companyId: b.companyId, prefix: 'RT', startNumber: 7, numberLength: 5, increment: 3 });
    expect(await getConfig(a, id)).toMatchObject({
      companyId: b.companyId,
      prefix: 'RT',
      startNumber: 7,
      numberLength: 5,
      increment: 3,
      status: 'active',
    });
  });
});

describe('formatEmployeeCode', () => {
  it('zero-pads to numberLength and prefixes', () => {
    expect(formatEmployeeCode('EMP', 1, 4)).toBe('EMP0001');
    expect(formatEmployeeCode('KL', 42, 4)).toBe('KL0042');
  });
  it('formats codes over the OLD 9-char cap (de2823cc): a width overflow no longer throws under 30', () => {
    expect(formatEmployeeCode('STAFFX', 10000, 4)).toBe('STAFFX10000'); // 11 chars — fine now
    expect(formatEmployeeCode('CHINHIN-HQ-', 125, 6, '-MY')).toBe('CHINHIN-HQ-000125-MY');
  });
  it('throws when the formatted code would exceed the 30-char ceiling', () => {
    // 28-char prefix + 4 digits = 32 > 30.
    expect(() => formatEmployeeCode('A'.repeat(28), 1, 4)).toThrow(EmployeeCodeTooLongError);
  });
});

describe('CP39 guard for long Employee IDs (de2823cc)', () => {
  it('exceedsCp39EmployeeNoLength flags templates composing more than 10 characters', () => {
    expect(exceedsCp39EmployeeNoLength('EMP', 4)).toBe(false); // 7
    expect(exceedsCp39EmployeeNoLength('EMP', 7)).toBe(false); // exactly 10 — fits
    expect(exceedsCp39EmployeeNoLength('EMP', 8)).toBe(true); // 11
    expect(exceedsCp39EmployeeNoLength('CHINHIN-HQ-', 6, '-MY')).toBe(true); // 20
  });

  const cp39Row = (employeeNo: string) => ({
    tin: '12345678901',
    name: 'Long Code Lee',
    mtd: 110,
    employeeNo,
  });

  it('buildCp39File REFUSES an employee no over the 10-char field, listing the employee (no silent truncation)', () => {
    expect(() =>
      buildCp39File({ employerNo: '908915-10', year: 2026, month: 1, rows: [cp39Row('CHINHIN-HQ-000001-MY')] }),
    ).toThrow(/10-character CP39 field.*Long Code Lee \(CHINHIN-HQ-000001-MY\)/);
  });

  it('buildCp39File still accepts a 10-char employee no (at the field limit) untruncated', () => {
    const f = buildCp39File({ employerNo: '908915-10', year: 2026, month: 1, rows: [cp39Row('EMP1234567')] });
    const detail = f.content.split('\r\n')[1];
    expect(detail).toHaveLength(136);
    expect(detail.endsWith('EMP1234567')).toBe(true);
  });
});
