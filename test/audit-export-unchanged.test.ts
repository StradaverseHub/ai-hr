/**
 * Board 74a7a074 — the readable on-screen detail must leave the Audit Trail download exactly as it was
 * (ADR-0047: external consumers rely on its layout). This drives the real export route with fictional rows
 * covering every payload shape the new screen reads (before/after with ids, { from, to }, the hire's nested
 * information block, a masked salary and the assignment aggregate) and compares each cell with the text the
 * pre-change formatter produced, written out by hand here so the expectation does not depend on the code
 * under test. The XLSX and PDF formats serialize these same cells.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCsv } from '../lib/csv';

const rows = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('../lib/session', () => ({ getSession: async () => ({ tenantId: 'fictional-tenant', roles: ['hr_admin'] }) }));
vi.mock('../lib/authz', () => ({ isAdmin: () => true }));
vi.mock('../core/read', () => ({ auditEvents: async () => rows.value }));

const C = '11111111-1111-4111-8111-111111111111';
const E = '22222222-2222-4222-8222-222222222222';
const D1 = '33333333-3333-4333-8333-333333333331';
const D2 = '33333333-3333-4333-8333-333333333332';
const P = '55555555-5555-4555-8555-555555555555';
const A = '77777777-7777-4777-8777-777777777777';
const at = new Date('2026-11-20T09:14:03.112Z');
const base = { actorType: 'USER', actorName: 'Fictional Admin', occurredAt: at, sequence: 1 };

beforeEach(() => {
  rows.value = [
    { ...base, id: 'r1', aggregateType: 'employment', aggregateId: E, eventType: 'employment.info.updated',
      payload: { companyId: C, before: { departmentId: D1 }, after: { departmentId: D2 } } },
    { ...base, id: 'r2', aggregateType: 'assignment', aggregateId: A, eventType: 'assignment.transferred',
      payload: { employmentId: E, from: { departmentId: D1, locationId: null }, to: { departmentId: D2, locationId: null }, effectiveDate: '2026-11-01' } },
    { ...base, id: 'r3', aggregateType: 'employment', aggregateId: E, eventType: 'employment.hired',
      payload: { employmentInformation: { hiredOn: '2026-11-20', orgBranch: null }, personId: P, companyId: C, hiredOn: '2026-11-20' } },
    { ...base, id: 'r4', aggregateType: 'compensation', aggregateId: A, eventType: 'compensation.updated', actorType: 'SYSTEM', actorName: null,
      payload: { before: { basicSalary: 4000 }, after: { basicSalary: 45000 } } },
  ];
});

describe('74a7a074 — the Audit Trail export is unchanged', () => {
  it('prints the same columns and cells, ids and "key: value" text included', async () => {
    const { GET } = await import('../app/admin/audit/export/route');
    const res = await GET(new Request('http://fictional.test/admin/audit/export?format=csv'));
    expect(res.status).toBe(200);
    const [header, ...body] = parseCsv(await res.text());
    expect(header).toEqual(['When (MYT)', 'Module', 'Record type', 'Action', 'Event', 'Who', 'Record ID', 'Changes']);
    const when = at.toLocaleString('en-CA', { timeZone: 'Asia/Kuala_Lumpur', hour12: false });
    expect(body).toEqual([
      [when, 'Organization', 'Employee', 'Updated', 'employment.info.updated', 'Fictional Admin', E, `departmentId: ${D1} → ${D2} | companyId: ${C}`],
      // The { from, to } shape stays a flat JSON dump in the file, and assignment still chips Other.
      [when, 'Other', 'Assignment', 'Other', 'assignment.transferred', 'Fictional Admin', A,
        `employmentId: ${E} | from: {"departmentId":"${D1}","locationId":null} | to: {"departmentId":"${D2}","locationId":null} | effectiveDate: 2026-11-01`],
      [when, 'Organization', 'Employee', 'Other', 'employment.hired', 'Fictional Admin', E,
        `employmentInformation: {"hiredOn":"2026-11-20","orgBranch":null} | personId: ${P} | companyId: ${C} | hiredOn: 2026-11-20`],
      [when, 'Payroll', 'Basic salary', 'Updated', 'compensation.updated', 'System', A, 'basicSalary: •••• → •••• 5000'],
    ]);
  });
});
