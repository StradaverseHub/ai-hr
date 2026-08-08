/**
 * c8052ae3 — the record of the leave_ledger rows the Medical / Hospitalization reset removes, its SQL
 * capture, and the reader the reporter opens.
 *
 * The approved plan's words: "Before anything is removed, copy every affected record into a permanent
 * written record you can read on screen and download, so the old figures are never lost." This file is
 * what makes that checkable rather than asserted, and it matters more here than for the configuration
 * record it is modelled on: those were settings somebody could retype, these are 147 grants to named
 * employees, deleted out of a ledger documented as append-only.
 *
 * ⚠️ WHY THE CAPTURE IS TESTED AND THE CONFIGURATION-RECORD CAPTURE COULD NOT BE. `app.capture_entitlement_
 * reset_archive` reads three tables release three then dropped, so its tests were retired. This capture
 * reads leave_ledger, leave_entitlement_recalc_audit, employment, person, company and leave_type — all of
 * which survive — so the rendering IS exercised against real seeded rows, which is the whole reason
 * migration 0416 ships a FUNCTION rather than an INSERT.
 *
 * ⚠️ AND IT PINS THE SQL THE CORRECTION SCRIPT ACTUALLY SENDS. The uuid[] array binding and the
 * `select … from app.capture_leave_ledger_reset_archive(text, uuid, uuid[])` call shape below are the same
 * ones scripts/reset-medical-hospitalization-ledger.ts uses. That script is deliberately never run in a
 * test — it deletes from an append-only ledger and is gated on a production tenant id — so this is where
 * its query shapes get to fail cheaply instead of expensively. It has already earned its keep once: the
 * obvious `${ids}::uuid[]` binding is silently wrong in drizzle and the script carried it until this file
 * ran (see `uuidArray` below).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  leaveLedgerResetArchiveCsv,
  listLeaveLedgerArchiveCaptures,
  listLeaveLedgerResetArchive,
} from '../core/leave-ledger-archive';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const TAG = 'c8052ae3-test';

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

/**
 * The capture, called exactly the way scripts/reset-medical-hospitalization-ledger.ts calls it — including
 * `uuidArray`.
 *
 * ⚠️ THE ARRAY BINDING IS THE REASON THIS HELPER IS SHARED-BY-DUPLICATION RATHER THAN OBVIOUS. A plain
 * `${ids}::uuid[]` in a drizzle template does NOT bind a Postgres array: drizzle SPREADS a JS array into
 * one placeholder per element, so the query goes out as `($3)::uuid[]` with a bare uuid string bound to
 * it and Postgres answers `malformed array literal`. Caught here, which is the whole point of testing the
 * capture — the correction script is deliberately never executed in a test, so this is the only place its
 * query shape gets to fail cheaply.
 */
const uuidArray = (ids: string[]) => sql`array[${sql.join(ids.map((v) => sql`${v}::uuid`), sql`, `)}]::uuid[]`;
const capture = async (tag: string, typeIds: string[], tenantId = b.tenantId) =>
  (await owner.db.execute(
    sql`select ledger_rows, audit_rows from app.capture_leave_ledger_reset_archive(
          ${tag}, ${tenantId}::uuid, ${uuidArray(typeIds)})`,
  )) as unknown as { ledger_rows: number; audit_rows: number }[];

/** The message Postgres actually raised — see the refusal test for why the wrapper will not do. */
const captureError = async (tag: string, typeIds: string[]): Promise<string> => {
  try {
    await capture(tag, typeIds);
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? '';
  }
  return '(no error was thrown)';
};

const hire = (fullName: string, email: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName, primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
    gradeId: null,
    grantLeaveTypes: [],
  });

/** A ledger row written straight in — the capture's job is to RENDER rows, not to create them. */
const ledgerRow = (
  employmentId: string,
  p: { days: string; effectiveOn: string; entryType?: 'accrual' | 'adjustment'; reason?: string | null },
) =>
  owner.db
    .insert(schema.leaveLedger)
    .values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: p.entryType ?? 'accrual',
      days: p.days,
      effectiveOn: p.effectiveOn,
      reason: p.reason ?? null,
    })
    .returning({ id: schema.leaveLedger.id });

