/**
 * r292 / readiness 3.2 — "THERE IS NO FILED STATE TO REACH".
 *
 * WHAT WAS WRONG, VERIFIED ON PRODUCTION 2026-09-16 (read-only, as the migration role):
 *   select status, count(*) from statutory_report group by status  ->  draft|20
 * Both insert sites hardcoded `status: 'draft'` (core/reporting.ts:302 and :368) and NOTHING anywhere
 * updated the column, so 'final' | 'submitted' | 'amended' were unreachable. The damage was downstream:
 * `batchDownstreamWarnings.statutoryFiled` was `rows.length > 0`, so the amber "already filed" warning on
 * Unlock / Reset / Remove-employee / Individual Transaction fired for a PREVIEW somebody had recorded,
 * and could never fire for a return that had really been lodged. It misled in both directions.
 *
 * ── WHY EVERY ASSERTION BELOW IS PAIRED ─────────────────────────────────────────────────────────────
 * A test that only files something and then finds it filed passes just as happily against code that
 * marks EVERYTHING filed — which is the identical defect with the sign flipped. So every arm here is
 * pinned with its opposite: a filed return reports filed AND an untouched one still reports draft; a
 * refusal throws AND leaves the row byte-unchanged; the warning goes true AND was false while the only
 * artefact for the month was a draft (that last one is the assertion the OLD code fails).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { markReportFiled, reverseReportFiling, StatutoryFilingError } from '../core/reporting';
import { batchEditImpact, createBatch } from '../core/payroll';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let base: Base;
let a: SessionContext;

/** A recorded statutory artefact, exactly as `recordReport` leaves one: status 'draft', no filing. */
async function draftReport(p: { reportType?: string; periodKey?: string } = {}) {
  const [row] = await owner.db
    .insert(schema.statutoryReport)
    .values({
      tenantId: base.tenantId,
      companyId: base.companyId,
      jurisdiction: 'MY',
      reportType: p.reportType ?? 'my.cp39',
      periodKind: 'month',
      periodKey: p.periodKey ?? '2026-03',
      status: 'draft',
      statutoryVersion: 'MY-2026.1',
      rowCount: 3,
      generatedBy: base.adminUserId,
    })
    .returning({ id: schema.statutoryReport.id });
  return row.id;
}

/** Read as the OWNER, so what is asserted is the ROW as stored — not a service projection of it. */
async function rowOf(id: string) {
  const [r] = await owner.db.select().from(schema.statutoryReport).where(eq(schema.statutoryReport.id, id));
  return r;
}

/** A company-scoped override row. `allowed: false` for hr_admin REPLACES the code default for this key
 *  (lib/payroll-permissions.ts decidePayrollPermission), so the SAME session that can still SEE the row
 *  under RLS loses the permission — which is what makes the refusal below a test of the service guard
 *  and not of `app.is_admin_for` (CLAUDE.md §8: a green refusal test may be pinning RLS). */
async function denyFilingPermission() {
  await owner.db.insert(schema.payrollPermissionGrant).values({
    tenantId: base.tenantId,
    companyId: base.companyId,
    permissionKey: 'payroll.statutory_file',
    role: 'hr_admin',
    allowed: false,
  });
}
async function undenyFilingPermission() {
  await owner.db
    .delete(schema.payrollPermissionGrant)
    .where(
      and(
        eq(schema.payrollPermissionGrant.tenantId, base.tenantId),
        eq(schema.payrollPermissionGrant.permissionKey, 'payroll.statutory_file'),
      ),
    );
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  a = adminCtx(base);
});
afterAll(async () => {
  await closeAll();
});

