/**
 * Custom Report Builder service (ADR-0074, feedback c440b365) — CRUD over user-defined reports plus the
 * runner. A report is a name + a dataset id from the CLOSED registry (core/report-registry.ts) + a
 * declarative spec. There is no free-form SQL; `validateReportSpec` gates every write and the run path.
 *
 * SUBSTRATE DISCIPLINE: every write appends a DomainEvent (aggregateType 'custom-report'). Payloads carry
 * only structural metadata (name, dataset id, column count) — never report row data. `runCustomReport` is
 * a pure read, so it deliberately appends NO event (documented skip).
 */
import { desc, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { customReport, type CustomReportSpec, type ReportPermissionVerb } from '../db/schema';
import type { ReportData } from '../lib/report-export';
import { getDataset, reportVerbAllowed, runReportSpec, validateReportSpec, type ReportCategory } from './report-registry';

export type CustomReportRow = {
  id: string;
  name: string;
  category: string;
  datasetId: string;
  spec: CustomReportSpec;
  isFavourite: boolean;
  shared: boolean;
  createdByUserId: string | null;
  updatedAt: string;
};

function assertValid(spec: CustomReportSpec): void {
  const v = validateReportSpec(spec);
  if (!v.ok) throw new Error(`Invalid report definition: ${v.reason}`);
}

/** Raised when a saved report's per-report permission grid denies the acting role the attempted verb. */
export class ReportAccessError extends Error {
  constructor(public readonly verb: ReportPermissionVerb) {
    super(`report-access-denied:${verb}`);
    this.name = 'ReportAccessError';
  }
}

/**
 * Enforce the report's per-role permission grid (c440b365 — the reporter's full 7-verb model:
 * View / Create / Edit / Delete / Export / Share / Manage Templates). The grid is layered ON TOP of the
 * coarse admin route-guard: an EMPTY/absent grid keeps today's behaviour (admin-only, enforced by the
 * route). When a grid IS set, super_admin always passes (the always-allowed superrole); otherwise the
 * acting session must hold a role granted at least one of the requested verbs. `verbs` accepts a list so
 * surfaces that legitimately serve two verbs (e.g. opening the builder = view OR edit) stay usable.
 */
export function enforceReportVerb(
  ctx: SessionContext,
  spec: CustomReportSpec,
  verbs: ReportPermissionVerb | ReportPermissionVerb[],
): void {
  const wanted = Array.isArray(verbs) ? verbs : [verbs];
  if (!reportVerbAllowed(spec.layout?.permissions, ctx.roles ?? [], wanted)) {
    throw new ReportAccessError(wanted[0]);
  }
}

/** List saved reports, optionally narrowed to a category. RLS already restricts to owner/shared/admin. */
export function listCustomReports(ctx: SessionContext, p?: { category?: ReportCategory }): Promise<CustomReportRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(customReport)
      .where(p?.category ? eq(customReport.category, p.category) : undefined)
      .orderBy(desc(customReport.isFavourite), desc(customReport.updatedAt));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      datasetId: r.datasetId,
      spec: r.spec,
      isFavourite: r.isFavourite,
      shared: r.shared,
      createdByUserId: r.createdByUserId,
      updatedAt: r.updatedAt.toISOString(),
    }));
  });
}

