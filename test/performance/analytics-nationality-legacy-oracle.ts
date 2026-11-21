/** FROZEN exact2264 nationality query/DTO oracle, not application code.
 * Private query, current-assignment predicate and tally bodies are copied whole.
 * analyticsWhere remains the unchanged canonical filter owner. Equal-count order
 * was unspecified; native parity compares buckets as a multiset and count order. */
import {and,eq,isNull} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {assignment,employment,person,employeeStatutoryMy} from '../../db/schema';
import {isAdmin} from '../../lib/authz-model';
import {analyticsWhere,UNKNOWN_BUCKET,type AnalyticsFilters,type DimensionCount} from '../../core/analytics';

const currentAssignment = and(
  eq(assignment.employmentId, employment.id),
  isNull(assignment.validTo),
  isNull(assignment.supersededAt),
);

function tally(rows: (string | null)[], nullBucket = UNKNOWN_BUCKET): DimensionCount[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const name = r ?? nullBucket;
    m.set(name, (m.get(name) ?? 0) + 1);
  }
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

export async function legacyDemographicsByNationality(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  opts: { asOf: string; filters?: AnalyticsFilters },
): Promise<DimensionCount[] | null> {
  if (!isAdmin(ctx)) return null; // (a) admin-only — scoped viewers get the card omitted.
  const filters = opts.filters ?? {};
  return withTenant(ctx,tx=>demographicsByNationalityTx(tx,ctx,scopeIds,opts,filters));
}

async function demographicsByNationalityTx(tx:Tx,ctx:SessionContext,scopeIds:string[]|undefined,opts:{asOf:string;filters?:AnalyticsFilters},filters:AnalyticsFilters):Promise<DimensionCount[]|null> {
  if (!isAdmin(ctx)) return null;
    // (b) DISTINCT person base: select the person id + citizenship once per person, not per employment.
    const rows = await tx
      .selectDistinct({ personId: person.id, citizenship: employeeStatutoryMy.epfCitizenship })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(assignment, currentAssignment)
      // (c) LEFT JOIN statutory so persons with no row are kept (citizenship → null → Unknown).
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, person.id))
      .where(
        analyticsWhere({ ...filters, lifecycleStatus: filters.lifecycleStatus ?? 'active' }, scopeIds, { asOf: opts.asOf }),
      );
    return tally(rows.map((r) => r.citizenship));
}
