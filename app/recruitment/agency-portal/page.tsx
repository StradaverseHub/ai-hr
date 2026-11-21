import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { agencyPortalInbox, recruitmentViewer, RecruitmentError, AGENCY_PORTAL_DECLINE_REASON_MAX, type AgencyPortalInboxRow } from '@/packs/recruitment/service';
import { declineAgencyPortalAction, recordAgencyPortalAction } from '../actions';
import { Notice, Pill, RecruitmentTabs, klDateTime, pickCompany, recruitmentErrorText, selectCls, textareaCls } from '../shared';

export const dynamic = 'force-dynamic';
type Search = { company?: string; problem?: string; notice?: string };
const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;

/**
 * Recruitment › Agency inbox (slice 25; D-070): candidates agency consultants submitted through the portal, for the job's recruiter,
 * assistants and the company's administrators (row security shows each person the jobs they operate). "Record" runs slice 10's own
 * submission (duplicates, protection, repeats, the daily cap); "Decline" keeps a reason for HR, and the agency sees "not taken forward".
 */
export default async function AgencyInboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const viewer = await recruitmentViewer(s, scopeIds);
  const companies = [...viewer.adminCompanies, ...viewer.teamCompanies];
  if (!companies.length) redirect('/');
  const [t, nav, locale] = await Promise.all([getTranslations('recruitment.agencyInbox'), getTranslations('nav'), getLocale()]);
  const company = pickCompany(companies, sp.company);
  let problem = await recruitmentErrorText(sp.problem);
  let rows: AgencyPortalInboxRow[] = [];
  if (company) {
    try {
      rows = await agencyPortalInbox(s, company.id);
    } catch (e) {
      if (!(e instanceof RecruitmentError)) throw e;
      problem = await recruitmentErrorText(e.code);
    }
  }
  const here = `/recruitment/agency-portal${company ? `?company=${company.id}` : ''}`;
  const waiting = rows.filter((r) => r.state === 'waiting'), decided = rows.filter((r) => r.state !== 'waiting');
  const notice = sp.notice === 'recorded' ? t('recorded') : sp.notice === 'declined' ? t('declinedNotice') : undefined;
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} />
      <RecruitmentTabs active="agencyInbox" admin={viewer.adminCompanies.length > 0} approvals={viewer.pendingApprovals} reports />
      <ErrorBanner message={problem} />
      <Notice text={notice} />
      {companies.length > 1 && (
        <form className="flex flex-wrap items-end gap-2" method="get">
          <Field label={t('company')} className="w-64">
            <select name="company" defaultValue={company?.id} className={selectCls}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <button type="submit" className={btnGhost}>{t('show')}</button>
        </form>
      )}
      <section aria-labelledby="waiting-title" className="space-y-3">
        <div>
          <h2 id="waiting-title" className="text-base font-semibold">{t('waitingTitle')} <span className="font-normal tabular-nums text-muted-foreground">({waiting.length})</span></h2>
          <p className="text-sm text-muted-foreground">{t('waitingNote')}</p>
        </div>
        {waiting.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('noWaiting')}</p> : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {waiting.map((r) => (
              <li key={r.id} className="space-y-3 px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-medium">{r.fullName}</p>
                    <p className="text-sm"><Link href={`/recruitment/positions/${r.jobId}`} className="text-primary hover:underline">{r.jobTitle}</Link></p>
                    <p className="text-xs text-muted-foreground">{t('from', { agency: r.agencyName, contract: r.contractName, consultant: r.consultantName })}</p>
                    <p className="text-xs text-muted-foreground">{[r.email, r.mobile].filter(Boolean).join(' · ')}</p>
                    {r.comments && <p className="whitespace-pre-wrap break-words text-sm">{r.comments}</p>}
                    {r.resumeName && <a href={`/recruitment/agency-portal/${r.id}/resume`} className="text-sm text-primary hover:underline">{t('resume', { name: r.resumeName })}</a>}
                  </div>
                  <span className="text-xs text-muted-foreground">{t('receivedAt', { at: klDateTime(locale, r.receivedAt) })}</span>
                </div>
                <div className="flex flex-wrap items-start gap-3">
                  <form action={recordAgencyPortalAction}>
                    {hidden('id', r.id)}{hidden('returnTo', here)}
                    <button type="submit" className={btnPrimary}>{t('record')}</button>
                  </form>
                  <details className="w-full max-w-md">
                    <summary className="cursor-pointer text-sm text-primary">{t('decline')}</summary>
                    <form action={declineAgencyPortalAction} className="mt-2 space-y-2">
                      {hidden('id', r.id)}{hidden('returnTo', here)}
                      <Field label={t('reason')}>
                        <textarea name="reason" required maxLength={AGENCY_PORTAL_DECLINE_REASON_MAX} className={textareaCls} />
                      </Field>
                      <p className="text-xs text-muted-foreground">{t('reasonNote')}</p>
                      <button type="submit" className={btnGhost}>{t('confirmDecline')}</button>
                    </form>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {decided.length > 0 && (
        <section aria-labelledby="decided-title" className="space-y-3">
          <h2 id="decided-title" className="text-base font-semibold">{t('decidedTitle')}</h2>
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {decided.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{r.fullName ?? t('recordedName')}</p>
                  <p className="text-xs text-muted-foreground">{r.jobTitle} · {t('from', { agency: r.agencyName, contract: r.contractName, consultant: r.consultantName })}</p>
                </div>
                <Pill tone={r.state === 'recorded' ? 'good' : 'neutral'}>{t(`state.${r.state}`)}</Pill>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
