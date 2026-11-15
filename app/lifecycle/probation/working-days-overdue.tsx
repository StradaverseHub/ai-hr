import {getTranslations} from 'next-intl/server';
/** Working days overdue for one KPI part, streamed after the tracker list (core/probation.ts probationTrackerWorkingDays).
 *  When the holiday read failed, the calendar days the list already counted are shown instead. */
export async function WorkingDaysOverdue({days,partId,calendarDays}:{days:Promise<Record<string,number>|null>;partId:string;calendarDays:number}){
 const[t,resolved]=await Promise.all([getTranslations('probation'),days]);
 const working=resolved?.[partId];
 return <p className="v9-notice v9-error">{working===undefined?t('tracker.calendarOverdue',{days:calendarDays}):t('tracker.workingOverdue',{days:working})}</p>;
}
