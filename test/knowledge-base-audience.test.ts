/**
 * KB audience is a clearance ladder (consultant feedback R34): a viewer sees a document only when their
 * role rank ≥ the document's. RLS keeps reads tenant-wide (guides are shared), so this gate — applied in
 * listDocuments AND the getDocument/getDownload deep-link paths — is the only thing stopping an employee
 * reading a manager/HR-only guide.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminCtx, closeAll, createAppUser, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { createArticle, getDocument, getDownload, listDocuments } from '../core/knowledge-base';

let b: Base;
const uniqEmail = () => `kb_${randomUUID().slice(0, 8)}@t.local`;

async function ctxWithRole(role: 'employee' | 'manager'): Promise<SessionContext> {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Viewer', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  const userId = await createAppUser(b.tenantId, e.personId, role);
  return { tenantId: b.tenantId, userId, roles: [role], personId: e.personId };
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('KB audience clearance (R34)', () => {
  it('lists/reads honour the viewer clearance ladder', async () => {
    const admin = adminCtx(b);
    const all = await createArticle(admin, { title: 'Holiday Memo', body: 'x', audience: 'all' });
    const emp = await createArticle(admin, { title: 'Employee Guide', body: 'x', audience: 'employee' });
    const mgr = await createArticle(admin, { title: 'Approvals Guide', body: 'x', audience: 'manager' });
    const hr = await createArticle(admin, { title: 'Audit Trail Guide', body: 'x', audience: 'hr_admin' });

    const employee = await ctxWithRole('employee');
    const manager = await ctxWithRole('manager');

    const titles = (rows: { title: string }[]) => rows.map((r) => r.title).sort();

    // Employee: 'all' + 'employee' only — never manager/HR (the reported leak).
    expect(titles(await listDocuments(employee))).toEqual(['Employee Guide', 'Holiday Memo']);
    // Manager: + 'manager'.
    expect(titles(await listDocuments(manager))).toEqual(['Approvals Guide', 'Employee Guide', 'Holiday Memo']);
    // Admin: everything.
    expect((await listDocuments(admin)).length).toBe(4);
  });

  it('blocks the deep-link paths (getDocument / getDownload) above clearance', async () => {
    const admin = adminCtx(b);
    const all = await createArticle(admin, { title: 'Public', body: 'x', audience: 'all' });
    const hr = await createArticle(admin, { title: 'HR Only', body: 'secret', audience: 'hr_admin' });
    const employee = await ctxWithRole('employee');

    // An employee deep-linking the HR doc id gets nothing, but the public doc resolves.
    expect(await getDocument(employee, hr.id)).toBeNull();
    expect(await getDownload(employee, hr.id)).toBeNull();
    expect(await getDocument(employee, all.id)).not.toBeNull();
    // Admin can still open the HR doc.
    expect(await getDocument(admin, hr.id)).not.toBeNull();
  });
});
