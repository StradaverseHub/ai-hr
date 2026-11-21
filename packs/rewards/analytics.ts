import 'server-only';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import { assertModuleGate } from '../../core/module-gate';
import { RewardError, rewardAnalyticsProjection } from './service';
import { analyticsTotals, combineAnalyticsTotals, type AnalyticsRow, type AnalyticsUnit } from './analytics-model';

type Unit = Pick<AnalyticsUnit, 'id' | 'cycleId' | 'cycle' | 'year' | 'companyId' | 'company' | 'businessUnitId' | 'unit' | 'uploaded' | 'canOpenReview'>;

export type AnalyticsSelection = {
  cycleId: string | null; companyId: string | null; businessUnitId: string | null;
  unitId: string | null; groupId: string | null; uploaded: 'include' | 'exclude' | 'only';
};

/** Keep calculation, permission, and canonical reconciliation reads in one read-only MVCC snapshot. */
export async function rewardAnalytics(
  ctx: SessionContext, companyIds: readonly string[], companyGroups: Record<string, { groupId: string; groupName: string }>,
  selection: AnalyticsSelection,
) {
  assertModuleGate(ctx, 'rewards');
  return withTenant(ctx, async tx => {
    const units = companyIds.length ? await tx.execute<Unit>(sql`
      select u.id, u.cycle_id as "cycleId", y.name as cycle, y.year, c.legal_name as company,
             c.id as "companyId", b.id as "businessUnitId", coalesce(nullif(trim(b.label), ''), b.code) as unit,
             app.reward_capability(u.id, 'review.view') as "canOpenReview",
             exists(select 1 from reward_uploaded_review r where r.unit_id = u.id and r.tenant_id = u.tenant_id) as uploaded
        from reward_unit u
        join reward_cycle y on y.id = u.cycle_id and y.tenant_id = u.tenant_id
        join company c on c.id = u.company_id and c.tenant_id = u.tenant_id
        join business_unit b on b.id = u.business_unit_id and b.tenant_id = u.tenant_id
       where u.tenant_id = app.current_tenant_id() and u.deleted_at is null and u.kind = 'annual'
         and u.company_id in (${sql.join(companyIds.map(id => sql`${id}::uuid`), sql`, `)})
         and app.reward_capability(u.id, 'analytics.view')
         and ('gr' in (select app.reward_roles(u.id)) or exists(select 1 from app.reward_current_group_roles())
           or not exists(select 1 from reward_uploaded_review r where r.unit_id = u.id and r.tenant_id = u.tenant_id
             and (r.current_version = 0 or r.checked_version is distinct from r.current_version)))
       order by y.year desc, c.legal_name, b.name, u.id
    `) : [];
    const cycles = Array.from(new Map(units.map(unit => [unit.cycleId, { id: unit.cycleId, name: unit.cycle, year: unit.year }])).values());
    const latestYear = units[0]?.year;
    const inCycle = units.filter(unit => (selection.cycleId === 'all'
      || (selection.cycleId ? selection.cycleId === unit.cycleId : unit.year === latestYear))
      && (selection.uploaded === 'include' || (selection.uploaded === 'only') === unit.uploaded));

    const authorizedUnits: AnalyticsUnit[] = [], selected: AnalyticsUnit[] = [];
    const rows: AnalyticsRow[] = [], fingerprints = [];
    const protectedTotals = [];
    let reconciled = true, protectedIncluded = false, protectedWithheld = false;
    for (const unit of inCycle) {
      const group = unit.uploaded ? { groupId: 'uploaded-awards', groupName: null } : companyGroups[unit.companyId];
      const selectedUnit = (!selection.unitId || selection.unitId === unit.id)
        && (!selection.businessUnitId || selection.businessUnitId === unit.businessUnitId)
        && (!selection.companyId || selection.companyId === unit.companyId)
        && (!selection.groupId || (group?.groupId ?? 'unassigned') === selection.groupId);
      let projection;
      try {
        projection = await rewardAnalyticsProjection(tx, ctx, unit.id);
      } catch (error) {
        // Native capability/independent preparation may refuse a nominally accessible unit.
        // Omit its metadata too, and block downloads of a partially loaded selection.
        if (!(error instanceof RewardError)) throw error;
        if (selectedUnit) reconciled = false;
        continue;
      }
      const unitReport: AnalyticsUnit = {
        ...unit, groupId: group?.groupId ?? null, groupName: group?.groupName ?? null,
        branchFactors: projection.branchFactors,
        people: projection.rows.length + projection.protectedTotals.people,
        blockers: projection.blockers, poolCents: projection.poolCents,
        patAchievement: projection.patAchievement, canSeePat: projection.canSeePat,
      };
      authorizedUnits.push(unitReport);
      if (!selectedUnit) continue;
      const pooled = analyticsTotals(projection.rows.filter(row => row.pooled));
      reconciled &&= !projection.staleBasis && pooled.afterCents - pooled.beforeCents === projection.reviewSalaryCents
        && pooled.bonusCents + pooled.lumpCents === projection.reviewBonusCents;
      selected.push(unitReport);
      rows.push(...projection.rows);
      protectedTotals.push(projection.protectedTotals);
      protectedIncluded ||= projection.protectedIncluded;
      protectedWithheld ||= projection.protectedWithheld;
      fingerprints.push([unit.id, projection.revision, projection.updatedAt]);
    }

    const totals = combineAnalyticsTotals([analyticsTotals(rows), ...protectedTotals]);
    const digest = createHash('sha256').update(JSON.stringify({
      selection, fingerprints, selected, totals, rows, reconciled, protectedIncluded, protectedWithheld,
    })).digest('hex');
    return { units: authorizedUnits, cycles, latestYear, selected, rows, totals, digest, reconciled, protectedIncluded, protectedWithheld };
  }, { readOnlySnapshot: true });
}
