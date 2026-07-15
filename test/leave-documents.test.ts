/**
 * ADR-0038 2A-2 (#25) — mandatory documents. A leave type with requires_document (e.g. sick leave, which
 * EA s.60F conditions on a medical certificate) rejects a request that arrives without an attachment;
 * with one, the request is created and the document is stored and served back. A type that needs no
 * document is unaffected. The attachment's RLS reuses can_see_employment (same policy as claim_attachment
 * and leave_request), so visibility is the subject + their manager + admins.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { addLeaveAttachment, getLeaveAttachment, LeaveDocumentRequiredError, requestLeave } from '../core/leave';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

async function hire() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Doc', primaryEmail: `doc_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}
async function leaveType(code: string, requiresDocument: boolean) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code, name: code, paid: true, counting: 'calendar_days', requiresDocument })
    .returning({ id: schema.leaveType.id });
  return row.id;
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

describe('ADR-0038 2A-2 — mandatory documents', () => {
  it('rejects a document-required request that has no document', async () => {
    const a = adminCtx(b);
    const sick = await leaveType('SICK_DOC', true);
    const emp = await hire();
    await expect(
      requestLeave(a, { employmentId: emp.employmentId, leaveTypeId: sick, startDate: '2026-07-01', endDate: '2026-07-01' }),
    ).rejects.toBeInstanceOf(LeaveDocumentRequiredError);
  });

  it('accepts when a document is provided, then stores and serves it back', async () => {
    const a = adminCtx(b);
    const sick = await leaveType('SICK_DOC', true);
    const emp = await hire();
    const { leaveRequestId } = await requestLeave(a, {
      employmentId: emp.employmentId,
      leaveTypeId: sick,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      hasDocument: true,
    });
    await addLeaveAttachment(a, {
      leaveRequestId,
      fileName: 'mc.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.4 mc'),
    });
    const got = await getLeaveAttachment(a, leaveRequestId);
    expect(got?.fileName).toBe('mc.pdf');
    expect(got?.mimeType).toBe('application/pdf');
    expect(Buffer.from(got!.content).toString()).toBe('%PDF-1.4 mc');
  });

  it('a type that needs no document is unaffected', async () => {
    const a = adminCtx(b);
    const annual = await leaveType('ANN_NODOC', false);
    const emp = await hire();
    await expect(
      requestLeave(a, { employmentId: emp.employmentId, leaveTypeId: annual, startDate: '2026-07-01', endDate: '2026-07-01' }),
    ).resolves.toMatchObject({ days: 1 });
    expect(await getLeaveAttachment(a, randomUUID())).toBeNull();
  });
});
