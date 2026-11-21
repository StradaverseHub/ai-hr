import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import { toAssignList, CANDIDATE_SOURCES, RecruitmentError, type ToAssignList } from '@/packs/recruitment/service';
import { assignToJobAction, hideToAssignAction, showToAssignAction } from '../actions';
import { NoRecruitmentCompany, Notice, Pill, RecruitmentTabs, klDate, pickCompany, recruitmentErrorText, recruitmentViewerAccess, selectCls } from '../shared';

type Search = { company?: string; hidden?: string; problem?: string; notice?: string };

/**
 * Recruitment › To assign (slice 16, EV-066): the company's candidates with no application — imported without a usable job — grouped
 * by the job title as written in the file, with source, import date and who imported them. "Assign to job" creates a normal
 * application (repeat window, blocked-list matching); "Remove from list" only stops showing them here (nothing is deleted or
 * archived). The company's recruitment administrators, recruiters and assistants only.
 */
export default async function ToAssignPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const access = await recruitmentViewerAccess(s, scopeIds);
  const sp = await searchParams;
  const [t, tc, nav, locale] = await Promise.all([getTranslations('recruitment.toAssign'), getTranslations('recruitment.cand'), getTranslations('nav'), getLocale()]);
  const companies = access.poolCompanies;
  const company = pickCompany(companies, sp.company);
  const showingHidden = sp.hidden === '1';
  let list: ToAssignList | null = null;
  let problem = await recruitmentErrorText(sp.problem);
  if (company) {
    try { list = await toAssignList(s, company.id, { hidden: showingHidden }); } catch (e) {
      if (!(e instanceof RecruitmentError)) throw e;
      problem = await recruitmentErrorText(e.code);
    }
  }
  const here = `/recruitment/to-assign?${new URLSearchParams({ ...(company ? { company: company.id } : {}), ...(showingHidden ? { hidden: '1' } : {}) })}`;
  const sourceText = (v: string | null) => (v && (CANDIDATE_SOURCES as readonly string[]).includes(v) ? tc(`sources.${v as (typeof CANDIDATE_SOURCES)[number]}`) : t('noSource'));
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} back={{ href: '/recruitment/candidates', label: t('back') }} />
      <RecruitmentTabs active="candidates" admin={access.isAdmin} approvals={access.pendingApprovals} reports={access.reportCompanies.length > 0}
        screening={access.pendingScreening} pools={access.poolCompanies.length > 0} />
      <Notice text={sp.notice === 'assigned' ? t('notice.assigned') : sp.notice === 'hidden' ? t('notice.hidden') : sp.notice === 'shown' ? t('notice.shown') : undefined} />
      <ErrorBanner message={problem} />
      {!company || !list ? (!company ? <NoRecruitmentCompany /> : null) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            {companies.length > 1 ? (
              <form method="get" className="flex flex-wrap items-end gap-2">
                <label className="space-y-1 text-sm"><span className="block text-xs font-medium text-muted-foreground">{t('company')}</span>
                  <select name="company" defaultValue={company.id} className={selectCls}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                </label>
                <button type="submit" className={btnGhost}>{t('switchCompany')}</button>
              </form>
            ) : <span />}
            <nav aria-label={t('viewLabel')} className="flex gap-2 text-sm">
              {[{ key: 'shown', href: `/recruitment/to-assign?company=${company.id}`, text: t('viewShown', { count: list.total }), on: !showingHidden },
                { key: 'hidden', href: `/recruitment/to-assign?company=${company.id}&hidden=1`, text: t('viewHidden', { count: list.hiddenCount }), on: showingHidden }].map((v) => (
                <Link key={v.key} href={v.href} aria-current={v.on ? 'page' : undefined}
                  className={cn('rounded-full border px-3 py-1', v.on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent')}>{v.text}</Link>
              ))}
            </nav>
          </div>
          <p className="text-sm text-muted-foreground">{showingHidden ? t('hiddenNote') : t('listNote')}{' '}
            <Link href={`/recruitment/candidates/import?company=${company.id}`} className="font-medium text-primary hover:underline">{t('importLink')}</Link></p>
          {list.groups.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{showingHidden ? t('emptyHidden') : t('empty')}</p>
          ) : list.groups.map((g) => (
            <section key={g.title ?? ''} aria-label={g.title ?? t('noTitle')} className="space-y-2">
              <h2 className="text-sm font-semibold">{g.title ? t('groupTitle', { title: g.title }) : t('noTitle')} <span className="font-normal text-muted-foreground">({g.entries.length})</span></h2>
              <ul className="grid gap-3 lg:grid-cols-2">
                {g.entries.map((e) => (
                  <li key={e.candidateId} className="space-y-3 rounded-xl border border-border bg-card p-4">
                    <div>
                      <p className="font-medium">{e.name}</p>
                      <p className="text-xs text-muted-foreground">{[e.email, e.phone].filter(Boolean).join(' · ') || t('noContact')}</p>
                      {e.possibleDuplicate && <p className="mt-1"><Pill tone="warn">{t('duplicate')}</Pill></p>}
                    </div>
                    <dl className="grid grid-cols-2 gap-2 text-xs">
                      <div><dt className="text-muted-foreground">{t('source')}</dt><dd>{sourceText(e.source)}</dd></div>
                      <div><dt className="text-muted-foreground">{t('imported')}</dt><dd>{t('importedBy', { date: klDate(locale, e.importedAt), by: e.importedBy ?? t('unnamedUser') })}</dd></div>
                      {e.note && <div className="col-span-2"><dt className="text-muted-foreground">{t('note')}</dt><dd className="whitespace-pre-line">{e.note}</dd></div>}
                    </dl>
                    <div className="flex flex-wrap items-end gap-2">
                      {list!.jobs.length > 0 && !e.hidden && (
                        <form action={assignToJobAction} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="candidateId" value={e.candidateId} /><input type="hidden" name="returnTo" value={here} />
                          <label className="sr-only" htmlFor={`job-${e.candidateId}`}>{t('chooseJob', { name: e.name })}</label>
                          <select id={`job-${e.candidateId}`} name="jobId" required defaultValue="" className={cn(selectCls, 'h-9 w-56')}>
                            <option value="" disabled>{t('chooseJobShort')}</option>
                            {list!.jobs.map((j) => <option key={j.id} value={j.id}>{j.title} · {j.jobNumber}</option>)}
                          </select>
                          <button type="submit" className={btnPrimary}>{t('assign')}</button>
                        </form>
                      )}
                      <form action={e.hidden ? showToAssignAction : hideToAssignAction}>
                        <input type="hidden" name="candidateId" value={e.candidateId} /><input type="hidden" name="returnTo" value={here} />
                        <button type="submit" className={btnGhost} aria-label={e.hidden ? t('showNamed', { name: e.name }) : t('hideNamed', { name: e.name })}>{e.hidden ? t('show') : t('hide')}</button>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {list.jobs.length === 0 && !showingHidden && list.total > 0 && <p className="text-sm text-muted-foreground">{t('noOpenJobs')}</p>}
          {list.truncated && <p className="text-xs text-muted-foreground">{t('truncated')}</p>}
          <p className="text-xs text-muted-foreground">{t('hideNote')}</p>
        </div>
      )}
    </div>
  );
}