export function getCustomReport(ctx: SessionContext, id: string): Promise<CustomReportRow | null> {
  return withTenant(ctx, async (tx) => {
    const [r] = await tx.select().from(customReport).where(eq(customReport.id, id)).limit(1);
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      datasetId: r.datasetId,
      spec: r.spec,
      isFavourite: r.isFavourite,
      shared: r.shared,
      createdByUserId: r.createdByUserId,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

/** Create a new report. Category is derived from the dataset (single source of truth). */
export async function saveCustomReport(
  ctx: SessionContext,
  p: { name: string; datasetId: string; spec: CustomReportSpec; shared?: boolean },
): Promise<{ id: string }> {
  const name = p.name.trim();
  if (!name) throw new Error('Report name is required');
  const ds = getDataset(p.datasetId);
  if (!ds) throw new Error('Unknown dataset');
  const spec: CustomReportSpec = { ...p.spec, datasetId: p.datasetId };
  assertValid(spec);
  // 'create' verb: a new report has no stored grid yet, so the INCOMING grid is checked — an author who
  // sets a grid that excludes their own role from Create is denied (self-consistent with the 7-verb model).
  enforceReportVerb(ctx, spec, 'create');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(customReport)
      .values({
        tenantId: ctx.tenantId,
        name,
        category: ds.category,
        datasetId: p.datasetId,
        spec,
        shared: p.shared ?? false,
        createdByUserId: ctx.userId ?? null,
      })
      .returning({ id: customReport.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'custom-report',
      aggregateId: row.id,
      eventType: 'custom-report.created',
      actor: actorOf(ctx),
      payload: { name, datasetId: p.datasetId, category: ds.category, columnCount: spec.columns.length },
    });
    return { id: row.id };
  });
}

/** Update an existing report's name / spec / shared flag. */
export async function updateCustomReport(
  ctx: SessionContext,
  p: { id: string; name: string; spec: CustomReportSpec; shared?: boolean },
): Promise<void> {
  const name = p.name.trim();
  if (!name) throw new Error('Report name is required');
  const ds = getDataset(p.spec.datasetId);
  if (!ds) throw new Error('Unknown dataset');
  const spec: CustomReportSpec = { ...p.spec };
  assertValid(spec);
  await withTenant(ctx, async (tx) => {
    // 'edit' verb is checked against the STORED grid (not the incoming one), so a caller cannot strip the
    // grid in the payload to escape it.
    const [existing] = await tx
      .select({ spec: customReport.spec })
      .from(customReport)
      .where(eq(customReport.id, p.id))
      .limit(1);
    if (!existing) return;
    enforceReportVerb(ctx, existing.spec, 'edit');
    const [row] = await tx
      .update(customReport)
      .set({ name, spec, category: ds.category, datasetId: ds.id, shared: p.shared ?? false, updatedAt: new Date() })
      .where(eq(customReport.id, p.id))
      .returning({ id: customReport.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'custom-report',
      aggregateId: p.id,
      eventType: 'custom-report.updated',
      actor: actorOf(ctx),
      payload: { name, datasetId: ds.id, columnCount: spec.columns.length },
    });
  });
}

/** Duplicate a report (a fresh copy with a "(copy)" name, owned by the caller, never shared). */
export async function duplicateCustomReport(ctx: SessionContext, id: string): Promise<{ id: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [src] = await tx.select().from(customReport).where(eq(customReport.id, id)).limit(1);
    if (!src) return null;
    // Duplicating mints a NEW report from the source — the 'create' verb, checked on the source's grid.
    enforceReportVerb(ctx, src.spec, 'create');
    const [row] = await tx
      .insert(customReport)
      .values({
        tenantId: ctx.tenantId,
        name: `${src.name} (copy)`,
        category: src.category,
        datasetId: src.datasetId,
        spec: src.spec,
        shared: false,
        createdByUserId: ctx.userId ?? null,
      })
      .returning({ id: customReport.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'custom-report',
      aggregateId: row.id,
      eventType: 'custom-report.duplicated',
      actor: actorOf(ctx),
      payload: { name: `${src.name} (copy)`, sourceId: id, datasetId: src.datasetId },
    });
    return { id: row.id };
  });
}

export async function deleteCustomReport(ctx: SessionContext, id: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    // 'delete' verb: checked against the stored grid BEFORE the row is removed.
    const [existing] = await tx
      .select({ spec: customReport.spec })
      .from(customReport)
      .where(eq(customReport.id, id))
      .limit(1);
    if (!existing) return;
    enforceReportVerb(ctx, existing.spec, 'delete');
    const [row] = await tx.delete(customReport).where(eq(customReport.id, id)).returning({ id: customReport.id, name: customReport.name });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'custom-report',
      aggregateId: id,
      eventType: 'custom-report.deleted',
      actor: actorOf(ctx),
      payload: { name: row.name },
    });
  });
}

