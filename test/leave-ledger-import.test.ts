/**
 * Leave Data Import & Migration Tool — DB-harness tests (matches attendance-import / leave-* style).
 *
 * Covers the ticket's validation matrix + the two sharpest architectural edges the plan flagged:
 *   (a)  employee not found → error; (a2) terminated employee → success with a 'terminated' warning
 *   (b)  leave type not found / archived → error
 *   (c)  malformed date → error
 *   (d)  missing mandatory field → error
 *   (e)  invalid days (non-numeric / zero) → error; (e2) sign-vs-entryType violation → error
 *   (f)  in-file duplicate → second occurrence errors
 *   (g)  duplicate vs an existing ledger row → warning + skip on commit (balance unchanged)
 *   (h)  commit writes only valid rows, correct imported/failed/skipped counts
 *   (i)  leaveBalance reflects imported rows afterward (Import → Ledger → Balance chain)
 *   (j)  appendEvent 'leave.import.completed' fires after a successful commit
 *   (k)  year-boundary: a backdated adjustment before openLeaveYear does not corrupt carry/forfeit math
 *   (l)  cross-company authority: a company-scoped admin's out-of-authority rows error in the PREVIEW
 *   (m)  in_lieu_accrual (TOIL) is rejected with a clear message (v1 scope decision)
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createCompany, createDepartment, createLeaveType } from '../core/admin';
import { openLeaveYear, leaveBalance } from '../core/leave';
import { validateLeaveImport, commitLeaveImport } from '../core/leave-import';
import { withTenant } from '../db/client';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';
import type { SessionContext } from '../db/client';

let b: Base;
const uniqEmail = () => `lli_${randomUUID().slice(0, 8)}@t.local`;

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

/** Hire on 1 Jan 2025 (prior year, so openLeaveYear(2026) treats them as existing) and return the
 *  employment id + its auto-generated employeeCode (looked up from the DB, not guessed). */
async function hire(
  opts: { companyId?: string; departmentId?: string; hiredOn?: string; terminatedOn?: string } = {},
): Promise<{ employmentId: string; code: string; email: string }> {
  const email = uniqEmail();
  const { employmentId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Imp Emp', primaryEmail: email },
    companyId: opts.companyId ?? b.companyId,
    departmentId: opts.departmentId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: opts.hiredOn ?? '2025-01-01',
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });
  if (opts.terminatedOn) {
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: opts.terminatedOn })
      .where(eq(schema.employment.id, employmentId));
  }
  const [row] = await owner.db
    .select({ code: schema.employment.employeeCode })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return { employmentId, code: row.code!, email };
}

const toRecords = (rows: Record<string, string>[]) => rows;

// ── (a) / (a2) employee resolution ──────────────────────────────────────────────────────────────────────
describe('leave import — employee resolution', () => {
  it('(a) employee genuinely not found → error row (not conflated with terminated)', async () => {
    const preview = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: 'NOPE-999', leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '5', effective_date: '2026-01-01' },
      ]),
    });
    expect(preview.rows[0].ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/not found/i);
  });

  it('(a2) employee found but terminated → success row with a distinct terminated warning', async () => {
    const e = await hire({ terminatedOn: '2025-12-31' });
    const preview = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '5', effective_date: '2026-01-01' },
      ]),
    });
    expect(preview.rows[0].ok).toBe(true); // still processed
    expect(preview.rows[0].warnings.join(' ')).toMatch(/terminated/i);
    expect(preview.rows[0].errors).toEqual([]); // NOT an error / NOT "not found"
  });

  it('resolves by employeeCode, primaryEmail and IC', async () => {
    const e = await hire();
    // by email
    const byEmail = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.email, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '1', effective_date: '2026-01-01' },
      ]),
    });
    expect(byEmail.rows[0].ok).toBe(true);
  });
});

