import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { referralPortal } from '@/packs/recruitment/service';
import { NotEligibleNote, ReferralTabs, referralRead } from './shared';

export const dynamic = 'force-dynamic';

/**
 * Refer a candidate (Recruitment slice 7): the Open jobs HR put on the referral portal, in the companies where the
 * signed-in person has an active employment and Recruitment. Per job only the portal fields: title, number, company,
 * work location, employment type, recruitment type and job level — never salary, the hiring team or how many applied.
 */
export default async function ReferralPortalPage() {
  const { s } = await scopedSession();
  const [portal, t, job] = await Promise.all([
    referralRead(referralPortal(s)), getTranslations('recruitment.referrals'), getTranslations('recruitment.job'),
  ]);
  return (
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('description')} />
      <ReferralTabs active="jobs" />
      {!portal?.eligible ? <NotEligibleNote />
        : portal.jobs.length === 0 ? <Card role="note" className="p-6 text-sm text-muted-foreground">{t('noJobs')}</Card> : (
          <ul className="grid gap-3 md:grid-cols-2">
            {portal.jobs.map((j) => (
              <li key={j.jobId}>
                <Card className="flex h-full flex-col gap-3 p-4">
                  <div className="min-w-0 space-y-1">
                    <Link href={`/me/referrals/jobs/${j.jobId}`} className="break-words font-semibold text-primary underline-offset-4 hover:underline">{j.title}</Link>
                    <p className="text-sm text-muted-foreground"><span className="font-mono">{j.jobNumber}</span> · {j.companyName}</p>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div><dt className="text-xs text-muted-foreground">{job('workLocation')}</dt><dd>{j.workLocation}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{job('employmentType')}</dt><dd>{job(`employmentTypes.${j.employmentType}`)}</dd></div>
                  </dl>
                  <Link href={`/me/referrals/jobs/${j.jobId}`} className="mt-auto inline-flex min-h-11 w-fit items-center rounded-md border px-4 text-sm font-medium hover:bg-muted">{t('refer')}</Link>
                </Card>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
