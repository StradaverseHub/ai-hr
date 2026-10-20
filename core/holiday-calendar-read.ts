/** One dated input to the existing holiday resolver. Gaps retain the undated legacy choice. */
import { and, asc, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { employmentHolidayCalendar } from '../db/schema';
export type HolidayCalendarPeriod = Pick<typeof employmentHolidayCalendar.$inferSelect,
  'id' | 'employmentId' | 'validFrom' | 'validTo' | 'kind' | 'workState' | 'holidayGroupId'>;

export async function holidayCalendarPeriodsByEmploymentTx(tx: Tx, ids: readonly string[], from: string, to: string) {
  const result = new Map<string, HolidayCalendarPeriod[]>();
  if (!ids.length) return result;
  const rows = await tx.select({ id:employmentHolidayCalendar.id, employmentId:employmentHolidayCalendar.employmentId,
    validFrom:employmentHolidayCalendar.validFrom, validTo:employmentHolidayCalendar.validTo,
    kind:employmentHolidayCalendar.kind, workState:employmentHolidayCalendar.workState, holidayGroupId:employmentHolidayCalendar.holidayGroupId,
  }).from(employmentHolidayCalendar).where(and(inArray(employmentHolidayCalendar.employmentId,[...new Set(ids)]),
    isNull(employmentHolidayCalendar.supersededAt),lte(employmentHolidayCalendar.validFrom,to),
    or(isNull(employmentHolidayCalendar.validTo),gt(employmentHolidayCalendar.validTo,from))))
    .orderBy(asc(employmentHolidayCalendar.employmentId),asc(employmentHolidayCalendar.validFrom),asc(employmentHolidayCalendar.id));
  for (const row of rows) { const periods=result.get(row.employmentId)??[];periods.push(row);result.set(row.employmentId,periods); }
  return result;
}
export async function holidayCalendarOnTx(tx: Tx, employmentId: string, date: string) {
  return (await holidayCalendarPeriodsByEmploymentTx(tx,[employmentId],date,date)).get(employmentId)?.[0] ?? null;
}
const previousDay=(date:string)=>new Date(Date.parse(`${date}T00:00:00Z`)-86400000).toISOString().slice(0,10);
/** Partition a requested inclusive window at each half-open assignment boundary. */
export function holidayCalendarWindows(from:string,to:string,periods:readonly HolidayCalendarPeriod[]) {
  if(to<from)return [];
  const boundaries=[...new Set([from,...periods.flatMap(p=>[p.validFrom,p.validTo].filter((d):d is string=>!!d&&d>from&&d<=to))])].sort();
  return boundaries.map((start,index)=>({from:start,to:index+1<boundaries.length?previousDay(boundaries[index+1]):to,
    calendar:periods.find(p=>p.validFrom<=start&&(!p.validTo||start<p.validTo))??null}));
}
