import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, PageHeader, btnPrimary } from '@/components/ui';
import { EVALUATION_RESULTS, NOTES_MAX_WORDS, RecruitmentError, scorecardForm, type ScorecardForm } from '@/packs/recruitment/service';
import { submitScorecardAction } from '../../../actions';
import { recruitmentErrorText, recruitmentViewerAccess, textareaCls } from '../../../shared';

/**
 * Recruitment › Interview feedback. Only a named interviewer opens it, and only for their OWN scorecard: each
 * criterion is rated 1–5 with optional notes (≤ 500 words), then the overall result and an overview. Once the
 * company's edit lock applies, submitted feedback is shown read-only. The service and the 5202 guard refuse the same.
 */
export default async function InterviewFeedbackPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ problem?: string }> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  await recruitmentViewerAccess(s, scopeIds);
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  let form: ScorecardForm;
  try {
    form = await scorecardForm(s, id);
  } catch (e) {
    if (e instanceof RecruitmentError && ['not_found', 'forbidden', 'not_interviewer', 'interview_closed'].includes(e.code)) notFound();
    throw e;
  }
  const t = await getTranslations('recruitment.fb');
  const locked = !!form.existing && !form.editable;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <PageHeader title={t('title', { name: form.candidateName })} description={`${form.jobTitle} · ${t('round', { n: form.roundNo })} · ${form.formName}`}
        back={{ href: `/recruitment/applications/${form.applicationId}?tab=interviews`, label: t('back') }} />
      <ErrorBanner message={await recruitmentErrorText(sp.problem)} />
      {locked && <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">{t('locked')}</p>}
      <form action={submitScorecardAction} className="space-y-5">
        <input type="hidden" name="interviewId" value={form.interviewId} />
        <input type="hidden" name="applicationId" value={form.applicationId} />
        <fieldset disabled={locked} className="space-y-5">
          <p className="text-xs text-muted-foreground">{t('scale')}</p>
          {form.definition.sections.map((section) => (
            <section key={section.key} className="space-y-4 rounded-xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold">{section.title} <span className="font-normal text-muted-foreground">· {t('outOf', { max: 5 * section.criteria.length })}</span></h2>
              {section.criteria.map((c) => {
                const prior = form.existing?.ratings[c.key];
                return (
                  <div key={c.key} className="space-y-2 border-t border-border pt-3 first-of-type:border-0 first-of-type:pt-0">
                    <fieldset className="space-y-1">
                      <legend className="text-sm font-medium">{c.label}<span className="ml-0.5 text-destructive" aria-label={t('required')}>*</span></legend>
                      {c.question && <p className="text-xs text-muted-foreground">{t('suggested')}: {c.question}</p>}
                      <div className="flex flex-wrap gap-2">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <label key={n} className="inline-flex min-w-11 items-center justify-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
                            <input type="radio" name={`rating:${c.key}`} value={n} required defaultChecked={prior?.rating === n} className="sr-only" />{n}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('notes', { max: NOTES_MAX_WORDS })}
                      <textarea name={`notes:${c.key}`} rows={2} maxLength={5000} defaultValue={prior?.notes ?? ''} className={textareaCls} />
                    </label>
                  </div>
                );
              })}
            </section>
          ))}
          <section className="space-y-3 rounded-xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">{t('overall')}</h2>
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-muted-foreground">{t('result')}{form.resultRequired && <span className="ml-0.5 text-destructive" aria-label={t('required')}>*</span>}</legend>
              <div className="flex flex-wrap gap-2">
                {EVALUATION_RESULTS.map((r) => (
                  <label key={r} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm has-[:checked]:border-primary">
                    <input type="radio" name="result" value={r} required={form.resultRequired} defaultChecked={form.existing?.result === r} />{t(`results.${r}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('overview')}
              <textarea name="overview" rows={4} maxLength={5000} defaultValue={form.existing?.overview ?? ''} className={textareaCls} />
            </label>
          </section>
          <button type="submit" className={btnPrimary}>{form.existing ? t('saveChanges') : t('submit')}</button>
        </fieldset>
      </form>
    </div>
  );
}
