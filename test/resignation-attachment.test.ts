/**
 * #42cff598 (ADR-0042) — resignation supporting documents. An employee may attach a signed resignation
 * letter (or supporting files: PDF / JPG / PNG) when they resign; HR and the manager can view/download
 * them during approval. Verbatim reuse of the leave-attachment stack, so the attachment's RLS reuses
 * app.can_see_employment (subject + administrative manager + admin) — the security-critical assertion.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { LeaveDocumentSizeError, LeaveDocumentTypeError } from '../core/leave';
import {
  addResignationAttachment,
  decideResignation,
  getResignationAttachmentById,
  listResignationAttachments,
  listResignationRequests,
  submitResignation,
} from '../core/offboarding';
import { adminCtx, closeAll, createAppUser, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let b: Base;

const hire = (ctx: SessionContext, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}_${randomUUID().slice(0, 6)}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const empCtxFor = async (personId: string, role: 'employee' | 'manager' = 'employee'): Promise<SessionContext> => {
  const uid = await createAppUser(b.tenantId, personId, role);
  return { tenantId: b.tenantId, userId: uid, personId, roles: [role] };
};

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

describe('#42cff598 — resignation supporting documents', () => {
  it('attaches a PDF to a pending resignation, then serves it back + appends the event', async () => {
    const a = adminCtx(b);
    const E = await hire(a, 'Resi Doc');
    const emp = await empCtxFor(E.personId);
    const { requestId } = await submitResignation(emp, {
      employmentId: E.employmentId,
      lastWorkingDay: '2026-09-30',
      today: '2026-06-23',
    });
    const { id } = await addResignationAttachment(emp, {
      resignationRequestId: requestId,
      fileName: 'resignation-letter.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.4 letter'),
    });
    const got = await getResignationAttachmentById(emp, id);
    expect(got?.fileName).toBe('resignation-letter.pdf');
    expect(got?.mimeType).toBe('application/pdf');
    expect(Buffer.from(got!.content).toString()).toBe('%PDF-1.4 letter');

    // SUBSTRATE: the attach must have appended a resignation.document.attached event.
    const events = await withTenant(a, (tx) =>
      tx
        .select({ t: schema.domainEvent.eventType })
        .from(schema.domainEvent)
        .where(eq(schema.domainEvent.aggregateId, requestId)),
    );
    expect(events.map((e) => e.t)).toContain('resignation.document.attached');
  });

  it('rejects a disallowed MIME type and an oversized file', async () => {
    const a = adminCtx(b);
    const E = await hire(a, 'Resi Bad');
    const emp = await empCtxFor(E.personId);
    const { requestId } = await submitResignation(emp, {
      employmentId: E.employmentId,
      lastWorkingDay: '2026-09-30',
      today: '2026-06-23',
    });
    await expect(
      addResignationAttachment(emp, {
        resignationRequestId: requestId,
        fileName: 'note.txt',
        mimeType: 'text/plain',
        content: Buffer.from('hello'),
      }),
    ).rejects.toBeInstanceOf(LeaveDocumentTypeError);
    await expect(
      addResignationAttachment(emp, {
        resignationRequestId: requestId,
        fileName: 'huge.pdf',
        mimeType: 'application/pdf',
        content: Buffer.alloc(10 * 1024 * 1024 + 1),
      }),
    ).rejects.toBeInstanceOf(LeaveDocumentSizeError);
  });

  it('refuses to attach once the resignation is no longer pending', async () => {
    const a = adminCtx(b);
    const E = await hire(a, 'Resi Decided');
    const emp = await empCtxFor(E.personId);
    const { requestId } = await submitResignation(emp, {
      employmentId: E.employmentId,
      lastWorkingDay: '2026-09-30',
      today: '2026-06-23',
    });
    await decideResignation(a, { requestId, decision: 'rejected' });
    await expect(
      addResignationAttachment(emp, {
        resignationRequestId: requestId,
        fileName: 'late.pdf',
        mimeType: 'application/pdf',
        content: Buffer.from('%PDF too late'),
      }),
    ).rejects.toThrow();
  });

  it('RLS: the subject, their manager and HR can read the file; a peer cannot', async () => {
    const a = adminCtx(b);
    const E = await hire(a, 'Resi Subject');
    const M = await hire(a, 'Resi Manager');
    const X = await hire(a, 'Resi Peer');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    const empCtx = await empCtxFor(E.personId, 'employee');
    const mgrCtx = await empCtxFor(M.personId, 'manager');
    const peerCtx = await empCtxFor(X.personId, 'employee');

    const { requestId } = await submitResignation(empCtx, {
      employmentId: E.employmentId,
      lastWorkingDay: '2026-09-30',
      today: '2026-06-23',
    });
    const { id } = await addResignationAttachment(empCtx, {
      resignationRequestId: requestId,
      fileName: 'letter.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF secret'),
    });

    expect((await getResignationAttachmentById(empCtx, id))?.fileName).toBe('letter.pdf'); // subject
    expect((await getResignationAttachmentById(mgrCtx, id))?.fileName).toBe('letter.pdf'); // manager
    expect((await getResignationAttachmentById(a, id))?.fileName).toBe('letter.pdf'); // HR
    expect(await getResignationAttachmentById(peerCtx, id)).toBeNull(); // peer: blocked by RLS
  });

  it('surfaces attached files to the admin inbox and lists them', async () => {
    const a = adminCtx(b);
    const E = await hire(a, 'Resi Inbox');
    const emp = await empCtxFor(E.personId);
    const { requestId } = await submitResignation(emp, {
      employmentId: E.employmentId,
      lastWorkingDay: '2026-09-30',
      today: '2026-06-23',
    });
    await addResignationAttachment(emp, {
      resignationRequestId: requestId,
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF a'),
    });
    await addResignationAttachment(emp, {
      resignationRequestId: requestId,
      fileName: 'b.png',
      mimeType: 'image/png',
      content: Buffer.from('PNGb'),
    });

    const list = await listResignationAttachments(a, requestId);
    expect(list.map((d) => d.fileName).sort()).toEqual(['a.pdf', 'b.png']);

    const inbox = await listResignationRequests(a, { status: 'pending' });
    const row = inbox.find((r) => r.id === requestId);
    expect(row?.documents.length).toBe(2);
  });
});
