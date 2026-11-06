import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withRewardsTenant } from '../../core/module-gate';
import type { SessionContext } from '../../db/client';
import { businessUnit, company, rewardEntry, rewardUnit } from '../../db/schema';

/** Data readiness projection. It deliberately selects no salary, budget, award, or recommendation. */
export async function rewardPrelaunchDataCheck(ctx: SessionContext, unitId: string) {
  const parsed = z.uuid().safeParse(unitId);
  if (!parsed.success) return null;
  const id = parsed.data;
  return withRewardsTenant(ctx, async tx => {
    const [unit] = await tx.select({ id: rewardUnit.id, company: company.legalName, unit: businessUnit.name })
      .from(rewardUnit).innerJoin(company, eq(company.id, rewardUnit.companyId))
      .innerJoin(businessUnit, eq(businessUnit.id, rewardUnit.businessUnitId))
      .where(and(eq(rewardUnit.id, id), eq(rewardUnit.tenantId, ctx.tenantId), isNull(rewardUnit.deletedAt),
        sql`('gr' in (select app.reward_roles(${rewardUnit.id})) or 'pbp' in (select app.reward_roles(${rewardUnit.id})))
          and app.reward_capability(${rewardUnit.id},'review.view')`));
    if (!unit) return null;
    const [permissions] = await tx.execute<{ groupRewards: boolean }>(sql`select 'gr' in (select app.reward_roles(${id}::uuid)) as "groupRewards"`);
    const rows = await tx.select({
      id: rewardEntry.id,
      employeeCode: sql<string>`coalesce(${rewardEntry.source}->>'employeeCode','')`,
      name: sql<string>`coalesce(${rewardEntry.source}->>'name','')`,
      grade: sql<string>`coalesce(${rewardEntry.source}->>'grade','')`,
      reviewed: sql<boolean>`coalesce(${rewardEntry.facts}->>'reviewed' = 'true', false)`,
      hasRatings: sql<boolean>`coalesce(${rewardEntry.facts}->>'talent','') <> '' and coalesce(${rewardEntry.facts}->>'performance','') <> ''`,
    }).from(rewardEntry).where(and(eq(rewardEntry.unitId, id), eq(rewardEntry.tenantId, ctx.tenantId),
      sql`(${rewardEntry.source}->>'personId') is distinct from ${ctx.personId ?? null}`,
      permissions?.groupRewards ? undefined : sql`coalesce(${rewardEntry.facts}->>'confidentiality','') = 'standard'
        and ${rewardEntry.facts}->>'reviewed' = 'true'
        and ${rewardEntry.employmentId} not in (select app.reward_group_ec_direct_reports(${id}::uuid))`,
    )).orderBy(asc(rewardEntry.id)).limit(500);
    return { ...unit, rows };
  });
}
