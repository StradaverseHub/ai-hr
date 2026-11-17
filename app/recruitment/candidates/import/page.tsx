import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, PageHeader, btnGhost } from '@/components/ui';
import {
  candidateImportJob, candidateImportResult, candidateImportTemplate, recentCandidateImports, IMPORT_COLUMNS, IMPORT_HEADERS, IMPORT_MAX_ROWS, RecruitmentError,
  type CandidateImportJob, type ImportResultRow,
} from '@/packs/recruitment/service';
import { NoRecruitmentCompany, Pill, RecruitmentTabs, klDateTime, pickCompany, recruitmentErrorText, recruitmentViewerAccess, selectCls } from '../../shared';
import { CandidateImportProgress, CandidateImportWizard } from './import-ui';

const RESULT_PAGE = 1000;
type Search = { company?: string; import?: string; problem?: string; all?: string; from?: string };

/**
 * Recruitment › Candidates › Import candidates (slice 16): the template, the file check and preview, then the import as a background
 * job with its progress and its result row by row. Recruitment administrators and the company's recruiters and assistants only
 * (the service and row security decide; others see that they have no company here).
 */
export default async function CandidateImportPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const access = await recruitmentViewerAccess(s, scopeIds);
  const sp = await searchParams;
  const [t, nav, locale] = await Promise.all([getTranslations('recruitment.import'), getTranslations('nav'), getLocale()]);
  const companies = access.poolCompanies;
  const company = pickCompany(companies, sp.company);
  let job: CandidateImportJob | null = null;
  let rows: ImportResultRow[] = [];
  let problem = await recruitmentErrorText(sp.problem);
  if (sp.import) {
    try {
      job = await candidateImportJob(s, sp.import);
      if (job.outcome || (job.job && !['queued', 'preparing', 'running', 'finalizing'].includes(job.job.state))) {
        rows = await candidateImportResult(s, sp.import, { problemsOnly: sp.all !== '1', limit: RESULT_PAGE, fromRow: Number.parseInt(sp.from ?? '2', 10) || 2 });
      }
    } catch (e) {
      if (!(e instanceof RecruitmentError)) throw e;
      problem = await recruitmentErrorText(e.code);
    }
  }
  const [template, recent] = company ? await Promise.all([candidateImportTemplate(s, company.id), recentCandidateImports(s, [company.id])]) : [null, []];
  const fieldLabels: Record<string, string> = {
    ...Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, t(`columns.${c}`)])),
    ...Object.fromEntries((template?.customFields ?? []).map((f) => [`cf.${f.id}`, f.label])),
  };
  const here = (extra: Record<string, string>) => `/recruitment/candidates/import?${new URLSearchParams({ ...(company ? { company: company.id } : {}), ...extra })}`;
  const done = job && (job.outcome !== null || (job.job !== null && !['queued', 'preparing', 'running', 'finalizing'].includes(job.job.state)));
  const outcomeText = (r: ImportResultRow) => {
    if (r.outcome === 'invalid') return r.errorFields.length ? r.errorFields.map((f) => t('issue', { field: fieldLabels[f.field] ?? t('unknownField'), problem: t.has(`issues.${f.code}`) ? t(`issues.${f.code}` as 'issues.invalid') : t('issues.invalid') })).join(' · ') : t('result.invalid');
    if (r.outcome === 'failed') return t('result.failed', { reason: r.errorCode ? (t.has(`refusals.${r.errorCode}`) ? t(`refusals.${r.errorCode}` as 'refusals.refused') : t('refusals.refused')) : t('refusals.refused') });
    return r.applicationId ? t('result.applied', { job: `${r.jobTitle ?? ''} · ${r.jobNumber ?? ''}` }) : t('result.toAssign');
  };
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} back={{ href: '/recruitment/candidates', label: t('back') }} />
      <RecruitmentTabs active="candidates" admin={access.isAdmin} approvals={access.pendingApprovals} reports={access.reportCompanies.length > 0}
        screening={access.pendingScreening} pools={access.poolCompanies.length > 0} />
      <ErrorBanner message={problem} />
      {!company ? <NoRecruitmentCompany /> : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-5">
            {companies.length > 1 && (
              <form method="get" className="flex flex-wrap items-end gap-2">
                <label className="space-y-1 text-sm"><span className="block text-xs font-medium text-muted-foreground">{t('company')}</span>
                  <select name="company" defaultValue={company.id} className={selectCls}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                </label>
                <button type="submit" className={btnGhost}>{t('switchCompany')}</button>
              </form>
            )}
            {job && sp.import && (
              <section aria-labelledby="job-title" className="space-y-4">
                <h2 id="job-title" className="text-base font-semibold">{t('jobTitle', { date: klDateTime(locale, job.createdAt) })}</h2>
                <CandidateImportProgress importId={sp.import} initial={job} />
                {done && (
                  <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                    <h3 className="text-sm font-semibold">{job.outcome === 'cancelled' ? t('resultStopped') : job.outcome === 'failed' ? t('resultFailed') : t('resultTitle')}</h3>
                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {(['created', 'applications', 'toAssign', 'possibleDuplicates', 'needsReview', 'invalid', 'failed', 'rows'] as const).map((key) => (
                        <div key={key} className="rounded-lg border border-border px-3 py-2">
                          <dt className="text-xs text-muted-foreground">{t(`resultCounts.${key}`)}</dt>
                          <dd className="text-xl font-semibold tabular-nums">{job!.counters[key]}</dd>
                        </div>
                      ))}
                    </dl>
                    {job.counters.toAssign > 0 && <p className="text-sm"><Link href={`/recruitment/to-assign?company=${company.id}`} className="font-medium text-primary hover:underline">{t('openToAssign')}</Link></p>}
                    <nav className="flex gap-3 text-sm" aria-label={t('resultFilter')}>
                      <Link href={here({ import: sp.import })} aria-current={sp.all !== '1' ? 'page' : undefined} className="hover:underline">{t('problemsOnly')}</Link>
                      <Link href={here({ import: sp.import, all: '1' })} aria-current={sp.all === '1' ? 'page' : undefined} className="hover:underline">{t('allRows')}</Link>
                    </nav>
                    {(sp.from || rows.length === RESULT_PAGE) && (
                      <nav className="flex gap-3 text-sm" aria-label={t('resultPages')}>
                        {sp.from && <Link href={here({ import: sp.import, ...(sp.all === '1' ? { all: '1' } : {}) })} className="text-primary hover:underline">{t('firstRows')}</Link>}
                        {rows.length === RESULT_PAGE && <Link href={here({ import: sp.import, ...(sp.all === '1' ? { all: '1' } : {}), from: String(rows[rows.length - 1].rowNum + 1) })}
                          className="text-primary hover:underline">{t('nextRows')}</Link>}
                      </nav>
                    )}
                    {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('noProblems')}</p> : (
                      <div className="max-h-[32rem] overflow-auto rounded-lg border border-border">
                        <table className="w-full text-left text-sm">
                          <caption className="sr-only">{t('resultCaption')}</caption>
                          <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                            <tr><th scope="col" className="px-3 py-2">{t('row')}</th><th scope="col" className="px-3 py-2">{t('name')}</th><th scope="col" className="px-3 py-2">{t('outcomeColumn')}</th></tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {rows.map((r) => (
                              <tr key={r.rowNum} className="align-top">
                                <td className="px-3 py-2 tabular-nums">{r.rowNum}</td>
                                <td className="px-3 py-2">{r.applicationId ? <Link href={`/recruitment/applications/${r.applicationId}`} className="text-primary hover:underline">{r.candidateName ?? t('removed')}</Link>
                                  : r.candidateId ? (r.candidateName ?? t('removed')) : '—'}</td>
                                <td className="space-y-1 px-3 py-2">
                                  <p className={r.outcome === 'created' ? '' : 'text-destructive'}>{outcomeText(r)}</p>
                                  <p className="flex flex-wrap gap-1">
                                    {r.possibleDuplicate && <Pill tone="warn">{t('flags.duplicate')}</Pill>}
                                    {r.needsReview && <Pill tone="warn">{t('flags.review')}</Pill>}
                                    {r.jobResult && !['applied', 'no_job'].includes(r.jobResult) && <Pill tone="info">{t(`jobResults.${r.jobResult}` as 'jobResults.unknown_job')}</Pill>}
                                  </p>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}
            <section aria-labelledby="step-template" className="space-y-3 rounded-xl border border-border bg-card p-4">
              <h2 id="step-template" className="text-sm font-semibold">{t('step1')}</h2>
              <p className="text-sm text-muted-foreground">{t('templateNote', { max: IMPORT_MAX_ROWS })}</p>
              <div className="flex flex-wrap gap-2">
                <a href={`/recruitment/candidates/import/template?company=${company.id}&format=xlsx`} className={btnGhost} download>{t('templateXlsx')}</a>
                <a href={`/recruitment/candidates/import/template?company=${company.id}&format=csv`} className={btnGhost} download>{t('templateCsv')}</a>
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer font-medium">{t('columnsTitle')}</summary>
                <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                  {IMPORT_COLUMNS.map((c) => <li key={c}><span className="font-medium">{IMPORT_HEADERS[c]}</span> — {t(`columnHelp.${c}`)}</li>)}
                  {(template?.customFields ?? []).map((f) => (
                    <li key={f.id}><span className="font-medium">{f.label}</span> — {f.options.length ? t('columnHelp.choice', { options: f.options.join('; ') }) : t(`columnHelp.type.${f.type}`)}{f.required ? ` (${t('requiredField')})` : ''}</li>
                  ))}
                </ul>
              </details>
            </section>
            <section aria-labelledby="step-file" className="space-y-3 rounded-xl border border-border bg-card p-4">
              <h2 id="step-file" className="text-sm font-semibold">{t('step2')}</h2>
              <CandidateImportWizard companyId={company.id} fieldLabels={fieldLabels} />
            </section>
          </div>
          <aside className="space-y-4">
            <section aria-labelledby="recent-title" className="space-y-2 rounded-xl border border-border bg-card p-4">
              <h2 id="recent-title" className="text-sm font-semibold">{t('recentTitle')}</h2>
              {recent.length === 0 ? <p className="text-sm text-muted-foreground">{t('recentEmpty')}</p> : (
                <ul className="divide-y divide-border text-sm">
                  {recent.map((r) => (
                    <li key={r.importId} className="flex items-center justify-between gap-2 py-2">
                      <Link href={here({ import: r.importId })} className="hover:underline">{klDateTime(locale, r.createdAt)}</Link>
                      <span className="text-xs text-muted-foreground">{t('recentRows', { count: r.fileRows })} · {r.active ? t('state.running') : r.outcome ? t(`outcome.${r.outcome}`) : t('state.queued')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <p className="text-xs text-muted-foreground">{t('privacyNote')}</p>
          </aside>
        </div>
      )}
    </div>
  );
}
