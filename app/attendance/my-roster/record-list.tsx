import Link from 'next/link';
import {personalCalendarHolidayContext} from './holiday-context';
import {personalHolidayContext} from '@/lib/personal-holiday-context';
import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import {ownAttendanceRecordSubject} from '../my-records/subject';
import { ATTENDANCE_RANGE_MAX_DAYS, attendanceForEmploymentRange, flagOf, personalAttendanceStatus } from '@/packs/attendance/service';
import { Button, Card, ErrorBanner, SectionHeader, inputCls } from '@/components/ui';
import { PersonalAttendanceStatus } from '@/components/personal-attendance-status';
import { FormulaOvertimeDuration } from '@/components/formula-overtime-record';
import { fmtDayDate, fmtDayName, fmtHours2, fmtMin } from '@/components/attendance-format';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { publicErrorMessage } from '@/lib/public-error';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { resolveMyAttendanceRange } from '../my-records/range';
import { attendanceCalendarDetailHref, attendanceCalendarQuery, type AttendanceCalendarQuery, type AttendanceCalendarState } from './attendance-links';

/** The single personal day-list renderer. The legacy route redirects to this shell. */
export async function AttendanceRecordList({ s, state, query }: {
  s: SessionContext; state: AttendanceCalendarState; query: AttendanceCalendarQuery;
}) {
  const holidayT=await getTranslations('replacementHoliday');
  const t=await getTranslations('attendance'), locale=await getLocale(), today=todayInKualaLumpur();
  const me=await ownAttendanceRecordSubject(s,state.employmentId);
  if(!me) return <Card className="p-8 text-sm text-muted-foreground">{t('myRecords.notLinked')}</Card>;
  const sp={from:query.from ?? state.from,to:query.to ?? state.to};
  const range=resolveMyAttendanceRange(sp,today,ATTENDANCE_RANGE_MAX_DAYS);
  const refusal=range.refusal==='too_long' ? t('myRecords.rangeTooLong',{days:range.days,max:ATTENDANCE_RANGE_MAX_DAYS})
    :range.refusal==='inverted' ? t('myRecords.rangeInverted') :range.refusal==='invalid' ? t('myCalendar.invalidRange') :undefined;
  const result=range.refusal?{rows:[],originals:[],replacements:[],error:undefined}:await Promise.all([attendanceForEmploymentRange(s,me.employmentId,range.from,range.to),personalCalendarHolidayContext(s,me.employmentId,range.from,range.to)]).then(([rows,context])=>({rows,...context,error:undefined})).catch(error=>({rows:[],originals:[],replacements:[],error:publicErrorMessage(error)}));
  const holidayNotes=(date:string)=>personalHolidayContext(date,result.originals,result.replacements,{original:holidayT('original'),replacement:holidayT('replacement'),review:holidayT('review')});
  const {rows:days,state:paging}=paginateRows(result.rows,parsePageQuery(state));
  const statusText={present:t('statusPresent'),absent:t('statusAbsent'),exempt:t('statusExempt'),rest:t('statusRest'),off:t('statusOff'),ph:t('statusPh'),on_leave:t('statusOnLeave')};
  const flagText={late:t('flagLate'),under:t('myCalendar.shortHours'),odd:t('myCalendar.incompleteEntry')};
  const columns=[t('colDate'),t('colDay'),t('colShiftCode'),t('colCheckIn'),t('colCheckOut'),t('colShiftHours'),t('colActualHours'),t('colOtTotal'),t('colStatus'),t('colNote'),t('colAction')];
  const preserved=attendanceCalendarQuery(state);
  return <Card className="overflow-hidden">
    <SectionHeader title={t('myCalendar.listView')} count={range.refusal || result.error ? undefined : result.rows.length} subtitle={t('myRecords.intro')}/>
    <form method="GET" className="flex flex-wrap items-end gap-3 border-b border-border p-4">
      {Object.entries(preserved).filter(([key])=>!['from','to','page'].includes(key)).map(([key,value])=><input key={key} type="hidden" name={key} value={value}/>)}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('filters.dateFrom')}<input type="date" name="from" defaultValue={range.from} className={inputCls}/></label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('filters.dateTo')}<input type="date" name="to" defaultValue={range.to} className={inputCls}/></label>
      <Button type="submit" variant="outline" className="min-h-11">{t('filters.apply')}</Button>
    </form>
    <ErrorBanner message={refusal ?? result.error}/>
    {!refusal && !result.error && <>
      <Pager basePath="/attendance/my-roster" params={preserved} state={paging}/>
      <div className="hidden overflow-x-auto lg:block"><table className="w-max min-w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr>{columns.map(label=><th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">{days.map(row=>{
          const status=personalAttendanceStatus(row,today), flag=flagOf(row);
          return <tr key={row.date}>
            <td className="whitespace-nowrap px-3 py-3 tabular-nums">{fmtDayDate(row.date,locale)}</td><td className="px-3 py-3">{fmtDayName(row.date,locale)}</td><td className="px-3 py-3">{row.shiftCode??'—'}</td>
            <td className="px-3 py-3 tabular-nums">{row.checkInAt?.slice(0,5)??'—'}</td><td className="px-3 py-3 tabular-nums">{row.checkOutAt?.slice(0,5)??'—'}</td><td className="px-3 py-3 tabular-nums">{fmtMin(row.scheduledMinutes)}</td><td className="px-3 py-3 tabular-nums">{fmtMin(row.workedMinutes)}</td>
            <td className="px-3 py-3 tabular-nums">{row.formulaOvertime?<FormulaOvertimeDuration record={row.formulaOvertime}/>:fmtHours2(row.otMinutes)}</td>
            <td className="px-3 py-3">{status?<PersonalAttendanceStatus status={status} label={statusText[status]}/>:'—'}</td>
            <td className="px-3 py-3 text-xs text-amber-700 dark:text-amber-400">{flag?flagText[flag]:holidayNotes(row.date).length?'':'—'}{holidayNotes(row.date).map(note=><span key={note} className="mt-1 block text-foreground">{note}</span>)}</td>
            <td className="px-3 py-3"><Link href={attendanceCalendarDetailHref(row.date,state.window,state)} className="inline-flex min-h-11 items-center font-medium text-primary hover:underline">{t('breakdownView')}</Link></td>
          </tr>;
        })}</tbody>
      </table></div>
      <div className="divide-y divide-border lg:hidden">{days.map(row=>{
        const status=personalAttendanceStatus(row,today),flag=flagOf(row);
        return <article key={row.date} className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{fmtDayDate(row.date,locale)} · {fmtDayName(row.date,locale)}</h3>{status&&<PersonalAttendanceStatus status={status} label={statusText[status]}/>}</div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[[t('colShiftCode'),row.shiftCode??'—'],[t('colCheckIn'),row.checkInAt?.slice(0,5)??'—'],[t('colCheckOut'),row.checkOutAt?.slice(0,5)??'—'],[t('colShiftHours'),fmtMin(row.scheduledMinutes)],[t('colActualHours'),fmtMin(row.workedMinutes)]].map(([label,value])=><div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="tabular-nums">{value}</dd></div>)}
            <div><dt className="text-xs text-muted-foreground">{t('colOtTotal')}</dt><dd>{row.formulaOvertime?<FormulaOvertimeDuration record={row.formulaOvertime}/>:fmtHours2(row.otMinutes)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('colStatus')}</dt><dd>{status?statusText[status]:'—'}</dd></div><div><dt className="text-xs text-muted-foreground">{t('colNote')}</dt><dd className="text-amber-700 dark:text-amber-400">{flag?flagText[flag]:holidayNotes(row.date).length?'':'—'}{holidayNotes(row.date).map(note=><span key={note} className="mt-1 block text-foreground">{note}</span>)}</dd></div>
          </dl><Link className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline" href={attendanceCalendarDetailHref(row.date,state.window,state)}>{t('breakdownView')}</Link>
        </article>;
      })}</div>
      {days.length===0&&<p className="p-8 text-center text-sm text-muted-foreground">{t('noRecords')}</p>}
      {days.some(row=>personalAttendanceStatus(row,today)==='on_leave')&&<p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t('myRecords.leaveTypeNote')}</p>}
    </>}
  </Card>;
}