const archiveRows = (layer?: string) =>
  owner.db
    .select()
    .from(schema.leaveLedgerResetArchive)
    .where(
      layer
        ? and(
            eq(schema.leaveLedgerResetArchive.captureTag, TAG),
            eq(schema.leaveLedgerResetArchive.layer, layer),
          )
        : eq(schema.leaveLedgerResetArchive.captureTag, TAG),
    );

describe('c8052ae3 — the capture writes a record that outlives the rows', () => {
  it('renders every ledger row to text, with the employee, the figure and the date', async () => {
    const emp = await hire('Mei Ling', 'meiling.c8052ae3@t.local');
    await ledgerRow(emp.employmentId, { days: '60.00', effectiveOn: '2026-01-06' });
    await ledgerRow(emp.employmentId, {
      days: '-120.00',
      effectiveOn: '2026-07-23',
      entryType: 'adjustment',
      reason: `sys:profile_recalc:${emp.employmentId}`,
    });

    const [res] = await capture(TAG, [b.annualLeaveTypeId]);
    expect(Number(res.ledger_rows)).toBe(2);

    const rows = await archiveRows('ledger');
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.employeeName).toBe('Mei Ling');
      expect(r.leaveTypeCode).toBe('ANNUAL');
      // THE PROPERTY THE WHOLE DESIGN RESTS ON: no ids that can dangle. The source row id is text and
      // carries no reference, so the record survives the delete that follows it.
      expect(r.sourceRowId).toMatch(/^[0-9a-f-]{36}$/);
      // The safety argument written onto every row, rather than left as a blank cell to be interpreted.
      expect(r.sourceRequestText).toBe('not sourced from a leave request');
    }
    const grant = rows.find((r) => r.entryType === 'accrual')!;
    expect(grant.daysText).toBe('60.00');
    expect(grant.effectiveOnText).toBe('2026-01-06');
    const clawback = rows.find((r) => r.entryType === 'adjustment')!;
    expect(clawback.daysText).toBe('-120.00');
    expect(clawback.reason).toBe(`sys:profile_recalc:${emp.employmentId}`);
  });

  it('archives the recalc-audit rows too, with the previous → new figures written out', async () => {
    const emp = await hire('Mei Ling', 'meiling2.c8052ae3@t.local');
    const [led] = await ledgerRow(emp.employmentId, {
      days: '-120.00',
      effectiveOn: '2026-07-23',
      entryType: 'adjustment',
      reason: `sys:profile_recalc:${emp.employmentId}`,
    });
    // The production figures verbatim: 180.00 read against a real single-year grant of 60.00.
    await owner.db.insert(schema.leaveEntitlementRecalcAudit).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      previousEntitlement: '180.00',
      newEntitlement: '60.00',
      delta: '-120.00',
      reason: 'employment_changed',
      effectiveOn: '2026-07-23',
      ledgerId: led.id,
    });

    const [res] = await capture(TAG, [b.annualLeaveTypeId]);
    expect(Number(res.audit_rows)).toBe(1);
    const [row] = await archiveRows('recalc_audit');
    // This sentence is the evidence that the negatives came from the recalc window and not from leftover
    // configuration. It has to survive the rows it describes, or the diagnosis is lost with them.
    expect(row.entitlementText).toBe('previous 180.00 → new 60.00 (delta -120.00)');
    expect(row.daysText).toBe('-120.00');
    expect(row.reason).toBe('employment_changed');
    expect(row.entryType).toBeNull();
  });

  it('flags a future-dated grant, because that is the row nobody expects to find', async () => {
    const emp = await hire('Ahmad', 'ahmad.c8052ae3@t.local');
    await ledgerRow(emp.employmentId, { days: '60.00', effectiveOn: '2028-01-01' });
    await capture(TAG, [b.annualLeaveTypeId]);
    const [row] = await archiveRows('ledger');
    expect(row.note).toMatch(/future-dated/i);
  });

  it('scopes to the tenant and the named types, and touches nothing else', async () => {
    const emp = await hire('Siti', 'siti.c8052ae3@t.local');
    const [other] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'UPM', name: 'Unpaid Medical Leave', paid: false })
      .returning({ id: schema.leaveType.id });
    await ledgerRow(emp.employmentId, { days: '14.00', effectiveOn: '2026-01-06' });
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: other.id,
      entryType: 'accrual',
      days: '5.00',
      effectiveOn: '2026-01-06',
    });

    const [res] = await capture(TAG, [b.annualLeaveTypeId]);
    expect(Number(res.ledger_rows)).toBe(1);
    const rows = await archiveRows('ledger');
    expect(rows.map((r) => r.leaveTypeCode)).toEqual(['ANNUAL']);
  });

  it('re-running the SAME tag is a no-op — a double-click cannot double the record', async () => {
    const emp = await hire('Kumar', 'kumar.c8052ae3@t.local');
    await ledgerRow(emp.employmentId, { days: '14.00', effectiveOn: '2026-01-06' });
    const [first] = await capture(TAG, [b.annualLeaveTypeId]);
    const [second] = await capture(TAG, [b.annualLeaveTypeId]);
    expect(Number(first.ledger_rows)).toBe(1);
    expect(Number(second.ledger_rows)).toBe(0);
    expect((await archiveRows('ledger')).length).toBe(1);
  });

  it('refuses a blank tag and an empty type list rather than reporting a capture of nothing', async () => {
    // Both matter because the CALLER'S NEXT STEP IS A DELETE. "Captured 0 rows, proceeding" is the exact
    // failure the whole verify-before-delete sequence exists to make impossible.
    //
    // ⚠️ ASSERTED ON THE POSTGRES MESSAGE, NOT ON `rejects.toThrow`. drizzle wraps every query failure in
    // `Error: Failed query: …` and hangs the real one off `.cause`, so `rejects.toThrow(/…/)` matches the
    // WRAPPER and passes for any failure at all — including the malformed-array bug this very file found.
    // A refusal test that passes when the query is simply broken proves nothing.
    expect(await captureError('   ', [b.annualLeaveTypeId])).toMatch(/capture tag is required/i);
    expect(await captureError(TAG, [])).toMatch(/at least one leave type id is required/i);
  });
});

