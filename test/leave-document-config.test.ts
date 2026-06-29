/**
 * Supporting Document Configuration in Leave. Per-leave-type config layered on the existing mandatory-
 * document feature: Require Attachment + Mandatory-after-N-days (strict '>'), Allowed File Types, Max File
 * Size, and Employee-Remark-Required. The headline correctness fix is orphan-prevention — file mime/size
 * validation runs at the submission boundary (validateLeaveDocument) BEFORE requestLeave commits, so a bad
 * file never leaves a stray pending request behind. HR-remark is deferred (stored only), so decideLeave is
 * unaffected — guarded here too.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  addLeaveAttachment,
  requestLeave,
  decideLeave,
  validateLeaveDocument,
  LeaveDocumentRequiredError,
  LeaveRemarkRequiredError,
  LeaveDocumentTypeError,
  LeaveDocumentSizeError,
} from '../core/leave';
import { updateLeaveType } from '../core/admin';
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

/** Insert a leave type with the supporting-document columns the config feature adds. */
async function leaveType(
  code: string,
  opts: {
    requiresDocument?: boolean;
    mandatoryAfterDays?: number | null;
    allowedMimeTypes?: string[] | null;
    maxDocBytes?: number;
    employeeRemarkRequired?: boolean;
  } = {},
) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      requiresDocument: opts.requiresDocument ?? false,
      mandatoryAfterDays: opts.mandatoryAfterDays ?? null,
      allowedMimeTypes: opts.allowedMimeTypes ?? null,
      ...(opts.maxDocBytes != null ? { maxDocBytes: opts.maxDocBytes } : {}),
      employeeRemarkRequired: opts.employeeRemarkRequired ?? false,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function requestRows(employmentId: string) {
  return owner.db
    .select({ id: schema.leaveRequest.id, employeeRemark: schema.leaveRequest.employeeRemark })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.employmentId, employmentId));
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

