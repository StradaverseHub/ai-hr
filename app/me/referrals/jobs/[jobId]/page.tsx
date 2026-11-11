import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { CANDIDATE_FILE_ACCEPT, REFERRAL_REASON_MAX, referralEligible, referralPortalJob } from '@/packs/recruitment/service';
import { NotEligibleNote, referralRead } from '../../shared';
import { ReferralForm } from './referral-form';

export const dynamic = 'force-dynamic';

/**
 * Refer a candidate to one job (Recruitment slice 7). The job's portal fields and the refer form: the candidate's name,
 * e-mail or mobile, an optional resume, the reason, and the referrer's confirmation that the candidate agreed. A job that
 * is not (or no longer) on the caller's portal shows a short note instead (and a person who may not refer reads why).
 */
export default async function ReferJobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { s } = await scopedSession();
  const { jobId } = await params;
  const [job, t, jt] = await Promise.all([referralRead(referralPortalJob(s, jobId)), getTranslations('recruitment.referrals'), getTranslations('recruitment.job')]);
  if (!job) {
    // Not a bare 404: a person who may not refer reads why; an eligible one learns the job is no longer open for referrals.
    const eligible = (await referralRead(referralEligible(s))) === true;
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('title')} back={{ href: '/me/referrals', label: t('backToJobs') }} />
        {eligible ? (
          <Card role="note" className="space-y-3 p-6 text-sm text-muted-foreground">
            <p>{t('jobUnavailable')}</p>
            <Link href="/me/referrals" className="inline-flex min-h-11 items-center rounded-md border px-4 font-medium text-foreground hover:bg-muted">{t('backToJobs')}</Link>
          </Card>
        ) : <NotEligibleNote />}
      </div>
    );
  }
  const fields: [string, string][] = [
    [jt('workLocation'), job.workLocation],
    [jt('employmentType'), jt(`employmentTypes.${job.employmentType}`)],
    [jt('recruitmentType'), jt(`recruitmentTypes.${job.recruitmentType}`)],
    [t('jobLevel'), job.jobLevels.join(', ') || '—'],
  ];
  return (
    <div className={pageWideCls}>
      <PageHeader title={job.title} description={<><span className="font-mono">{job.jobNumber}</span> · {job.companyName}</>}
        back={{ href: '/me/referrals', label: t('backToJobs') }} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className="space-y-4 p-4">
          <h2 className="font-semibold">{t('aboutJob')}</h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {fields.map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}
          </dl>
          {job.description && <p className="whitespace-pre-wrap text-sm">{job.description}</p>}
        </Card>
        <Card className="space-y-4 p-4">
          <div>
            <h2 className="font-semibold">{t('formTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('formNote')}</p>
          </div>
          <ReferralForm jobId={job.jobId} accept={CANDIDATE_FILE_ACCEPT} reasonMax={REFERRAL_REASON_MAX} labels={{
            fullName: t('fullName'), email: t('email'), mobile: t('mobile'), contactHint: t('contactHint'), resume: t('resume'), resumeHint: t('resumeHint'),
            reason: t('reason'), reasonHint: t('reasonHint', { max: REFERRAL_REASON_MAX }), confirm: t('confirm'), submit: t('submit'), submitting: t('submitting'),
            required: t('required'),
            errors: {
              missing_fields: t('errors.missing_fields'), invalid_input: t('errors.invalid_input'), confirm_required: t('errors.confirm_required'),
              file_type: t('errors.file_type'), file_too_large: t('errors.file_too_large'), referral_refused: t('errors.referral_refused'),
              unavailable: t('errors.unavailable'),
            },
          }} />
        </Card>
      </div>
    </div>
  );
}
