import { getLocale, getTranslations } from 'next-intl/server';
import type { EarnedLeaveCreditRow } from '@/packs/leave/service';
import { DAY_DASH, formatDays } from '@/lib/day-format';
import { EmployeeName } from '@/components/ui';

/** Identical display projection for HR and the employee's eight-column register. */
export async function EarnedCreditCells({row,includeEmployee=false}:{row:EarnedLeaveCreditRow;includeEmployee?:boolean}) {
  const locale=await getLocale(), t=await getTranslations('admin.leaveCredit'), tr=await getTranslations('admin.leaveCreditRegister');
  const date=(iso:string)=>new Intl.DateTimeFormat(locale,{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(iso+'T00:00:00Z'));
  const instant=(iso:string)=>new Intl.DateTimeFormat(locale,{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(iso));
  const labels={available:tr('available'),partially_used:tr('partiallyUsed'),fully_used:tr('fullyUsed'),expired:tr('expired'),reversed:tr('reversed'),paid_out:tr('paidOut')};
  const kinds={workday:t('dayKind.workday'),rest_day:t('dayKind.restDay'),off_day:t('dayKind.offDay'),holiday:t('dayKind.holiday')};
  const cls=row.status==='available'?'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400':row.status==='partially_used'?'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300':row.status==='expired'?'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400':'bg-muted text-muted-foreground';
  return <>
    <td className="px-3 py-3 whitespace-nowrap">{date(row.workedDate)}{row.workedDayKind&&<span className="block text-xs text-muted-foreground">{kinds[row.workedDayKind]}</span>}</td>
    {includeEmployee&&<td className="px-3 py-3"><EmployeeName code={row.employeeCode} name={row.employeeName}/></td>}
    <td className="px-3 py-3 tabular-nums">{formatDays(row.earned)}</td>
    <td className="px-3 py-3 tabular-nums">{row.used===0?DAY_DASH:formatDays(row.used)}{row.usage.map((use,i)=><div className="mt-1 text-xs text-muted-foreground" key={use.requestId+use.date+i}>{tr('usageOn',{days:formatDays(use.days),date:date(use.date)})}</div>)}{row.unattributedUsed>0&&<p className="mt-1 text-xs text-muted-foreground">{tr('legacyUsage',{days:formatDays(row.unattributedUsed)})}</p>}</td>
    <td className="px-3 py-3 tabular-nums">{formatDays(row.available)}</td>
    <td className="px-3 py-3 whitespace-nowrap">{date(row.expiresOn)}</td>
    <td className="max-w-xs break-words px-3 py-3 text-muted-foreground">{row.reason??DAY_DASH}{row.reversalReason&&<p>{row.reversalReason}</p>}</td>
    <td className="px-3 py-3">{row.actorName??(row.actorIsSystem?t('bySystem'):DAY_DASH)}<span className="block text-xs text-muted-foreground">{instant(row.recordedAt)}</span></td>
    <td className="px-3 py-3"><span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{labels[row.status]}</span></td>
  </>;
}
