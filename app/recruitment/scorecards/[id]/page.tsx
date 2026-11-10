import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { PageHeader } from '@/components/ui';
import { getScorecard, RecruitmentError, type ScorecardView } from '@/packs/recruitment/service';
import { Pill, klDateTime, recruitmentViewerAccess } from '../../shared';

/**
 * Recruitment › Scorecard. Shown only when row security returns it: to its author, the job's recruiter, assistants,
 * hiring managers and administrators, and to the application's other interviewers only when the company shares
 * scorecards. Section totals are sums of the 1–5 ratings over 5 × the number of criteria.
 */
export default async function ScorecardPage({ params }: { params: Promise<{ id: string }> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  await recruitmentViewerAccess(s, scopeIds);
  const { id } = await params;
  let card: ScorecardView;
  try {
    card = await getScorecard(s, id);
  } catch (e) {
    if (e instanceof RecruitmentError) notFound();
    throw e;
  }
  const [t, locale] = await Promise.all([getTranslations('recruitment.fb'), getLocale()]);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <PageHeader title={t('scorecardTitle', { name: card.interviewerName ?? t('unnamedUser') })} description={`${t('round', { n: card.roundNo })} · ${card.formName} · ${klDateTime(locale, card.updatedAt)}`} />
      <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
        <span className="text-sm font-semibold">{t('result')}</span>
        {card.result ? <Pill tone={card.result === 'recommended' ? 'good' : card.result === 'not_suitable' ? 'bad' : 'neutral'}>{t(`results.${card.result}`)}</Pill> : <span className="text-sm text-muted-foreground">—</span>}
        {card.overview && <p className="w-full whitespace-pre-wrap text-sm">{card.overview}</p>}
      </section>
      {card.sections.map((sec) => (
        <section key={sec.key} className="space-y-2 rounded-xl border border-border bg-card p-4">
          <h2 className="flex items-center justify-between text-sm font-semibold">{sec.title}<span className="tabular-nums">{t('total', { sum: sec.sum, max: sec.max })}</span></h2>
          <ul className="divide-y divide-border text-sm">
            {sec.criteria.map((c) => (
              <li key={c.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <span className="min-w-0 flex-1">{c.label}{c.notes && <span className="block whitespace-pre-wrap text-xs text-muted-foreground">{c.notes}</span>}</span>
                <span className="tabular-nums font-medium">{c.rating ?? '—'} / 5</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