describe('r292 — a statutory return can be marked FILED, and only what was filed reads as filed', () => {
  it('marks one return filed and leaves every other return a draft', async () => {
    const filedId = await draftReport({ reportType: 'my.cp39', periodKey: '2026-03' });
    // SAME company, SAME month, a DIFFERENT return. This is the arm a vacuous guard hides in: code that
    // marked the whole period filed would satisfy the first half of this test and fail here.
    const untouchedId = await draftReport({ reportType: 'my.borang-a', periodKey: '2026-03' });

    const out = await markReportFiled(a, { reportId: filedId, ackRef: '  LHDN-ACK-77123  ', filedOn: '2026-03-14' });
    expect(out.status).toBe('submitted');

    const filed = await rowOf(filedId);
    expect(filed.status).toBe('submitted');
    expect(filed.ackRef).toBe('LHDN-ACK-77123'); // trimmed on the way in
    expect(filed.filedOn).toBe('2026-03-14');
    expect(filed.filedBy).toBe(base.adminUserId);
    expect(filed.filedAt).toBeInstanceOf(Date);

    const untouched = await rowOf(untouchedId);
    expect(untouched.status).toBe('draft');
    expect(untouched.ackRef).toBeNull();
    expect(untouched.filedOn).toBeNull();
    expect(untouched.filedAt).toBeNull();
    expect(untouched.filedBy).toBeNull();

    // The figures are untouched by a filing: this is a status transition, not an edit to the artefact.
    expect(filed.rowCount).toBe(3);
    expect(filed.statutoryVersion).toBe('MY-2026.1');

    const ev = await latestEventPayload(base.tenantId, filedId, 'statutory-report.filed');
    expect(ev).toMatchObject({ status: 'submitted', ackRef: 'LHDN-ACK-77123', filedOn: '2026-03-14', amendsReportId: null });
  });

  it('statutoryFiled now means FILED — a recorded draft no longer trips the warning', async () => {
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    const reportId = await draftReport({ periodKey: '2026-03' });

    // ⚠️ THIS IS THE ASSERTION THE OLD CODE FAILS. `statutoryFiled` was `statReports.length > 0`, so with
    // one recorded artefact for the month it was TRUE — the warning claiming a filing that never happened.
    const before = (await batchEditImpact(a, { batchId }))!;
    expect(before.statutoryFiled).toBe(false);
    expect(before.statutoryFiledCount).toBe(0);
    // ...and `statutoryReportCount` deliberately KEEPS its old meaning: artefacts recorded for the month.
    // Pinned, because the audit payloads that have always carried it must stay comparable across r292.
    expect(before.statutoryReportCount).toBe(1);

    await markReportFiled(a, { reportId, ackRef: 'LHDN-ACK-77123' });

    const after = (await batchEditImpact(a, { batchId }))!;
    expect(after.statutoryFiled).toBe(true);
    expect(after.statutoryFiledCount).toBe(1);
    expect(after.statutoryReportCount).toBe(1);
  });

  it('a filing for ANOTHER month never makes this month read as filed', async () => {
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    const other = await draftReport({ periodKey: '2026-04' });
    await markReportFiled(a, { reportId: other, ackRef: 'LHDN-ACK-APRIL' });

    const impact = (await batchEditImpact(a, { batchId }))!;
    expect(impact.statutoryFiled).toBe(false);
    expect(impact.statutoryFiledCount).toBe(0);
  });
});

