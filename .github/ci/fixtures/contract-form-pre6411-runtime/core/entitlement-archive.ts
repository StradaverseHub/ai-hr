/**
 * 6e9a126e — THE RECORD OF WHAT THE RESET WILL CLEAR, and the reader that makes it a promise kept.
 *
 * The approved plan tells the reporter, in these words: "That record becomes a read-only listing inside
 * your admin screens that you can open and download, so you read the old figures off it while you retype
 * them rather than working from memory. It feeds nothing and changes no number."
 *
 * ⚠️ THE CITED PRECEDENT IS A WARNING, NOT A MODEL. `leave_shared_group_reset_archive` (migration 0342)
 * has the right SHAPE — denormalised to text so it survives the DROP of everything it describes — and the
 * wrong POSTURE: it is documented as never read and never joined, and
 * test/shared-leave-group-single-mechanism.test.ts actively asserts that no core file reads it. A record
 * nobody can open is not a record; it is a row count in a table. So this module exists, and the listing at
 * /admin/leave/entitlements/archive is what turns the sentence above from an intention into a fact.
 *
 * ── IT FEEDS NOTHING ──────────────────────────────────────────────────────────────────────────────────
 * Nothing in this file is called by any entitlement, accrual, carry-forward or eligibility path, and
 * nothing here returns a number any engine consumes. That is the plan's own promise and it is a property
 * worth keeping true: the archive is evidence, and evidence that participates in the calculation stops
 * being evidence of what the calculation used to be.
 *
 * ── THE CAPTURE ITSELF IS SQL, ON PURPOSE ─────────────────────────────────────────────────────────────
 * `app.capture_entitlement_reset_archive(tag)` (migration 0398) holds the rendering, because the capture
 * must run at least twice — once now, once immediately before release three clears anything — and a
 * second copy of that rendering in the later migration is the duplicate-maintenance defect this whole
 * feedback item is about. This module just calls it, so the release-one capture, any admin re-capture and
 * release three's pre-reset capture all produce byte-identical text.
 */
import { and, desc, eq, sql } from 'drizzle-orm';

import { withTenant, type SessionContext } from '../db/client';
import { entitlementResetArchive } from '../db/schema';
import { toCsv } from '../lib/csv';

/**
 * 'scheme' | 'policy' — migration 0398's capture of the tables 0405 dropped.
 * 'template' | 'rule' — fe9c73bc: scripts/reset-entitlement-configuration.ts's capture of entitlement_template
 * and entitlement_eligibility_rule, written into the SAME table so the same reader shows it. ⚠️ The DB CHECK
 * `entitlement_reset_archive_layer_check` (0397) still admits only the first two until a migration widens it;
 * the script refuses to write until then, and this union is what the reader is ready for.
 */
export type EntitlementArchiveLayer = 'scheme' | 'policy' | 'template' | 'rule';

export type EntitlementArchiveRow = {
  id: string;
  capturedAt: Date;
  captureTag: string;
  layer: EntitlementArchiveLayer;
  schemeName: string | null;
  schemeCategory: string | null;
  leaveTypeName: string | null;
  leaveTypeCode: string | null;
  companyName: string | null;
  schemeGradeGroupName: string | null;
  schemeGradeGroupMembers: string | null;
  gradeName: string | null;
  employmentType: string | null;
  entitlementText: string | null;
  validFromText: string | null;
  validToText: string | null;
  note: string | null;
};

/** The capture tags present, newest first, with their row counts. The listing offers these as the choice
 *  of snapshot: the archive is re-captured before the reset, and silently interleaving two snapshots taken
 *  months apart would have the reporter retyping a mixture of both. */
export async function listEntitlementArchiveCaptures(
  ctx: SessionContext,
): Promise<{ captureTag: string; capturedAt: Date; rows: number }[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        captureTag: entitlementResetArchive.captureTag,
        capturedAt: sql<Date>`max(${entitlementResetArchive.capturedAt})`,
        rows: sql<number>`count(*)::int`,
      })
      .from(entitlementResetArchive)
      .groupBy(entitlementResetArchive.captureTag)
      .orderBy(desc(sql`max(${entitlementResetArchive.capturedAt})`));
    return rows.map((r) => ({ captureTag: r.captureTag, capturedAt: new Date(r.capturedAt), rows: Number(r.rows) }));
  });
}

/**
 * One capture's rows. `captureTag` absent ⇒ the most recent capture, which is what the screen opens on.
 *
 * Ordered so a human can read it: scheme side first (that is the layer they will retype as templates),
 * then by scheme, leave type and company. Deterministic, so the CSV and the screen never disagree.
 */
