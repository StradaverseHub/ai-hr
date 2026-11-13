import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { attendanceOnBehalfSubject, canActOnBehalf } from '@/packs/attendance/service';
import { OnBehalfSubjectCard, OnBehalfSubjectPicker, parseOnBehalfPage, parseOnBehalfQuery } from '../subject-picker';

/** 96a54ed2 — Attendance › Request On Behalf. Step one chooses the employee; step two opens the SAME My Attendance
 *  screens for them (Attendance Irregularity, Self Overtime) under a banner. The service checks the permission key
 *  and the caller's HR company scope or own reporting line on every read and submission. */
export default async function RequestOnBehalfPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; employmentId?: string }> }) {
  await requireModule('attendance');
  const { s } = await scopedSession(), sp = await searchParams;
  const t = await getTranslations('attendanceOnBehalf');
  const header = <PageHeader title={t('requestTitle')} description={t('requestHelp')} />;
  if (!await canActOnBehalf(s, 'request')) return <div className={pageWideCls}>{header}<Card className="p-5"><p className="text-sm text-muted-foreground">{t('noPermission')}</p></Card></div>;
  if (sp.employmentId) {
    const subject = await attendanceOnBehalfSubject(s, 'request', sp.employmentId);
    if (!subject) notFound();
    const id = encodeURIComponent(subject.employmentId);
    return <div className={pageWideCls + ' space-y-5'}>{header}
      <OnBehalfSubjectCard subject={subject} changeHref="/attendance/on-behalf/request" />
      <Card className="space-y-3 p-5"><h2 className="font-semibold">{t('chooseCategory')}</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          <li><Link href={`/attendance/requests?onBehalfOf=${id}`} className="block min-h-11 rounded-lg border border-border p-4 hover:bg-accent/40"><span className="font-medium">{t('irregularity')}</span><span className="mt-1 block text-xs text-muted-foreground">{t('irregularityHelp')}</span></Link></li>
          <li><Link href={`/attendance/plan-ot/apply?onBehalfOf=${id}`} className="block min-h-11 rounded-lg border border-border p-4 hover:bg-accent/40"><span className="font-medium">{t('selfOvertime')}</span><span className="mt-1 block text-xs text-muted-foreground">{t('selfOvertimeHelp')}</span></Link></li>
        </ul>
      </Card>
    </div>;
  }
  return <div className={pageWideCls + ' space-y-5'}>{header}
    <OnBehalfSubjectPicker s={s} purpose="request" basePath="/attendance/on-behalf/request" query={parseOnBehalfQuery(sp.q)} page={parseOnBehalfPage(sp.page)} hrefFor={id => `/attendance/on-behalf/request?employmentId=${encodeURIComponent(id)}`} />
  </div>;
}
