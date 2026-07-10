/**
 * f018ce8d — Personnel Documents tab redesigned into a general employee document store. Covers the
 * expected_function points: upload (mandatory title + attachment), supported-type sniffing/validation,
 * metadata edit, attachment replace, delete, RLS (subject reads / unrelated employee blocked / only admin
 * writes), and the full audit event trail (uploaded / updated / content-replaced / deleted / downloaded).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  addEmployeeDocument,
  deleteEmployeeDocument,
  EmployeeDocumentError,
  getEmployeeDocument,
  listEmployeeDocuments,
  replaceEmployeeDocumentContent,
  resolveDocumentUpload,
  updateEmployeeDocumentMeta,
} from '../core/employee-documents';
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

const empCtxFor = async (personId: string): Promise<SessionContext> => {
  const uid = await createAppUser(b.tenantId, personId, 'employee');
  return { tenantId: b.tenantId, userId: uid, personId, roles: ['employee'] };
};

const PDF = Buffer.from('%PDF-1.4 hello world sample document body');
const eventsFor = (a: SessionContext, docId: string) =>
  withTenant(a, (tx) =>
    tx.select({ t: schema.domainEvent.eventType }).from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId, docId)),
  );

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

describe('f018ce8d — employee document store', () => {
  it('admin uploads a document (title mandatory), it lists with audit metadata + downloads back', async () => {
    const a = adminCtx(b);
    const E = await hire(a, 'Doc Owner');
    const { id } = await addEmployeeDocument(a, {
      employmentId: E.employmentId,
      title: 'Signed contract',
      category: 'Contract',
      description: 'FY26 employment agreement',
      fileName: 'contract.pdf',
      mimeType: 'application/pdf',
      content: PDF,
    });

    const list = await listEmployeeDocuments(a, E.employmentId);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Signed contract');
    expect(list[0].category).toBe('Contract');
    expect(list[0].fileName).toBe('contract.pdf');
    expect(list[0].mimeType).toBe('application/pdf');
    expect(list[0].sizeBytes).toBe(PDF.byteLength);
    // uploadedBy resolves via app_user → person; the seeded admin has personId=null so it's null (no crash).
    expect(list[0].uploadedBy === null || typeof list[0].uploadedBy === 'string').toBe(true);

    const got = await getEmployeeDocument(a, id);
    expect(got).not.toBeNull();
    expect(Buffer.from(got!.content).toString()).toBe(PDF.toString());

    const events = (await eventsFor(a, id)).map((e) => e.t);
    expect(events).toContain('employee-document.uploaded');
    expect(events).toContain('employee-document.downloaded'); // download audit (expected_function §6)
  });

  it('rejects a blank title', async () => {
    const a = adminCtx(b);
    const E = await hire(a, 'Blank Title');
    await expect(
      addEmployeeDocument(a, { employmentId: E.employmentId, title: '   ', fileName: 'x.pdf', mimeType: 'application/pdf', content: PDF }),
    ).rejects.toBeInstanceOf(EmployeeDocumentError);
  });

  it('edit metadata + replace attachment + delete each append their audit event', async () => {
    const a = adminCtx(b);
    const E = await hire(a, 'Lifecycle');
    const { id } = await addEmployeeDocument(a, {
      employmentId: E.employmentId,
      title: 'Cert',
      fileName: 'cert.pdf',
      mimeType: 'application/pdf',
      content: PDF,
    });

    await updateEmployeeDocumentMeta(a, { documentId: id, title: 'Certificate (updated)', category: 'Certificate' });
    let list = await listEmployeeDocuments(a, E.employmentId);
    expect(list[0].title).toBe('Certificate (updated)');
    expect(list[0].category).toBe('Certificate');

    const PDF2 = Buffer.from('%PDF-1.5 replaced content that is different');
    await replaceEmployeeDocumentContent(a, { documentId: id, fileName: 'cert-v2.pdf', mimeType: 'application/pdf', content: PDF2 });
    list = await listEmployeeDocuments(a, E.employmentId);
    expect(list[0].fileName).toBe('cert-v2.pdf');
    expect(list[0].sizeBytes).toBe(PDF2.byteLength);

    await deleteEmployeeDocument(a, { documentId: id });
    expect(await listEmployeeDocuments(a, E.employmentId)).toHaveLength(0);

    const events = (await eventsFor(a, id)).map((e) => e.t);
    expect(events).toContain('employee-document.updated');
    expect(events).toContain('employee-document.content-replaced');
    expect(events).toContain('employee-document.deleted');
  });

  it('RLS: the subject can READ their own documents but cannot WRITE; an unrelated employee sees nothing', async () => {
    const a = adminCtx(b);
    const subjectEmp = await hire(a, 'Subject Emp');
    const otherEmp = await hire(a, 'Other Emp');
    const { id } = await addEmployeeDocument(a, {
      employmentId: subjectEmp.employmentId,
      title: 'Payslip scan',
      fileName: 'p.pdf',
      mimeType: 'application/pdf',
      content: PDF,
    });

    const subject = await empCtxFor(subjectEmp.personId);
    const other = await empCtxFor(otherEmp.personId);

    // Subject reads own document.
    expect(await listEmployeeDocuments(subject, subjectEmp.employmentId)).toHaveLength(1);
    expect(await getEmployeeDocument(subject, id)).not.toBeNull();

    // Subject cannot write (role gate — not an admin).
    await expect(
      addEmployeeDocument(subject, { employmentId: subjectEmp.employmentId, title: 'Sneaky', fileName: 's.pdf', mimeType: 'application/pdf', content: PDF }),
    ).rejects.toBeInstanceOf(EmployeeDocumentError);
    await expect(deleteEmployeeDocument(subject, { documentId: id })).rejects.toBeInstanceOf(EmployeeDocumentError);

    // Unrelated employee: RLS hides the subject's document entirely.
    expect(await listEmployeeDocuments(other, subjectEmp.employmentId)).toHaveLength(0);
    expect(await getEmployeeDocument(other, id)).toBeNull();
  });

  it('rejects empty + oversized uploads', async () => {
    const a = adminCtx(b);
    const E = await hire(a, 'Size Limits');
    await expect(
      addEmployeeDocument(a, { employmentId: E.employmentId, title: 'Empty', fileName: 'e.pdf', mimeType: 'application/pdf', content: Buffer.alloc(0) }),
    ).rejects.toBeInstanceOf(EmployeeDocumentError);
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1);
    await expect(
      addEmployeeDocument(a, { employmentId: E.employmentId, title: 'Huge', fileName: 'h.pdf', mimeType: 'application/pdf', content: huge }),
    ).rejects.toBeInstanceOf(EmployeeDocumentError);
  });
});

describe('f018ce8d — resolveDocumentUpload (type sniff + extension cross-check)', () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]); // PK.. Office Open XML container
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // legacy OLE compound
  const pdf = Buffer.from('%PDF-1.7 body');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

  it('resolves each supported format from magic bytes + extension', () => {
    expect(resolveDocumentUpload('a.pdf', pdf).mimeType).toBe('application/pdf');
    expect(resolveDocumentUpload('a.docx', zip).mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(resolveDocumentUpload('a.xlsx', zip).mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(resolveDocumentUpload('a.pptx', zip).mimeType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(resolveDocumentUpload('a.doc', ole).mimeType).toBe('application/msword');
    expect(resolveDocumentUpload('a.xls', ole).mimeType).toBe('application/vnd.ms-excel');
    expect(resolveDocumentUpload('a.png', png).mimeType).toBe('image/png');
    expect(resolveDocumentUpload('a.jpg', jpg).mimeType).toBe('image/jpeg');
    expect(resolveDocumentUpload('notes.txt', Buffer.from('plain readable text')).mimeType).toBe('text/plain');
  });

  it('rejects an unsupported extension and a content/extension mismatch', () => {
    expect(() => resolveDocumentUpload('malware.exe', pdf)).toThrow(EmployeeDocumentError);
    // .pdf extension but ZIP bytes → cross-check fails (fail-closed).
    expect(() => resolveDocumentUpload('fake.pdf', zip)).toThrow(EmployeeDocumentError);
    // .txt with binary NUL bytes → not plausibly text.
    expect(() => resolveDocumentUpload('binary.txt', Buffer.from([0x00, 0x01, 0x02]))).toThrow(EmployeeDocumentError);
  });
});