describe('c8052ae3 — the reader is what turns the record into a promise kept', () => {
  it('the admin listing reads it through the app role (so the GRANT and the RLS both hold)', async () => {
    const emp = await hire('Mei Ling', 'meiling3.c8052ae3@t.local');
    await ledgerRow(emp.employmentId, { days: '60.00', effectiveOn: '2026-01-06' });
    await capture(TAG, [b.annualLeaveTypeId]);

    // Through adminCtx, i.e. the ai_hr_app role under RLS — the exact path the page takes. A missing
    // GRANT on a CREATE TABLE migration is invisible on production (ALTER DEFAULT PRIVILEGES masks it)
    // and throws 'permission denied' on a restored cluster, so this assertion is the one that catches it.
    const rows = await listLeaveLedgerResetArchive(adminCtx(b));
    expect(rows.length).toBe(1);
    expect(rows[0].employeeName).toBe('Mei Ling');
    expect(rows[0].layer).toBe('ledger');
  });

  it('offers each capture run separately and opens on the newest', async () => {
    const emp = await hire('Mei Ling', 'meiling4.c8052ae3@t.local');
    await ledgerRow(emp.employmentId, { days: '60.00', effectiveOn: '2026-01-06' });
    await capture('rehearsal', [b.annualLeaveTypeId]);
    // A later tag is a new snapshot, and interleaving two would have somebody reading a mixture of both.
    await owner.db
      .update(schema.leaveLedgerResetArchive)
      .set({ capturedAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(schema.leaveLedgerResetArchive.captureTag, 'rehearsal'));
    await capture('the-real-run', [b.annualLeaveTypeId]);

    const captures = await listLeaveLedgerArchiveCaptures(adminCtx(b));
    expect(captures.map((c) => c.captureTag)).toEqual(['the-real-run', 'rehearsal']);
    expect(captures[0].rows).toBe(1);
    // No tag ⇒ the newest, which is what the screen opens on.
    const latest = await listLeaveLedgerResetArchive(adminCtx(b));
    expect(latest.every((r) => r.captureTag === 'the-real-run')).toBe(true);
    const chosen = await listLeaveLedgerResetArchive(adminCtx(b), { captureTag: 'rehearsal' });
    expect(chosen.every((r) => r.captureTag === 'rehearsal')).toBe(true);
  });

  it('the ledger layer sorts before the recalc history, so the record reads as what was removed first', async () => {
    const emp = await hire('Mei Ling', 'meiling5.c8052ae3@t.local');
    await ledgerRow(emp.employmentId, { days: '60.00', effectiveOn: '2026-01-06' });
    await owner.db.insert(schema.leaveEntitlementRecalcAudit).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      previousEntitlement: '180.00',
      newEntitlement: '60.00',
      delta: '-120.00',
      reason: 'grade_changed',
      effectiveOn: '2026-07-23',
    });
    await capture(TAG, [b.annualLeaveTypeId]);
    const rows = await listLeaveLedgerResetArchive(adminCtx(b));
    expect(rows.map((r) => r.layer)).toEqual(['ledger', 'recalc_audit']);
  });

  it('the CSV spells the "no leave request" fact out rather than leaving a blank cell', async () => {
    const emp = await hire('Mei Ling', 'meiling6.c8052ae3@t.local');
    await ledgerRow(emp.employmentId, { days: '60.00', effectiveOn: '2026-01-06' });
    await capture(TAG, [b.annualLeaveTypeId]);

    const file = await leaveLedgerResetArchiveCsv(adminCtx(b));
    expect(file.rows).toBe(1);
    expect(file.filename).toBe(`leave-balance-record_${TAG}.csv`);
    const [header, first] = file.content.split('\r\n');
    expect(header).toContain('Leave request');
    // In a spreadsheet a blank cell reads as "unknown", and "nobody ever took this leave" is the fact the
    // whole correction rests on.
    expect(first).toContain('not sourced from a leave request');
    expect(first).toContain('Mei Ling');
    expect(first).toContain('60.00');
  });
});