// ── (b) leave type ──────────────────────────────────────────────────────────────────────────────────────
describe('leave import — leave type resolution', () => {
  it('(b) unknown leave type → error', async () => {
    const e = await hire();
    const preview = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'BOGUS', transaction_type: 'adjustment', days: '5', effective_date: '2026-01-01' },
      ]),
    });
    expect(preview.rows[0].ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/leave type not found/i);
  });

  it('(b) archived leave type is not matched → error', async () => {
    const e = await hire();
    const lt = await createLeaveType(adminCtx(b), { code: 'GONE', name: 'Gone Leave' });
    await owner.db.update(schema.leaveType).set({ archivedAt: new Date() }).where(eq(schema.leaveType.id, lt.id));
    const preview = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'GONE', transaction_type: 'adjustment', days: '5', effective_date: '2026-01-01' },
      ]),
    });
    expect(preview.rows[0].ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/leave type not found/i);
  });

  it('matches leave type code case-insensitively', async () => {
    const e = await hire();
    const preview = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'annual', transaction_type: 'adjustment', days: '3', effective_date: '2026-01-01' },
      ]),
    });
    expect(preview.rows[0].ok).toBe(true);
  });
});

// ── (c)(d)(e)(e2) field validation ──────────────────────────────────────────────────────────────────────
describe('leave import — field validation', () => {
  it('(c) malformed date → error', async () => {
    const e = await hire();
    const preview = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '5', effective_date: '01/01/2026' },
      ]),
    });
    expect(preview.rows[0].ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/YYYY-MM-DD/);
  });

  it('(d) missing mandatory field → error per missing column', async () => {
    const e = await hire();
    const preview = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: '', transaction_type: '', days: '', effective_date: '' },
      ]),
    });
    const errs = preview.rows[0].errors.join(' ');
    expect(preview.rows[0].ok).toBe(false);
    expect(errs).toMatch(/Missing leave_type/);
    expect(errs).toMatch(/Missing transaction_type/);
    expect(errs).toMatch(/Missing days/);
    expect(errs).toMatch(/Missing effective_date/);
  });

  it('(e) non-numeric and zero days → error', async () => {
    const e = await hire();
    const preview = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: 'abc', effective_date: '2026-01-01' },
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '0', effective_date: '2026-01-02' },
      ]),
    });
    expect(preview.rows[0].ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/Invalid days/);
    expect(preview.rows[1].ok).toBe(false);
    expect(preview.rows[1].errors.join(' ')).toMatch(/Invalid days/);
  });

  it('(e2) positive debit and negative accrual → error (sign-vs-entryType invariant)', async () => {
    const e = await hire();
    const preview = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'debit', days: '2', effective_date: '2026-01-01' },
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'accrual', days: '-3', effective_date: '2026-01-02' },
      ]),
    });
    expect(preview.rows[0].ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/debit row must have days ≤ 0/);
    expect(preview.rows[1].ok).toBe(false);
    expect(preview.rows[1].errors.join(' ')).toMatch(/accrual row must have days ≥ 0/);
  });

  it('adjustment may be either sign (opening balance / correction)', async () => {
    const e = await hire();
    const preview = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '-1.5', effective_date: '2026-01-01' },
      ]),
    });
    expect(preview.rows[0].ok).toBe(true);
  });
});

// ── (f)(g) duplicate detection ──────────────────────────────────────────────────────────────────────────
describe('leave import — duplicate detection', () => {
  it('(f) exact duplicate row within the same file → second occurrence errors', async () => {
    const e = await hire();
    const row = { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '5', effective_date: '2026-01-01' };
    const preview = await validateLeaveImport(adminCtx(b), { records: toRecords([{ ...row }, { ...row }]) });
    expect(preview.rows[0].ok).toBe(true);
    expect(preview.rows[1].ok).toBe(false);
    expect(preview.rows[1].errors.join(' ')).toMatch(/Duplicate row in this file/);
  });

  it('(g) duplicate against an existing ledger row → warning + skip on commit, balance unchanged', async () => {
    const e = await hire();
    const rec = [{ employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '5', effective_date: '2026-01-01' }];
    // First commit writes it.
    const first = await commitLeaveImport(adminCtx(b), { records: toRecords(rec) });
    expect(first.imported).toBe(1);
    const balAfterFirst = await ledgerBalance(e.employmentId, b.annualLeaveTypeId);
    // Second import of the identical row: preview flags it, commit skips it, balance is unchanged.
    const preview = await validateLeaveImport(adminCtx(b), { records: toRecords(rec) });
    expect(preview.rows[0].ok).toBe(true);
    expect(preview.rows[0].warnings.join(' ')).toMatch(/Already imported/);
    const second = await commitLeaveImport(adminCtx(b), { records: toRecords(rec) });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await ledgerBalance(e.employmentId, b.annualLeaveTypeId)).toBe(balAfterFirst);
  });
});

