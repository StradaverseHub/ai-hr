/**
 * Lifecycle onboarding import (ADR-0095): heading-matched columns, day-first dates, sensitive columns never
 * read, preview creates nothing, commit creates only the OK rows through the New Hire rules.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { commitOnboardingRows, getCase, listCases, onboardingTemplate, parseSheetDate, previewOnboardingImport, caseHistory } from '../packs/lifecycle/service';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee } from '../core/org';

const book = (sheets: Record<string, unknown[][]>): Buffer => {
  const wb = XLSX.utils.book_new();
  for (const [n, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), n);
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
};

describe('parseSheetDate', () => {
  it('reads day first, two-digit years, ISO and Excel serials; rejects impossible dates', () => {
    expect(parseSheetDate('13/10/2026')).toBe('2026-10-13');
    expect(parseSheetDate('01/02/2026')).toBe('2026-02-01'); // 1 February, not 2 January
    expect(parseSheetDate('5-3-26')).toBe('2026-03-05');
    expect(parseSheetDate('2026-10-13')).toBe('2026-10-13');
    expect(parseSheetDate(46308)).toBe('2026-10-13');
    expect(parseSheetDate('31/02/2026')).toBeNull();
    expect(parseSheetDate('soon')).toBeNull();
    expect(parseSheetDate('')).toBeNull();
  });
});

describe('onboarding import', () => {
  let b: Base; let agent: SessionContext; let requester: SessionContext;
  beforeEach(async () => {
    await resetDb(); b = await seedBase();
    await setModule(b.tenantId, 'lifecycle', 'active');
    const admin = await entitledCtx(b);
    const mk = async (n: string) => {
      const h = await hireEmployee(admin, { person: { fullName: n, primaryEmail: `${n.toLowerCase()}@acme.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
      const userId = await createAppUser(b.tenantId, h.personId, 'employee');
      return { userId, ctx: { ...admin, userId, personId: h.personId, roles: ['employee'], grants: undefined } as SessionContext };
    };
    const a = await mk('Agent'); const r = await mk('Req');
    agent = a.ctx; requester = r.ctx;
    await owner.db.insert(schema.lcStaff).values({ tenantId: b.tenantId, userId: a.userId, level: 'agent' });
    await owner.db.update(schema.company).set({ companyLabel: 'ACME' }).where(eq(schema.company.id, b.companyId));
  });
  afterAll(async () => { await closeAll(); });

  const HEAD = ['Full name', 'Employee No.', 'Join Date', 'Business Group', 'Job Title', 'Laptop Required', 'Email', 'Password', 'NRIC'];

  it('previews every row without creating anything, marking OK / Duplicate / Error with the reason', async () => {
    const file = book({ Hires: [
      HEAD,
      ['Ann Lee', 'E1', '13/10/2026', 'ACME', 'Analyst', 'Yes', 'ann@x.test', 'Secret123', '900101-01-1234'],
      ['Bob Tan', 'E2', '', 'ACME', 'Analyst', 'No', '', '', ''],
      ['Cy Ong', 'E1', '14/10/2026', 'ACME', '', '', '', '', ''],
      ['Di Lim', 'E4', '31/02/2026', 'ACME', '', '', '', '', ''],
      ['Eve Ng', 'E5', '15/10/2026', 'UNKNOWNBG', '', '', '', '', ''],
    ] });
    const pv = await previewOnboardingImport(agent, file, { fileName: 'hires.xlsx' });
    expect(pv.rows.map((r) => [r.input.employeeNo, r.status])).toEqual([['E1', 'ok'], ['E2', 'error'], ['E1', 'duplicate'], ['E4', 'error'], ['E5', 'error']]);
    expect(pv.rows[1]!.reason).toMatch(/Join date is missing/);
    expect(pv.rows[3]!.reason).toMatch(/readable date/);
    expect(pv.rows[2]!.reason).toMatch(/twice/);
    expect(pv.rows[0]!.input.joinDate).toBe('2026-10-13');
    expect(pv.rows[0]!.input.laptopRequired).toBe(true);
    expect(pv.skippedColumns.sort()).toEqual(['NRIC', 'Password']);
    expect(JSON.stringify(pv)).not.toContain('Secret123');
    expect(JSON.stringify(pv)).not.toContain('900101-01-1234');
    expect(await listCases(agent, 'onboarding')).toEqual([]); // nothing created yet
  });

  it('uses the default company when the sheet has no business group, and the sheet name when it matches one', async () => {
    const noBg = book({ Sheet1: [['Name', 'Employee Number', 'Start Date'], ['Fay', 'E9', '1/11/2026']] });
    expect((await previewOnboardingImport(agent, noBg)).rows[0]!.status).toBe('error');
    expect((await previewOnboardingImport(agent, noBg, { defaultCompanyId: b.companyId })).rows[0]!.status).toBe('ok');
    const bySheet = book({ ACME: [['Name', 'Employee Number', 'Start Date'], ['Gus', 'E10', '1/11/2026']] });
    expect((await previewOnboardingImport(agent, bySheet)).rows[0]!.status).toBe('ok');
  });

  it('commit creates only the OK rows with their requisitions and records where each came from', async () => {
    const file = book({ Hires: [HEAD, ['Ann Lee', 'E1', '13/10/2026', 'ACME', 'Analyst', 'Yes', 'ann@x.test', '', ''], ['Bob', 'E2', '', 'ACME', '', '', '', '', '']] });
    const pv = await previewOnboardingImport(agent, file, { fileName: 'hires.xlsx' });
    const res = await commitOnboardingRows(agent, pv.rows);
    expect(res.created).toHaveLength(1);
    expect(res.failed).toEqual([]);
    const c = await getCase(agent, 'onboarding', res.created[0]!.number);
    expect(c.case.fullName).toBe('Ann Lee');
    expect(c.requisitions).toHaveLength(1);
    expect((await caseHistory(agent, 'onboarding', res.created[0]!.number)).some((h) => JSON.stringify(h.detail).includes('hires.xlsx, Hires, row 2'))).toBe(true);
    // committing the same preview again creates nothing: the employee number is now taken
    const again = await commitOnboardingRows(agent, pv.rows);
    expect(again.created).toEqual([]);
    expect(again.failed).toHaveLength(1);
    // and a fresh preview marks it a duplicate
    expect((await previewOnboardingImport(agent, file)).rows[0]!.status).toBe('duplicate');
  });

  it('refuses a non-xlsx file, an empty file and too many rows; a requester cannot import', async () => {
    await expect(previewOnboardingImport(agent, Buffer.from('a,b\n1,2'))).rejects.toThrow(/xlsx/);
    await expect(previewOnboardingImport(agent, Buffer.alloc(0))).rejects.toThrow(/empty/);
    const many = book({ Hires: [['Name', 'Employee No', 'Join Date', 'BG'], ...Array.from({ length: 501 }, (_, i) => [`N${i}`, `E${i}`, '1/1/2027', 'ACME'])] });
    await expect(previewOnboardingImport(agent, many)).rejects.toThrow(/more than 500/);
    await expect(previewOnboardingImport(requester, book({ Hires: [HEAD] }))).rejects.toThrow(/Not permitted/);
  });

  it('the downloadable template previews cleanly', async () => {
    const pv = await previewOnboardingImport(agent, onboardingTemplate(), { defaultCompanyId: b.companyId });
    expect(pv.rows).toHaveLength(1);
    expect(pv.rows[0]!.status).toBe('ok');
  });
});
