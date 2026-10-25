import {getLocale,getTranslations} from 'next-intl/server';
import {validateAttendancePolicyUnclockedWork,type AttendancePolicyUnclockedWork} from '@/lib/attendance-policy-unclocked-work';
/** Original submitted testimony only; never inferred clock labels or financial readiness. */
export function AttendanceUnclockedEvidence({work}:{work:AttendancePolicyUnclockedWork|undefined}){
 if(!work)return null;
 return renderAttendanceUnclockedEvidence(work);
}
async function renderAttendanceUnclockedEvidence(work:AttendancePolicyUnclockedWork){
 const t=await getTranslations('attendance.unclockedWork'),locale=await getLocale();
 const format=new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3});
 // Display the same submitted actual-work contract, including requested subsets.
 // Malformed retained JSON must not crash the approval page or print impossible instants.
 try{work=validateAttendancePolicyUnclockedWork(work,Date.now());}
 catch{return <p>{t('unavailable')}</p>;}
 return <section className="my-3 space-y-2 rounded-md border border-border p-3" data-attested-work-evidence>
  <h3 className="text-sm font-medium">{t('evidence')}</h3><p className="text-xs text-muted-foreground">{t('timeZone')} · {t('complete')}</p>
  <ol className="list-inside list-decimal space-y-1 text-sm tabular-nums">{work.intervals.map((row,index)=><li key={index}>{format.format(new Date(row.fromEpochMillisecond))} → {format.format(new Date(row.toEpochMillisecond))}</li>)}</ol>
  {work.requestedIntervals&&<><h4 className="text-sm font-medium">{t('requestedIntervals')}</h4><ol className="list-inside list-decimal space-y-1 text-sm tabular-nums">{work.requestedIntervals.map((row,index)=><li key={index}>{format.format(new Date(row.fromEpochMillisecond))} → {format.format(new Date(row.toEpochMillisecond))}</li>)}</ol></>}
 </section>;
}
