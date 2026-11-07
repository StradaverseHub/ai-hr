import { asc, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../../../db/client';
import { lcOnboardingCase as cases } from '../../../db/schema';
import { dayDate, visibleRecentJoiner, type Case, type Config } from '../../../lib/onboarding-model';
import {isCalendarDate} from '../../../lib/calendar-date';

const jsonFalsy = (value: SQL) => sql`
  coalesce(${value}, 'null'::jsonb) in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
`;

/** Native equivalent of visibleRecentJoiner for persisted public Case JSON. SQL NULL delegates to the
 * canonical reader for historical shapes whose JavaScript truthiness/array behavior is ambiguous. */
function recentJoinerExpression(cutoff: string) {
  const data = cases.data;
  const tasks = sql`${data}->'tasks'`;
  const requisitions = sql`${data}->'requisitions'`;
  // A present source value overrides local even when it is blank or null.
  const joinDate = sql`(case
    when jsonb_typeof(${data}->'source') = 'object' and (${data}->'source') ? 'joinDate'
      then ${data}#>'{source,joinDate}'
    else ${data}#>'{local,joinDate}' end)`;
  const recentDate = sql`case jsonb_typeof(${joinDate})
    when 'string' then (${joinDate}#>>'{}') collate "C" >= ${cutoff}
    when 'array' then null when 'object' then null else false end`;
  return sql`case
    when ${data}->>'personnelStatus' = 'Draft' then true
    when ${data}->>'state' = 'cancelled' then ${recentDate}
    when ${data}->>'state' = 'pending' then true
    when jsonb_typeof(${tasks}) is distinct from 'array' or ${tasks} @> '[null]'::jsonb then null
    when exists (select 1 from jsonb_array_elements(${tasks}) task(value)
      where task.value->'status' is distinct from '"done"'::jsonb) then true
    when jsonb_typeof(${requisitions}) is distinct from 'array' or ${requisitions} @> '[null]'::jsonb then null
    when (select ${jsonFalsy(sql`req.value->'handedAt'`)}
      from jsonb_array_elements(${requisitions}) with ordinality req(value, ordinal)
      where ${jsonFalsy(sql`req.value->'cancelledAt'`)} order by req.ordinal limit 1) then true
    else ${recentDate} end`;
}

/** Conservative source filter only. NULL shapes retain canonical JavaScript evaluation. */
export function recentOnboardingJoinerCandidates(config:Pick<Config,'recentActiveDays'>,today:string):SQL|undefined{
 const relative=-config.recentActiveDays;
 if(!Number.isInteger(relative)||relative < -365||relative > -1||!isCalendarDate(today))return undefined;
 return sql`(${recentJoinerExpression(dayDate(today,relative))}) is not false`;
}

/** The caller has already checked live module membership; this query uses the ordinary case RLS. */
export async function recentOnboardingJoinerCountTx(tx: Tx, config: Config, today: string): Promise<number> {
  const relative = -config.recentActiveDays;
  if (!Number.isInteger(relative) || relative < -365 || relative > -1) {
    // A retained invalid window keeps the old short-circuit/error behavior; valid configs never scan DTOs.
    const retained = await tx.select({ data: cases.data }).from(cases).orderBy(asc(cases.id));
    return retained.filter(row => visibleRecentJoiner(config, row.data, today)).length;
  }
  const [result] = await tx.execute<{ matched: number; fallback: Case[] | null }>(sql`
    select count(*) filter (where evaluated.recent)::int as matched,
      jsonb_agg(${cases.data} order by ${cases.id}) filter (where evaluated.recent is null) as fallback
    from ${cases}
    cross join lateral (select ${recentJoinerExpression(dayDate(today, relative))} as recent offset 0) evaluated
  `);
  return result.matched + (result.fallback ?? []).filter(c => visibleRecentJoiner(config, c, today)).length;
}
