import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { Card, PageHeader, StatusBadge, pageWideCls, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { myReferrals, type ReferralStatus } from '@/packs/recruitment/service';
import { NotEligibleNote, ReferralTabs, klDay, referralRead } from '../shared';

export const dynamic = 'force-dynamic';

const TONE: Record<ReferralStatus, string> = {
  in_review: 'probation', interviewing: 'probation', offer: 'active_serving_notice', hired: 'active', not_progressing: 'resigned', removed: 'resigned',
};

/**
 * My referrals (Recruitment slice 7): the signed-in person's own referrals only — the candidate's name as they entered it,
 * the job, the date and a coarse status (In review, Interviewing, Offer, Hired, Not progressing). Never a stage name,
 * rejection reason, interview time, score, feedback or offer term. A candidate removed under the retention rules keeps
 * only the job and the date and reads "Removed".
 */
export default async function MyReferralsPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { s } = await scopedSession();
  const [rows, t, locale, sp] = await Promise.all([referralRead(myReferrals(s)), getTranslations('recruitment.referrals'), getLocale(), searchParams]);
  return (
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('mineDescription')} />
      <ReferralTabs active="mine" />
      {sp.notice === 'sent' && <p role="status" className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">{t('sent')}</p>}
      {rows === null ? <NotEligibleNote /> : rows.length === 0 ? <Card role="note" className="p-6 text-sm text-muted-foreground">{t('noReferrals')}</Card> : (
        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}><tr>
              <th className={thCls}>{t('candidate')}</th><th className={thCls}>{t('job')}</th><th className={thCls}>{t('referredOn')}</th><th className={thCls}>{t('status')}</th>
            </tr></thead>
            <tbody className={tbodyCls}>
              {rows.map((r) => (
                <tr key={r.id} data-referral-status={r.status}>
                  <td className="px-3 py-2">{r.candidateName ?? <span className="text-muted-foreground">{t('removedCandidate')}</span>}</td>
                  <td className="px-3 py-2">{r.jobTitle} <span className="text-xs text-muted-foreground">· <span className="font-mono">{r.jobNumber}</span> · {r.companyName}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap">{klDay(locale, r.referredAt)}</td>
                  <td className="px-3 py-2"><StatusBadge status={TONE[r.status]} label={t(`statuses.${r.status}`)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
