import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { AttendanceDayEditorData, attendanceIrregularitiesForDate } from '@/packs/attendance/service';
import { AttendanceApplicationDecision } from './attendance-day-editor';
import { AttendanceWorkflowProgress } from './attendance-workflow-progress';
import { Card, SectionHeader } from './ui';

export async function AttendanceDayApplications({data,applications,employmentId,date}:{
  data:AttendanceDayEditorData|null;applications:Awaited<ReturnType<typeof attendanceIrregularitiesForDate>>;employmentId:string;date:string;
}){
  const t=await getTranslations('attendance'),h=await getTranslations('attendanceHistory'),e=await getTranslations('attendance.dayEdit');
  const contents=await Promise.all(applications.map(async application=>{
    const progress=await AttendanceWorkflowProgress({workflow:application.workflow,status:application.status});
    return <div key={application.id} className="space-y-3 border-t border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{e('application')} · {application.id.slice(0,8).toUpperCase()}</span><span className="text-xs text-muted-foreground">{h(`statuses.${application.status==='cancelled'?application.cancellationKind??'cancelled':application.status}`)}</span></div>
      <p className="text-sm">{h('reason')}: {application.reason}</p>{application.remark&&<p className="text-sm">{h('remarks')}: {application.remark}</p>}
      {application.proposedCheckIn&&<p className="text-sm">{h('checkIn')}: {application.proposedCheckIn} · {h('checkOut')}: {application.proposedCheckOut??'—'}</p>}
      {application.clockChanges&&<ul className="list-inside list-disc text-sm">{application.clockChanges.entries.map((p,i)=><li key={i}>{p.punchAt} · {h(p.direction)}</li>)}</ul>}
      {application.adminAmendment&&<p className="text-sm">{e('amendment')}: {application.adminAmendment.checkIn??'—'} → {application.adminAmendment.checkOut??'—'} · {application.adminAmendment.reason}</p>}
      {progress}
      {data&&application.status==='pending'?<AttendanceApplicationDecision key={data.baseline+application.id} data={data} employmentId={employmentId} date={date} application={application}>
        <Link href={`/attendance/application-history/${application.id}`} className="text-sm text-primary underline">{e('viewApplication')}</Link>
      </AttendanceApplicationDecision>:data&&<Link href={`/attendance/application-history/${application.id}`} className="text-sm text-primary underline">{e('viewApplication')}</Link>}
    </div>;
  }));
  return <Card className="overflow-hidden" data-day-section="irregularity"><SectionHeader title={t('daySecIrregular')}/>{contents}</Card>;
}
