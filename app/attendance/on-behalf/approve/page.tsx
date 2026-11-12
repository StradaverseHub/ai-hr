import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { canActOnBehalf } from '@/packs/attendance/service';
import { OnBehalfSubjectPicker, parseOnBehalfPage, parseOnBehalfQuery } from '../subject-picker';

/** 96a54ed2 — Attendance › Approve On Behalf, step one: choose the designated approver whose pending requests to handle. */
export default async function ApproveOnBehalfPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireModule('attendance');
  const { s } = await scopedSession(), sp = await searchParams;
  const t = await getTranslations('attendanceOnBehalf');
  const header = <PageHeader title={t('approveTitle')} description={t('approveHelp')} />;
  if (!await canActOnBehalf(s, 'approve')) return <div className={pageWideCls}>{header}<Card className="p-5"><p className="text-sm text-muted-foreground">{t('noPermission')}</p></Card></div>;
  return <div className={pageWideCls + ' space-y-5'}>{header}
    <OnBehalfSubjectPicker s={s} purpose="approve" basePath="/attendance/on-behalf/approve" query={parseOnBehalfQuery(sp.q)} page={parseOnBehalfPage(sp.page)} hrefFor={id => `/attendance/on-behalf/approve/${encodeURIComponent(id)}`} />
  </div>;
}
