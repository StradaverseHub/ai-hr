import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { myApprovals, offerForApprover, RecruitmentError } from '@/packs/recruitment/service';
import { decideOfferAction, decideRequisitionAction } from '../actions';
import { Notice, RecruitmentTabs, klDate, recruitmentErrorText, recruitmentViewerAccess, textareaCls } from '../shared';

/**
 * Recruitment › Approvals: the offer and requisition steps waiting for the viewer. An approver decides only their own
 * pending step, never an item they created; a rejection needs a comment and returns the item to Draft. The offer's
 * private values appear only to those allowed to see them (administrators, the job's recruiter, the offer's creator).
 */
export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const access = await recruitmentViewerAccess(s, scopeIds, { afterDecision: sp.notice === 'saved' });
  const [t, nav, locale] = await Promise.all([getTranslations('recruitment.approvals'), getTranslations('nav'), getLocale()]);
  const mine = await myApprovals(s);
  const offers = await Promise.all(mine.offers.map(async (o) => ({ o, view: await offerForApprover(s, o.offerId).catch((e) => { if (e instanceof RecruitmentError) return null; throw e; }) })));
  const decide = (kind: 'offer' | 'requisition', id: string) => (
    <form action={kind === 'offer' ? decideOfferAction : decideRequisitionAction} className="space-y-2">
      <input type="hidden" name={kind === 'offer' ? 'offerId' : 'requisitionId'} value={id} />
      <input type="hidden" name="returnTo" value="/recruitment/approvals" />
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('comment')}
        <textarea name="comment" rows={2} maxLength={2000} className={textareaCls} /></label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" name="decision" value="approve" className={btnPrimary}>{t('approve')}</button>
        <button type="submit" name="decision" value="reject" className={btnGhost}>{t('reject')}</button>
      </div>
      <p className="text-xs text-muted-foreground">{t('rejectNeedsComment')}</p>
    </form>
  );
  const empty = mine.offers.length === 0 && mine.requisitions.length === 0;
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} />
      <RecruitmentTabs active="approvals" admin={access.isAdmin} approvals={access.pendingApprovals} />
      <Notice text={sp.notice === 'saved' ? t('decidedNotice') : undefined} />
      <ErrorBanner message={await recruitmentErrorText(sp.error)} />
      {empty && <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>}
      {offers.length > 0 && (
        <section className="space-y-3" aria-labelledby="offers-title">
          <h2 id="offers-title" className="text-sm font-semibold">{t('offersTitle')}</h2>
          <ul className="grid gap-3 lg:grid-cols-2">
            {offers.map(({ o, view }) => (
              <li key={o.offerId} className="space-y-3 rounded-xl border border-border bg-card p-4">
                <p className="font-medium">{view?.candidateName || t('offerFallback')}{view?.jobTitle ? ` · ${view.jobTitle}` : ''}</p>
                <p className="text-xs text-muted-foreground">{t('step', { position: o.position, steps: o.steps })}</p>
                {view && (
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    {view.fields.map((f) => (
                      <div key={f.id}><dt className="text-xs text-muted-foreground">{f.label}</dt>
                        <dd>{f.hidden ? t('privateHidden') : !f.value ? '—' : f.value.kind === 'money' ? `${f.value.currency} ${f.value.amount}`
                          : f.value.kind === 'number' ? f.value.number : f.value.kind === 'date' ? klDate(locale, `${f.value.date}T00:00:00+08:00`) : f.value.text}</dd></div>
                    ))}
                  </dl>
                )}
                {view?.canDecide ? decide('offer', o.offerId) : <p className="text-xs text-muted-foreground">{t('cannotDecide')}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {mine.requisitions.length > 0 && (
        <section className="space-y-3" aria-labelledby="req-title">
          <h2 id="req-title" className="text-sm font-semibold">{t('requisitionsTitle')}</h2>
          <ul className="grid gap-3 lg:grid-cols-2">
            {mine.requisitions.map((r) => (
              <li key={r.id} className="space-y-3 rounded-xl border border-border bg-card p-4">
                <p className="font-medium"><Link className="hover:underline" href={`/recruitment/requisitions/${r.id}`}>{r.title}</Link> <span className="font-mono text-xs text-muted-foreground">{r.reqNumber}</span></p>
                <p className="text-xs text-muted-foreground">{t('vacancies', { n: r.vacancies })} · {t('step', { position: r.position, steps: r.steps })}</p>
                {decide('requisition', r.id)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