export async function listEntitlementResetArchive(
  ctx: SessionContext,
  p?: { captureTag?: string },
): Promise<EntitlementArchiveRow[]> {
  return withTenant(ctx, async (tx) => {
    let tag = p?.captureTag;
    if (!tag) {
      const [latest] = await tx
        .select({ captureTag: entitlementResetArchive.captureTag })
        .from(entitlementResetArchive)
        .orderBy(desc(entitlementResetArchive.capturedAt))
        .limit(1);
      tag = latest?.captureTag;
      if (!tag) return [];
    }
    const rows = await tx
      .select()
      .from(entitlementResetArchive)
      .where(and(eq(entitlementResetArchive.captureTag, tag)))
      .orderBy(
        // 'policy' < 'scheme' alphabetically, so sort on the reversed flag rather than the column: the
        // scheme layer is the one the reporter retypes first.
        sql`case when ${entitlementResetArchive.layer} in ('scheme', 'template') then 0 else 1 end`,
        entitlementResetArchive.schemeName,
        entitlementResetArchive.leaveTypeName,
        entitlementResetArchive.companyName,
        entitlementResetArchive.validFromText,
      );
    return rows.map((r) => ({ ...r, layer: r.layer as EntitlementArchiveLayer }));
  });
}

/** The CSV the reporter downloads and retypes from. Same rows, same order, as the screen. */
/** The English layer label the CSV prints — the screen's own words for each layer (admin.entitlementArchive). */
const CSV_LAYER_LABEL: Record<EntitlementArchiveLayer, string> = {
  scheme: 'Benefit scheme',
  policy: 'Company / grade rule',
  template: 'Entitlement table',
  rule: 'Eligibility rule',
};

export async function entitlementResetArchiveCsv(
  ctx: SessionContext,
  p?: { captureTag?: string },
): Promise<{ content: string; filename: string; rows: number }> {
  const rows = await listEntitlementResetArchive(ctx, p);
  const header = [
    'Layer',
    'Scheme',
    'Scheme category',
    'Leave type',
    'Leave type code',
    'Company',
    'Grade group',
    'Grades in group',
    'Grade',
    'Employment type',
    'Entitlement',
    'In force from',
    'In force to',
    'Note',
  ];
  const body = rows.map((r) => [
    CSV_LAYER_LABEL[r.layer] ?? r.layer,
    r.schemeName ?? '',
    r.schemeCategory ?? '',
    r.leaveTypeName ?? '',
    r.leaveTypeCode ?? '',
    // A null company on the policy side is the GROUP DEFAULT — a real value, not missing data. Saying so
    // in the export matters more than on screen: a blank cell in a spreadsheet reads as "unknown".
    r.companyName ?? (r.layer === 'policy' ? 'All companies (group default)' : ''),
    r.schemeGradeGroupName ?? '',
    r.schemeGradeGroupMembers ?? '',
    r.gradeName ?? (r.layer === 'policy' ? 'All grades' : ''),
    r.employmentType ?? '',
    r.entitlementText ?? '',
    r.validFromText ?? '',
    r.validToText ?? '',
    r.note ?? '',
  ]);
  const tag = rows[0]?.captureTag ?? 'empty';
  return {
    content: toCsv([header, ...body]),
    filename: `entitlement-configuration-record_${tag.replace(/[^a-zA-Z0-9._-]+/g, '-')}.csv`,
    rows: rows.length,
  };
}

/**
 * Re-take the record for the CALLER'S OWN TENANT under a new tag.
 *
 * Release three calls the same SQL function from its own migration, immediately before it clears
 * anything, so the record can never be older than what it describes. This entry point exists so an
 * administrator can refresh it themselves in between — and so the capture is exercised by a test against
 * real seeded rows, which a migration running on an empty database never could be.
 *
 * SECURITY INVOKER: under the app connection this runs inside the caller's RLS, so it reads and writes
 * only their tenant. Re-running an EXISTING tag is a no-op by construction (the function's own NOT EXISTS
 * guard), so a double-click cannot double the record.
 */
export async function captureEntitlementResetArchive(
  ctx: SessionContext,
  p: { captureTag: string },
): Promise<{ schemeRows: number; policyRows: number }> {
  const tag = (p.captureTag ?? '').trim();
  if (!tag) throw new Error('A capture tag is required.');
  return withTenant(ctx, async (tx) => {
    const res = await tx.execute(
      sql`select scheme_rows, policy_rows from app.capture_entitlement_reset_archive(${tag})`,
    );
    const row = (res as unknown as { scheme_rows: number; policy_rows: number }[])[0];
    return { schemeRows: Number(row?.scheme_rows ?? 0), policyRows: Number(row?.policy_rows ?? 0) };
  });
}