describe('Supporting Document Configuration — mandatoryAfterDays boundary', () => {
  it('a 2.0-day request with no doc is accepted when mandatoryAfterDays=2 (exact boundary, == is allowed)', async () => {
    const a = adminCtx(b);
    const sick = await leaveType('SICK_AFTER2', { requiresDocument: true, mandatoryAfterDays: 2 });
    const emp = await hire();
    // 2026-07-01..2026-07-02 = exactly 2 calendar days. 2 > 2 is false ⇒ no doc required.
    await expect(
      requestLeave(a, { employmentId: emp.employmentId, leaveTypeId: sick, startDate: '2026-07-01', endDate: '2026-07-02' }),
    ).resolves.toMatchObject({ days: 2 });
  });

  it('a 3-day request with no doc is rejected with the specific interpolated message', async () => {
    const a = adminCtx(b);
    const sick = await leaveType('SICK_AFTER2_R', { requiresDocument: true, mandatoryAfterDays: 2 });
    const emp = await hire();
    // 3 calendar days. 3 > 2 ⇒ doc required.
    const err = await requestLeave(a, {
      employmentId: emp.employmentId,
      leaveTypeId: sick,
      startDate: '2026-07-01',
      endDate: '2026-07-03',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LeaveDocumentRequiredError);
    expect((err as LeaveDocumentRequiredError).afterDays).toBe(2);
    expect((err as Error).message).toContain('exceeding 2 days');
  });

  it('a 3-day request WITH a doc is accepted', async () => {
    const a = adminCtx(b);
    const sick = await leaveType('SICK_AFTER2_OK', { requiresDocument: true, mandatoryAfterDays: 2 });
    const emp = await hire();
    await expect(
      requestLeave(a, {
        employmentId: emp.employmentId,
        leaveTypeId: sick,
        startDate: '2026-07-01',
        endDate: '2026-07-03',
        hasDocument: true,
      }),
    ).resolves.toMatchObject({ days: 3 });
  });

  it('mandatoryAfterDays null/0 requires a doc on any day count (always-require)', async () => {
    const a = adminCtx(b);
    const sick = await leaveType('SICK_ALWAYS', { requiresDocument: true, mandatoryAfterDays: null });
    const emp = await hire();
    await expect(
      requestLeave(a, { employmentId: emp.employmentId, leaveTypeId: sick, startDate: '2026-07-01', endDate: '2026-07-01' }),
    ).rejects.toBeInstanceOf(LeaveDocumentRequiredError);
  });
});

describe('Supporting Document Configuration — validateLeaveDocument', () => {
  const PDF_JPG_PNG = ['application/pdf', 'image/jpeg', 'image/png'];

  it('rejects text/plain when allowedMimeTypes is pdf/jpg/png', () => {
    expect(() =>
      validateLeaveDocument({ allowedMimeTypes: PDF_JPG_PNG, maxDocBytes: 10 * 1024 * 1024 }, { mimeType: 'text/plain', sizeBytes: 10 }),
    ).toThrow(LeaveDocumentTypeError);
  });

  it('accepts application/pdf within the allow-list', () => {
    expect(() =>
      validateLeaveDocument({ allowedMimeTypes: PDF_JPG_PNG, maxDocBytes: 10 * 1024 * 1024 }, { mimeType: 'application/pdf', sizeBytes: 10 }),
    ).not.toThrow();
  });

  it('rejects an oversized file against the configured maxDocBytes', () => {
    expect(() =>
      validateLeaveDocument({ allowedMimeTypes: null, maxDocBytes: 1024 }, { mimeType: 'application/pdf', sizeBytes: 2048 }),
    ).toThrow(LeaveDocumentSizeError);
  });

  it('enforces the default 10 MB ceiling when maxDocBytes is unset', () => {
    const tenMb = 10 * 1024 * 1024;
    expect(() => validateLeaveDocument({ allowedMimeTypes: null, maxDocBytes: null }, { mimeType: 'application/pdf', sizeBytes: tenMb })).not.toThrow();
    expect(() => validateLeaveDocument({ allowedMimeTypes: null, maxDocBytes: null }, { mimeType: 'application/pdf', sizeBytes: tenMb + 1 })).toThrow(
      LeaveDocumentSizeError,
    );
  });

  it('empty/null allowedMimeTypes ⇒ no type restriction (backward-compat)', () => {
    expect(() => validateLeaveDocument({ allowedMimeTypes: [], maxDocBytes: null }, { mimeType: 'text/plain', sizeBytes: 10 })).not.toThrow();
    expect(() => validateLeaveDocument({ allowedMimeTypes: null, maxDocBytes: null }, { mimeType: 'text/plain', sizeBytes: 10 })).not.toThrow();
  });
});

describe('Supporting Document Configuration — backward-compat attachment path', () => {
  it('a requiresDocument type with null allowedMimeTypes still accepts the existing PDF upload', async () => {
    const a = adminCtx(b);
    const sick = await leaveType('SICK_NULLMIME', { requiresDocument: true });
    const emp = await hire();
    const { leaveRequestId } = await requestLeave(a, {
      employmentId: emp.employmentId,
      leaveTypeId: sick,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      hasDocument: true,
    });
    await expect(
      addLeaveAttachment(a, {
        leaveRequestId,
        fileName: 'mc.pdf',
        mimeType: 'application/pdf',
        content: Buffer.from('%PDF-1.4 mc'),
      }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('addLeaveAttachment rejects a disallowed mime type as defence-in-depth', async () => {
    const a = adminCtx(b);
    const sick = await leaveType('SICK_PDFONLY', { requiresDocument: true, allowedMimeTypes: ['application/pdf'] });
    const emp = await hire();
    const { leaveRequestId } = await requestLeave(a, {
      employmentId: emp.employmentId,
      leaveTypeId: sick,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      hasDocument: true,
    });
    await expect(
      addLeaveAttachment(a, { leaveRequestId, fileName: 'note.txt', mimeType: 'text/plain', content: Buffer.from('hi') }),
    ).rejects.toBeInstanceOf(LeaveDocumentTypeError);
  });
});

describe('Supporting Document Configuration — defaults are not-required', () => {
  it('a freshly seeded type has employeeRemarkRequired=false and no mime restriction', async () => {
    const [lt] = await owner.db
      .select({
        employeeRemarkRequired: schema.leaveType.employeeRemarkRequired,
        allowedMimeTypes: schema.leaveType.allowedMimeTypes,
        maxDocBytes: schema.leaveType.maxDocBytes,
        hrRemarkRequired: schema.leaveType.hrRemarkRequired,
      })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    expect(lt.employeeRemarkRequired).toBe(false);
    expect(lt.allowedMimeTypes).toBeNull();
    expect(lt.maxDocBytes).toBe(10 * 1024 * 1024);
    expect(lt.hrRemarkRequired).toBe(false);
  });
});

describe('Supporting Document Configuration — employee remark', () => {
  it('rejects when the remark is blank and the type requires it', async () => {
    const a = adminCtx(b);
    const lt = await leaveType('ANN_REMARK', { employeeRemarkRequired: true });
    const emp = await hire();
    await expect(
      requestLeave(a, { employmentId: emp.employmentId, leaveTypeId: lt, startDate: '2026-07-01', endDate: '2026-07-01' }),
    ).rejects.toBeInstanceOf(LeaveRemarkRequiredError);
  });

  it('accepts with a remark and persists it on the row', async () => {
    const a = adminCtx(b);
    const lt = await leaveType('ANN_REMARK_OK', { employeeRemarkRequired: true });
    const emp = await hire();
    await requestLeave(a, {
      employmentId: emp.employmentId,
      leaveTypeId: lt,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      employeeRemark: '  Childcare emergency  ',
    });
    const rows = await requestRows(emp.employmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].employeeRemark).toBe('Childcare emergency'); // trimmed
  });
});

describe('Supporting Document Configuration — orphan prevention', () => {
  it('a disallowed/oversized file rejected by validateLeaveDocument writes no request and no event', async () => {
    const a = adminCtx(b);
    const sick = await leaveType('SICK_ORPHAN', { requiresDocument: true, allowedMimeTypes: ['application/pdf'], maxDocBytes: 1024 });
    const emp = await hire();
    // Simulate the /me action sequence: the file gate runs BEFORE requestLeave, so on rejection the caller
    // never reaches the committing call.
    const rule = { allowedMimeTypes: ['application/pdf'], maxDocBytes: 1024 };
    let committed = false;
    try {
      validateLeaveDocument(rule, { mimeType: 'text/plain', sizeBytes: 10 }); // disallowed type → throws here
      await requestLeave(a, { employmentId: emp.employmentId, leaveTypeId: sick, startDate: '2026-07-01', endDate: '2026-07-01', hasDocument: true });
      committed = true;
    } catch (e) {
      expect(e).toBeInstanceOf(LeaveDocumentTypeError);
    }
    expect(committed).toBe(false);
    const rows = await requestRows(emp.employmentId);
    expect(rows).toHaveLength(0);
    const events = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.subjectEmploymentId, emp.employmentId),
          eq(schema.domainEvent.eventType, 'leave-request.submitted'),
        ),
      );
    expect(events).toHaveLength(0);
  });
});

describe('Supporting Document Configuration — no HR-remark regression', () => {
  it('decideLeave still approves and rejects normally with hr_remark_required set (deferred, not enforced)', async () => {
    const a = adminCtx(b);
    const lt = await leaveType('ANN_DECIDE');
    // hr_remark_required defaults false; set it true via the admin service to prove it does not block decisions.
    await updateLeaveType(a, { id: lt, name: 'ANN_DECIDE', hrRemarkRequired: true });
    const emp = await hire();
    // Give the subject a balance so the approval can debit the ledger.
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: lt,
      entryType: 'accrual',
      days: '20.00',
      effectiveOn: '2026-01-01',
    });

    const { leaveRequestId: r1 } = await requestLeave(a, {
      employmentId: emp.employmentId,
      leaveTypeId: lt,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
    await expect(decideLeave(a, { leaveRequestId: r1, decision: 'approved' })).resolves.toBeDefined();
    const { leaveRequestId: r2 } = await requestLeave(a, {
      employmentId: emp.employmentId,
      leaveTypeId: lt,
      startDate: '2026-08-01',
      endDate: '2026-08-01',
    });
    // Partial Leave Approval (0131): a reject now requires a reason.
    await expect(decideLeave(a, { leaveRequestId: r2, decision: 'rejected', rejectReason: 'declined' })).resolves.toBeDefined();

    const rows = await owner.db
      .select({ id: schema.leaveRequest.id, status: schema.leaveRequest.status })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, emp.employmentId));
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(r1)).toBe('approved');
    expect(byId.get(r2)).toBe('rejected');
  });
});
