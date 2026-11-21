/** Frozen original five native reads from core/analytics.ts at
 * 578cf5adc9f2938e7336b5f8e6aeb85095992e8e. The two function bodies below
 * are whole source copies. This test oracle borrows an explicit caller-owned Tx;
 * it creates no pool, permission, transaction, policy or product entry point.
 * analyticsWhere is the unchanged canonical predicate owner, pinned separately. */
import {and,count,eq,gt,gte,inArray,isNull,lte,or,sql,type SQL} from 'drizzle-orm';
import type {Tx} from '../../db/client';
import {assignment,employment,person} from '../../db/schema';
import {analyticsWhere,type AnalyticsFilters,type MovementRow,type TurnoverResult} from '../../core/analytics';
const round1 = (n: number) => Math.round(n * 10) / 10;
const scopeWhere = (scopeIds: string[] | undefined) =>
  scopeIds && scopeIds.length ? inArray(employment.companyId, scopeIds) : undefined;
const activeAsOf = (d: string) =>
  and(lte(employment.hiredOn, d), or(isNull(employment.terminatedOn), gt(employment.terminatedOn, d)));
const currentAssignment = and(
  eq(assignment.employmentId, employment.id),
  isNull(assignment.validTo),
  isNull(assignment.supersededAt),
);

async function turnoverRateFilteredTx(tx:Tx,scopeIds:string[]|undefined,p:{from:string;to:string;filters?:AnalyticsFilters},companyWhere:SQL|undefined):Promise<TurnoverResult> {
    const headcountAt = async (d: string): Promise<number> => {
      const [r] = await tx
        .select({ c: count() })
        .from(employment)
        .where(and(activeAsOf(d), scopeWhere(scopeIds), companyWhere));
      return Number(r?.c ?? 0);
    };
    const [lv] = await tx
      .select({ c: count() })
      .from(employment)
      .where(and(gte(employment.terminatedOn, p.from), lte(employment.terminatedOn, p.to), scopeWhere(scopeIds), companyWhere));
    const leavers = Number(lv?.c ?? 0);
    const headcountStart = await headcountAt(p.from);
    const headcountEnd = await headcountAt(p.to);
    const avgHeadcount = round1((headcountStart + headcountEnd) / 2);
    const turnoverPct = avgHeadcount > 0 ? round1((leavers / avgHeadcount) * 100) : 0;
    return { leavers, headcountStart, headcountEnd, avgHeadcount, turnoverPct };
}

async function movementByMonthTx(tx:Tx,scopeIds:string[]|undefined,p:{from:string;to:string;filters?:AnalyticsFilters},filters:AnalyticsFilters):Promise<MovementRow[]> {
    const baseWhere = (dateCol: typeof employment.hiredOn | typeof employment.terminatedOn) =>
      and(gte(dateCol, p.from), lte(dateCol, p.to), analyticsWhere({ ...filters, lifecycleStatus: undefined }, scopeIds, {}));
    const hireRows = await tx
      .select({ month: sql<string>`to_char(${employment.hiredOn}, 'YYYY-MM')`, c: count() })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(assignment, currentAssignment)
      .where(baseWhere(employment.hiredOn))
      .groupBy(sql`to_char(${employment.hiredOn}, 'YYYY-MM')`);
    const leaveRows = await tx
      .select({ month: sql<string>`to_char(${employment.terminatedOn}, 'YYYY-MM')`, c: count() })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(assignment, currentAssignment)
      .where(baseWhere(employment.terminatedOn))
      .groupBy(sql`to_char(${employment.terminatedOn}, 'YYYY-MM')`);
    const m = new Map<string, MovementRow>();
    const ensure = (month: string) => {
      let row = m.get(month);
      if (!row) {
        row = { month, hires: 0, leavers: 0, netChange: 0 };
        m.set(month, row);
      }
      return row;
    };
    for (const r of hireRows) ensure(r.month).hires = Number(r.c);
    for (const r of leaveRows) ensure(r.month).leavers = Number(r.c);
    for (const row of m.values()) row.netChange = row.hires - row.leavers;
    return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export async function originalEmploymentAggregatesTx(tx:Tx,scopeIds:string[]|undefined,p:{from:string;to:string;filters?:AnalyticsFilters}){
 const filters=p.filters??{};
 const turnover=await turnoverRateFilteredTx(tx,scopeIds,p,filters.companyId?eq(employment.companyId,filters.companyId):undefined);
 const movement=await movementByMonthTx(tx,scopeIds,p,filters);
 return {turnover,movement};
}