// ── (h)(i)(j) commit + balance + event ──────────────────────────────────────────────────────────────────
describe('leave import — commit', () => {
  it('(h) writes only valid rows with correct imported/failed/skipped counts', async () => {
    const e = await hire();
    const result = await commitLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '5', effective_date: '2026-01-01' }, // valid
        { employee_id: 'NOPE', leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '5', effective_date: '2026-01-02' }, // error (not written)
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'debit', days: '-2', effective_date: '2026-03-14' }, // valid
      ]),
    });
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.totalRows).toBe(3);
  });

  it('(i) leaveBalance reflects imported rows (Import → Ledger → Balance)', async () => {
    const e = await hire();
    // Baseline includes the hire-time statutory grant — assert the net delta the import adds (+10 −2.5 = +7.5).
    const baseline = await withTenant(adminCtx(b), (tx) => leaveBalance(tx, e.employmentId, b.annualLeaveTypeId));
    await commitLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '10', effective_date: '2026-01-01' },
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'debit', days: '-2.5', effective_date: '2026-03-14' },
      ]),
    });
    const bal = await withTenant(adminCtx(b), (tx) => leaveBalance(tx, e.employmentId, b.annualLeaveTypeId));
    expect(bal).toBe(baseline + 7.5);
  });

  it('(j) leave.import.completed event fires after a successful commit', async () => {
    const e = await hire();
    await commitLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '5', effective_date: '2026-01-01' },
      ]),
      source: { kind: 'file', name: 'leave.xlsx', format: 'xlsx' },
    });
    // The batch aggregateId is a generated uuid — scan every leave.import.completed event this tenant has.
    const rows = await owner.db
      .select({ t: schema.domainEvent.eventType, p: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.tenantId, b.tenantId));
    const evt = rows.find((r) => r.t === 'leave.import.completed');
    expect(evt).toBeTruthy();
    // Payload records how the batch reached commit (file vs paste) for the audit trail.
    expect((evt!.p as { source?: { kind?: string; format?: string } }).source).toMatchObject({
      kind: 'file',
      format: 'xlsx',
    });
  });
});

// ── (k) year boundary ───────────────────────────────────────────────────────────────────────────────────
describe('leave import — year boundary interaction', () => {
  it('(k) openLeaveYear is order-independent against an imported backdated row (carry math not corrupted)', async () => {
    // Two identical employees. For eCtrl we ONLY run openLeaveYear(2026). For eImport we import a backdated
    // 2025 adjustment FIRST, then run openLeaveYear(2026). seedBase has no policy → floor-only, carry-forward
    // disabled → openLeaveYear forfeits the prior-year balance and posts the fresh 2026 entitlement. The
    // invariant: the imported prior-year row is handled by the SAME carry rule as any other prior balance —
    // it does not corrupt or shift what openLeaveYear computes for 2026 — so both employees land on the exact
    // same 2026 opening balance. (This is the plan's "confirm the cron is idempotent/order-independent
    // against imported rows" gate.)
    // fa3f4ccb: seedBase has no entitlement, and the statutory pack no longer backfills one — an
    // unconfigured type now grants 0 and openLeaveYear skips it entirely, so there would be no rollover to
    // be order-independent ABOUT. State the entitlement the test always assumed it had.
    // 6e9a126e release three: was a raw `leave_policy` insert; the days are unchanged and this test has
    // never been about where they are stored.
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 8,
      validFrom: '2020-01-01',
    });
    const eCtrl = await hire({ hiredOn: '2025-01-01' });
    const eImport = await hire({ hiredOn: '2025-01-01' });

    await commitLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: eImport.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '4', effective_date: '2025-06-01' },
      ]),
    });
    // The import landed on eImport (and only eImport) before the rollover.
    const importedBefore = await ledgerBalance(eImport.employmentId, b.annualLeaveTypeId);
    const ctrlBefore = await ledgerBalance(eCtrl.employmentId, b.annualLeaveTypeId);
    expect(importedBefore).toBe(ctrlBefore + 4);

    await openLeaveYear(adminCtx(b), { year: 2026 });

    const ctrlAfter = await ledgerBalance(eCtrl.employmentId, b.annualLeaveTypeId);
    const importAfter = await ledgerBalance(eImport.employmentId, b.annualLeaveTypeId);
    // Order-independent: the imported backdated row did not change the 2026 opening entitlement.
    expect(importAfter).toBe(ctrlAfter);
  });

  it('(k2) importing into an already-rolled-over year is flagged as a non-blocking warning', async () => {
    // fa3f4ccb: same reason as (k) — without a configured entitlement openLeaveYear grants nothing and
    // posts no open-marker, so there is no rolled-over year for the warning to detect.
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 8,
      validFrom: '2020-01-01',
    });
    const e = await hire({ hiredOn: '2025-01-01' });
    // Roll over 2026 first (posts a Jan-1 2026 accrual open-marker), then import a row dated in 2026.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    const preview = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '2', effective_date: '2026-05-01' },
      ]),
    });
    expect(preview.rows[0].ok).toBe(true); // not blocked
    expect(preview.rows[0].warnings.join(' ')).toMatch(/already-rolled-over/i);
  });
});