export async function toggleFavourite(ctx: SessionContext, p: { id: string; isFavourite: boolean }): Promise<void> {
  // Favourite is a personal bookmark, not one of the reporter's 7 permission verbs — deliberately NOT
  // grid-gated (the admin route-guard is the only gate, matching the empty-grid default).
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(customReport)
      .set({ isFavourite: p.isFavourite, updatedAt: new Date() })
      .where(eq(customReport.id, p.id))
      .returning({ id: customReport.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'custom-report',
      aggregateId: p.id,
      eventType: p.isFavourite ? 'custom-report.favourited' : 'custom-report.unfavourited',
      actor: actorOf(ctx),
      payload: { isFavourite: p.isFavourite },
    });
  });
}

export async function setShared(ctx: SessionContext, p: { id: string; shared: boolean }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    // 'share' verb: sharing/unsharing a report is checked against its stored grid.
    const [existing] = await tx
      .select({ spec: customReport.spec })
      .from(customReport)
      .where(eq(customReport.id, p.id))
      .limit(1);
    if (!existing) return;
    enforceReportVerb(ctx, existing.spec, 'share');
    const [row] = await tx
      .update(customReport)
      .set({ shared: p.shared, updatedAt: new Date() })
      .where(eq(customReport.id, p.id))
      .returning({ id: customReport.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'custom-report',
      aggregateId: p.id,
      eventType: 'custom-report.shared',
      actor: actorOf(ctx),
      payload: { shared: p.shared },
    });
  });
}

/**
 * Save-as-Template (c440b365): duplicate a saved report as a fresh SHARED template copy in one unit of
 * work. Gated by the 'manageTemplates' verb of the source report's grid — the reporter's seventh verb.
 */
export async function saveReportAsTemplate(ctx: SessionContext, id: string): Promise<{ id: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [src] = await tx.select().from(customReport).where(eq(customReport.id, id)).limit(1);
    if (!src) return null;
    enforceReportVerb(ctx, src.spec, 'manageTemplates');
    const [row] = await tx
      .insert(customReport)
      .values({
        tenantId: ctx.tenantId,
        name: `${src.name} (template)`,
        category: src.category,
        datasetId: src.datasetId,
        spec: src.spec,
        shared: true,
        createdByUserId: ctx.userId ?? null,
      })
      .returning({ id: customReport.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'custom-report',
      aggregateId: row.id,
      eventType: 'custom-report.template-saved',
      actor: actorOf(ctx),
      payload: { name: `${src.name} (template)`, sourceId: id, datasetId: src.datasetId },
    });
    return { id: row.id };
  });
}

/**
 * Run a saved report (by id) or an ad-hoc spec (preview) → neutral ReportData. Pure READ — no DomainEvent
 * (documented skip, consistent with the analytics export route and overtimeReport).
 * `verb` distinguishes the reporter's View vs Export grants on the saved-report path: on-screen preview of
 * a saved report checks 'view'; a file download checks 'export'.
 */
export async function runCustomReport(
  ctx: SessionContext,
  scopeIds: string[],
  p: { id?: string; spec?: CustomReportSpec; verb?: Extract<ReportPermissionVerb, 'view' | 'export'> },
): Promise<ReportData> {
  let spec = p.spec;
  if (!spec && p.id) {
    const r = await getCustomReport(ctx, p.id);
    if (!r) throw new Error('Report not found');
    spec = r.spec;
    // Saved-report path: honour the per-report permission grid. Ad-hoc spec (preview/export-before-save) is
    // the admin editing the report, so it is not grid-gated (the route's admin guard already applies).
    enforceReportVerb(ctx, spec, p.verb ?? 'view');
  }
  if (!spec) throw new Error('No report spec');
  assertValid(spec);
  return runReportSpec(ctx, scopeIds, spec);
}
