/**
 * Custom Report Builder service (ADR-0074, feedback c440b365) — CRUD over user-defined reports plus the
 * runner. A report is a name + a dataset id from the CLOSED registry (core/report-registry.ts) + a
 * declarative spec. There is no free-form SQL; `validateReportSpec` gates every write and the run path.
 *
 * SUBSTRATE DISCIPLINE: every write appends a DomainEvent (aggregateType 'custom-report'). Payloads carry
 * only structural metadata (name, dataset id, column count) — never report row data. `runCustomReport` is
 * a pure read, so it deliberately appends NO event (documented skip).
 */
import { and, desc, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { customReport, type CustomReportSpec } from '../db/schema';
import type { ReportData } from '../lib/report-export';
import { getDataset, runReportSpec, validateReportSpec, type ReportCategory } from './report-registry';

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
 * Run a saved report (by id) or an ad-hoc spec (preview) → neutral ReportData. Pure READ — no DomainEvent
 * (documented skip, consistent with the analytics export route and overtimeReport).
 */
export async function runCustomReport(
  ctx: SessionContext,
  scopeIds: string[],
  p: { id?: string; spec?: CustomReportSpec },
): Promise<ReportData> {
  let spec = p.spec;
  if (!spec && p.id) {
    const r = await getCustomReport(ctx, p.id);
    if (!r) throw new Error('Report not found');
    spec = r.spec;
  }
  if (!spec) throw new Error('No report spec');
  assertValid(spec);
  return runReportSpec(ctx, scopeIds, spec);
}