describe('c8052ae3 — migration 0416 posture', () => {
  const sqlText = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations', '0416_leave_ledger_reset_archive.sql'),
    'utf8',
  );

  it('GRANTs on the new table (production masks the omission; a restored cluster does not)', () => {
    expect(sqlText).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_ledger_reset_archive" TO ai_hr_app/);
    expect(sqlText).toMatch(/GRANT EXECUTE ON FUNCTION app\.capture_leave_ledger_reset_archive/);
  });

  it('enables RLS and gates BOTH halves on admin — these rows name every employee and every day granted', () => {
    expect(sqlText).toMatch(/ALTER TABLE leave_ledger_reset_archive ENABLE ROW LEVEL SECURITY/);
    expect(sqlText).toMatch(/USING \(tenant_id = app\.current_tenant_id\(\) AND app\.is_admin\(\)\)/);
    expect(sqlText).toMatch(/WITH CHECK \(tenant_id = app\.current_tenant_id\(\) AND app\.is_admin\(\)\)/);
  });

  it('the migration itself captures nothing and deletes nothing — shipping it is not the correction', () => {
    // 0398 took its first capture inside the migration. This one deliberately does not: the capture and
    // the deletion are one gated operator action, and a migration that captured on deploy would put an
    // empty-or-stale snapshot in the table before anybody decided to run anything.
    expect(sqlText).not.toMatch(/^\s*DELETE FROM/mi);
    expect(sqlText).not.toMatch(/SELECT \* INTO .* FROM app\.capture_leave_ledger_reset_archive/i);
    expect(sqlText).not.toMatch(/^\s*DO \$\$/m);
  });
});
