import Link from 'next/link';
import { getSession } from '@/lib/session';
import {ownLiveEmploymentSubjects} from '@/core/own-employment-selection';
import {selectOwnEmployment,OwnEmploymentSelectionError} from '@/lib/own-employment-selection';
import {ownClockToday,attendanceForEmploymentRange} from '@/packs/attendance/service';
import { listShiftsForTenant } from '@/core/roster';
import { getTranslations } from 'next-intl/server';
import { ClockPageClient } from './clock-client';
export default async function AttendanceClockPage({searchParams}:{searchParams:Promise<{employmentId?:string|string[]}>}) {
 const session=await getSession(), t=await getTranslations('attendance.clock'), pick=await getTranslations('ownEmployment');
 const subjects=await ownLiveEmploymentSubjects(session),query=await searchParams;
 if(!subjects.length)return <p>{t('notLinked')}</p>;
 if(query.employmentId===undefined&&subjects.length>1)return <section className="mx-auto max-w-xl space-y-4"><h1 className="text-xl font-semibold">{pick('choose')}</h1><ul className="space-y-2">{subjects.map(subject=><li key={subject.employmentId}><Link className="flex min-h-11 items-center rounded-md border border-input p-3 hover:bg-accent" href={'/attendance/clock?employmentId='+encodeURIComponent(subject.employmentId)}>{subject.employeeCode} · {subject.company}</Link></li>)}</ul></section>;
 let me;try{if(Array.isArray(query.employmentId))throw new OwnEmploymentSelectionError();me=selectOwnEmployment(subjects,query.employmentId);}catch(error){if(!(error instanceof OwnEmploymentSelectionError))throw error;return <p role="alert">{pick('unavailable')}</p>;}
 const initial=await ownClockToday(session,undefined,me.employmentId),date=initial.date;
 const [range,shifts]=await Promise.all([attendanceForEmploymentRange(session,me.employmentId,date,date),listShiftsForTenant(session)]);
 const shift=shifts.find(s=>s.code===range[0]?.shiftCode);
 return <div className="mx-auto max-w-6xl space-y-5 pb-[env(safe-area-inset-bottom)]"><p className="text-sm text-muted-foreground">{me.employeeCode} · {me.company}</p><ClockPageClient key={me.employmentId} initial={initial} shiftName={shift?.name??null}/></div>;
}