describe('r292 — who may mark a return filed', () => {
  it('refuses a caller without payroll.statutory_file, and changes nothing', async () => {
    const reportId = await draftReport();
    await denyFilingPermission();

    // The SAME session still reads the row (RLS is satisfied) — so this refusal is the service guard.
    expect(await rowOf(reportId)).toBeTruthy();
    await expect(markReportFiled(a, { reportId, ackRef: 'LHDN-ACK-77123' })).rejects.toMatchObject({
      name: 'StatutoryFilingError',
      code: 'forbidden',
    });
    const refused = await rowOf(reportId);
    expect(refused.status).toBe('draft');
    expect(refused.ackRef).toBeNull();
    expect(refused.filedAt).toBeNull();
    expect(await latestEventPayload(base.tenantId, reportId, 'statutory-report.filed')).toBeNull();

    // The OTHER arm: with the permission restored the identical call succeeds, so the refusal above was
    // the permission and not some unrelated obstacle.
    await undenyFilingPermission();
    await markReportFiled(a, { reportId, ackRef: 'LHDN-ACK-77123' });
    expect((await rowOf(reportId)).status).toBe('submitted');
  });

  it('refuses the REVERSAL to a caller without the permission too', async () => {
    const reportId = await draftReport();
    await markReportFiled(a, { reportId, ackRef: 'LHDN-ACK-77123' });
    await denyFilingPermission();
    await expect(reverseReportFiling(a, { reportId, reason: 'keyed on the wrong row' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await rowOf(reportId)).status).toBe('submitted');
  });
});

describe('r292 — the acknowledgement reference is the evidence, so it is mandatory', () => {
  it('refuses a blank or whitespace-only reference and leaves the row a draft', async () => {
    const reportId = await draftReport();
    for (const ackRef of ['', '   ', '\t\n']) {
      await expect(markReportFiled(a, { reportId, ackRef })).rejects.toMatchObject({ code: 'ackRefRequired' });
    }
    const row = await rowOf(reportId);
    expect(row.status).toBe('draft');
    expect(row.ackRef).toBeNull();
  });

  it('refuses a reference longer than 120 characters', async () => {
    const reportId = await draftReport();
    await expect(markReportFiled(a, { reportId, ackRef: 'A'.repeat(121) })).rejects.toMatchObject({
      code: 'ackRefTooLong',
    });
    expect((await rowOf(reportId)).status).toBe('draft');
    // 120 exactly is accepted — the boundary is a limit, not an off-by-one.
    await markReportFiled(a, { reportId, ackRef: 'A'.repeat(120) });
    expect((await rowOf(reportId)).ackRef).toHaveLength(120);
  });

  it('refuses a filing date in the future, derived from the clock rather than a fixed date', async () => {
    const reportId = await draftReport();
    const today = todayInKualaLumpur();
    const tomorrow = todayInKualaLumpur(new Date(Date.now() + 24 * 60 * 60 * 1000));
    await expect(markReportFiled(a, { reportId, ackRef: 'X1', filedOn: tomorrow })).rejects.toMatchObject({
      code: 'filedOnInFuture',
    });
    await expect(markReportFiled(a, { reportId, ackRef: 'X1', filedOn: '14/03/2026' })).rejects.toMatchObject({
      code: 'invalidFiledOn',
    });
    expect((await rowOf(reportId)).status).toBe('draft');
    // Omitted ⇒ today in Kuala Lumpur, which is the one date the operator does not have to key.
    await markReportFiled(a, { reportId, ackRef: 'X1' });
    expect((await rowOf(reportId)).filedOn).toBe(today);
  });
});

describe('r292 — a second filed return for the same period is an AMENDED return', () => {
  it('derives submitted → amended, and back to submitted once the first is reversed', async () => {
    const first = await draftReport({ reportType: 'my.cp39', periodKey: '2026-03' });
    const second = await draftReport({ reportType: 'my.cp39', periodKey: '2026-03' });
    const third = await draftReport({ reportType: 'my.cp39', periodKey: '2026-03' });
    // A different report type for the same month must NOT turn into an amendment of the CP39.
    const otherForm = await draftReport({ reportType: 'my.borang-a', periodKey: '2026-03' });

    await markReportFiled(a, { reportId: first, ackRef: 'ACK-1' });
    expect((await rowOf(first)).status).toBe('submitted');

    await markReportFiled(a, { reportId: second, ackRef: 'ACK-2' });
    expect((await rowOf(second)).status).toBe('amended');
    expect((await latestEventPayload(base.tenantId, second, 'statutory-report.filed'))!.amendsReportId).toBe(first);

    await markReportFiled(a, { reportId: otherForm, ackRef: 'ACK-BORANG' });
    expect((await rowOf(otherForm)).status).toBe('submitted');

    // A RETRACTED claim was never a filing: with both CP39 marks reversed, the next is a plain submission.
    await reverseReportFiling(a, { reportId: first, reason: 'wrong reference' });
    await reverseReportFiling(a, { reportId: second, reason: 'wrong reference' });
    await markReportFiled(a, { reportId: third, ackRef: 'ACK-3' });
    expect((await rowOf(third)).status).toBe('submitted');
  });

  it('refuses to re-file a row that is already filed, rather than overwriting its acknowledgement', async () => {
    const reportId = await draftReport();
    await markReportFiled(a, { reportId, ackRef: 'ACK-ORIGINAL' });
    await expect(markReportFiled(a, { reportId, ackRef: 'ACK-SECOND' })).rejects.toMatchObject({
      code: 'alreadyFiled',
    });
    expect((await rowOf(reportId)).ackRef).toBe('ACK-ORIGINAL');
  });
});

describe('r292 — reversing a mark made in error', () => {
  it('returns the row to draft, clears the claim, and keeps the retracted claim on the event', async () => {
    const reportId = await draftReport();
    await markReportFiled(a, { reportId, ackRef: 'ACK-TYPO', filedOn: '2026-03-14' });

    await reverseReportFiling(a, { reportId, reason: 'acknowledgement was keyed onto the wrong month' });

    const row = await rowOf(reportId);
    expect(row.status).toBe('draft');
    expect(row.ackRef).toBeNull();
    expect(row.filedOn).toBeNull();
    expect(row.filedAt).toBeNull();
    expect(row.filedBy).toBeNull();

    // Nothing is destroyed: the audit event still says exactly what was claimed, and by whom.
    const ev = await latestEventPayload(base.tenantId, reportId, 'statutory-report.filing-reversed');
    expect(ev).toMatchObject({
      reason: 'acknowledgement was keyed onto the wrong month',
      retractedStatus: 'submitted',
      retractedAckRef: 'ACK-TYPO',
      retractedFiledOn: '2026-03-14',
      retractedFiledBy: base.adminUserId,
    });
  });

  it('requires a reason, and refuses to reverse a return that was never filed', async () => {
    const reportId = await draftReport();
    await markReportFiled(a, { reportId, ackRef: 'ACK-TYPO' });
    await expect(reverseReportFiling(a, { reportId, reason: '   ' })).rejects.toMatchObject({
      code: 'reasonRequired',
    });
    expect((await rowOf(reportId)).status).toBe('submitted'); // unchanged by the refusal

    await reverseReportFiling(a, { reportId, reason: 'mistake' });
    await expect(reverseReportFiling(a, { reportId, reason: 'again' })).rejects.toMatchObject({ code: 'notFiled' });
  });

  it('a reversal puts the warning back to false — the mark is reversible in both the row and the warning', async () => {
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    const reportId = await draftReport({ periodKey: '2026-03' });
    await markReportFiled(a, { reportId, ackRef: 'ACK-TYPO' });
    expect((await batchEditImpact(a, { batchId }))!.statutoryFiled).toBe(true);

    await reverseReportFiling(a, { reportId, reason: 'filed nothing' });
    const after = (await batchEditImpact(a, { batchId }))!;
    expect(after.statutoryFiled).toBe(false);
    expect(after.statutoryFiledCount).toBe(0);
    expect(after.statutoryReportCount).toBe(1); // the artefact still exists; it is just not filed
  });
});

describe('r292 — a missing or out-of-scope report is not distinguishable from a bad id', () => {
  it('refuses an unknown report id with notFound', async () => {
    await expect(
      markReportFiled(a, { reportId: '00000000-0000-0000-0000-000000000000', ackRef: 'ACK' }),
    ).rejects.toMatchObject({ code: 'notFound' });
  });
});

describe('r292 — the filed statuses are one list, and one service owns the transition', () => {
  it('STATUTORY_FILED_STATUSES is exactly the reachable filed vocabulary', () => {
    // `final` is deliberately NOT implemented — see the `status` comment in db/schema.ts. Pinned so a
    // later change that quietly adds it has to come here and say why.
    expect([...schema.STATUTORY_FILED_STATUSES]).toEqual(['submitted', 'amended']);
  });

  it('no file outside core/reporting.ts updates statutory_report', async () => {
    // The schema comment claims the figures on this artefact are immutable and that only the filing
    // columns ever change. That claim is only worth anything if nothing else writes the table.
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const roots = ['core', 'app', 'packs', 'localization', 'lib', 'scripts'];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          if (entry !== 'node_modules') walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const src = readFileSync(p, 'utf8');
        if (/\.update\(\s*statutoryReport\s*\)/.test(src) && p !== join('core', 'reporting.ts')) offenders.push(p);
      }
    };
    for (const r of roots) walk(r);
    expect(offenders).toEqual([]);
  });
});
