/**
 * Statutory reporting seam (ADR-0010). Generic over jurisdiction: it asks the localization pack for
 * its report registry, then lists / previews / records reports. Reports are derived from payroll, but
 * a recorded generation is persisted as an append-only `statutory_report` artefact + domain event
 * (audit / idempotency / reproducibility). Filed per legal entity — RLS gates on is_admin_for.
 */
import { desc, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { company, employment, statutoryReport } from '../db/schema';
import { packFor } from '../localization/registry';
import type { EaStatement, ReportDef, ReportResult } from '../localization/my/reports';

async function companyCountry(ctx: SessionContext, companyId: string): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const [co] = await tx
      .select({ country: company.country })
      .from(company)
      .where(eq(company.id, companyId))
      .limit(1);
    return co?.country ?? null;
  });
}

function reportsForCountry(country: string | null): ReportDef[] {
  const pack = packFor(country) as { reports?: ReportDef[] } | undefined;
  return pack?.reports ?? [];
}

/** Report definitions (metadata only) available for a company's jurisdiction. */
export async function listReports(ctx: SessionContext, companyId: string) {
  const country = await companyCountry(ctx, companyId);
  return reportsForCountry(country).map((r) => ({
    id: r.id,
    label: r.label,
    cadence: r.cadence,
    periodKind: r.periodKind,
  }));
}

async function resolveDef(ctx: SessionContext, companyId: string, reportId: string): Promise<ReportDef> {
  const country = await companyCountry(ctx, companyId);
  const def = reportsForCountry(country).find((r) => r.id === reportId);
  if (!def) throw new Error(`Unknown report '${reportId}' for ${country ?? 'company'}`);
  return def;
}

/** Generate a report for preview — pure, no artefact persisted. */
export async function reportPreview(
  ctx: SessionContext,
  p: { companyId: string; reportId: string; periodKey: string },
): Promise<ReportResult> {
  const def = await resolveDef(ctx, p.companyId, p.reportId);
  return def.generate(ctx, { companyId: p.companyId, periodKey: p.periodKey });
}

/** Generate and RECORD a report: persist a statutory_report artefact + append a domain event. */
export async function recordReport(
  ctx: SessionContext,
  p: { companyId: string; reportId: string; periodKey: string },
) {
  const def = await resolveDef(ctx, p.companyId, p.reportId);
  const result = await def.generate(ctx, { companyId: p.companyId, periodKey: p.periodKey });
  const country = await companyCountry(ctx, p.companyId);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(statutoryReport)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        jurisdiction: country ?? 'MY',
        reportType: def.id,
        periodKind: def.periodKind,
        periodKey: p.periodKey,
        status: 'draft',
        statutoryVersion: result.meta.statutoryVersion,
        rowCount: result.rows.length,
        totals: result.totals,
        generatedBy: ctx.userId,
      })
      .returning({ id: statutoryReport.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'statutory-report',
      aggregateId: row.id,
      eventType: 'statutory-report.generated',
      actor: actorOf(ctx),
      payload: {
        reportType: def.id,
        companyId: p.companyId,
        periodKey: p.periodKey,
        rowCount: result.rows.length,
        totals: result.totals,
      },
    });
    return row;
  });
}

/**
 * Per-employee EA statement for a tax year, via the employment's jurisdiction pack. RLS scopes
 * visibility: an employee sees only their own (+ reports'); admins see their company scope.
 */
export async function employeeEaStatement(
  ctx: SessionContext,
  p: { employmentId: string; year: string },
): Promise<EaStatement | null> {
  const country = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ country: company.country })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    return row?.country ?? null;
  });
  const pack = packFor(country) as
    | { eaStatement?: (ctx: SessionContext, p: { employmentId: string; year: string }) => Promise<EaStatement | null> }
    | undefined;
  if (!pack?.eaStatement) return null;
  return pack.eaStatement(ctx, p);
}

/** Recently recorded report artefacts for a company (audit trail). */
export function recentReports(ctx: SessionContext, companyId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: statutoryReport.id,
        reportType: statutoryReport.reportType,
        periodKey: statutoryReport.periodKey,
        status: statutoryReport.status,
        rowCount: statutoryReport.rowCount,
        totals: statutoryReport.totals,
        statutoryVersion: statutoryReport.statutoryVersion,
        generatedAt: statutoryReport.generatedAt,
      })
      .from(statutoryReport)
      .where(eq(statutoryReport.companyId, companyId))
      .orderBy(desc(statutoryReport.generatedAt))
      .limit(20),
  );
}