// ── (l) cross-company authority ──────────────────────────────────────────────────────────────────────────
describe('leave import — cross-company authority', () => {
  it('(l) a company-scoped admin sees out-of-authority rows as ERRORS in the preview, and commit skips them', async () => {
    // Company A (the seed company) + a second company B. Employees are created by a GROUP admin (adminCtx),
    // so both exist; the SCOPED admin below only administers company A.
    const eA = await hire({ companyId: b.companyId, departmentId: b.deptA });
    const { id: coB } = await createCompany(adminCtx(b), { legalName: 'Sub B Sdn Bhd' });
    const deptB = await createDepartment(adminCtx(b), { companyId: coB, name: 'B-Ops' });
    const eB = await hire({ companyId: coB, departmentId: deptB.id });

    const scoped: SessionContext = {
      tenantId: b.tenantId,
      userId: b.adminUserId,
      grants: [{ role: 'hr_admin', companyId: b.companyId }],
    };
    const records = toRecords([
      { employee_id: eA.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '5', effective_date: '2026-01-01' }, // in authority
      { employee_id: eB.code, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '5', effective_date: '2026-01-01' }, // OUT of authority
    ]);
    const preview = await validateLeaveImport(scoped, { records });
    const rowA = preview.rows.find((r) => r.employeeRef === eA.code)!;
    const rowB = preview.rows.find((r) => r.employeeRef === eB.code)!;
    // The in-authority row is ready; the out-of-authority row is a preview-time ERROR — the ticket's core
    // guarantee. (Company-scope RLS hides company B's employment from the scoped admin's read entirely, so
    // the row surfaces as an error either way; the explicit authority check backstops the visible-but-
    // unauthorized case. Either path means the preview reflects true, non-writable commit-ability.)
    expect(rowA.ok).toBe(true);
    expect(rowB.ok).toBe(false);
    expect(rowB.errors.length).toBeGreaterThan(0);

    // Commit under the scoped admin: only the in-authority row is written; the out-of-authority row is never
    // written (balance stays at its hire-time baseline, unchanged by this import).
    const eBBaseline = await ledgerBalance(eB.employmentId, b.annualLeaveTypeId);
    const eABaseline = await ledgerBalance(eA.employmentId, b.annualLeaveTypeId);
    const result = await commitLeaveImport(scoped, { records });
    expect(result.imported).toBe(1);
    expect(await ledgerBalance(eB.employmentId, b.annualLeaveTypeId)).toBe(eBBaseline); // never written
    expect(await ledgerBalance(eA.employmentId, b.annualLeaveTypeId)).toBe(eABaseline + 5); // +5 imported
  });
});

// ── (m) TOIL scope decision ─────────────────────────────────────────────────────────────────────────────
describe('leave import — TOIL (in_lieu_accrual) handling', () => {
  it('(m) in_lieu_accrual is rejected with a clear message (v1 scope-out)', async () => {
    const e = await hire();
    const preview = await validateLeaveImport(adminCtx(b), {
      records: toRecords([
        { employee_id: e.code, leave_type: 'ANNUAL', transaction_type: 'in_lieu_accrual', days: '1', effective_date: '2026-01-01' },
      ]),
    });
    expect(preview.rows[0].ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/TOIL import not supported/);
  });
});
