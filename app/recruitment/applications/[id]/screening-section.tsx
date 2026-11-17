import { getTranslations } from 'next-intl/server';
import { btnGhost, btnPrimary } from '@/components/ui';
import { SCREENING_NOTE_MAX, type ApplicationScreening } from '@/packs/recruitment/service';
import { reassignScreeningAction, sendForScreeningAction, withdrawScreeningAction } from '../../actions';
import { Pill, klDateTime, textareaCls } from '../../shared';
import { ScreeningAnswerForm, ScreeningAnswers, ScreeningStatusPill } from '../../screening-ui';

/**
 * Slice 11 — an application's Screening section. Operators and administrators: the status, "Send to hiring manager" (first
 * send, with the optional move) or "Reassign" (more reviewers), every request with its answers, and Withdraw on open ones.
 * A hiring manager: their own requests with the feedback form on an open one, and the answers of other reviewers.
 */
export async function ScreeningSection({ screening, here, locale }: { screening: ApplicationScreening; here: string; locale: string }) {
  const t = await getTranslations('recruitment.screening');
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const free = (screening.reviewers ?? []).filter((r) => !r.asked);
  const first = screening.requests.length === 0;
  const stateTone = { open: 'warn', answered: 'good', withdrawn: 'neutral', application_closed: 'neutral', reviewer_removed: 'neutral' } as const;
  return (
    <div className="space-y-4">
      {screening.status && (
        <p className="flex items-center gap-2 text-sm"><span className="text-muted-foreground">{t('statusLabel')}</span><ScreeningStatusPill status={screening.status} /></p>
      )}
      {screening.canOperate && screening.active && (
        <section aria-labelledby="screening-send-title" className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 id="screening-send-title" className="text-sm font-semibold">{first ? t('send') : t('reassign')}</h2>
          {screening.reviewers === null ? <p className="text-sm text-muted-foreground">{t('reviewersUnavailable')}</p>
            : screening.reviewers.length === 0 ? <p className="text-sm text-muted-foreground">{t('noHiringManager')}</p>
            : free.length === 0 ? <p className="text-sm text-muted-foreground">{t('everyoneAsked')}</p> : (
              <form action={first ? sendForScreeningAction : reassignScreeningAction} className="space-y-3">
                {hidden('returnTo', here)}{hidden('reviewersChosen', '1')}
                {first ? hidden('applicationIds', screening.applicationId) : hidden('applicationId', screening.applicationId)}
                <fieldset className="space-y-1.5">
                  <legend className="text-xs font-medium text-muted-foreground">{t('reviewers')}</legend>
                  {free.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="reviewerUserIds" value={r.id} defaultChecked={first} className="accent-primary" />
                      {r.name ?? t('unnamedUser')}
                    </label>
                  ))}
                </fieldset>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('note')}</span>
                  <textarea name="note" rows={3} maxLength={SCREENING_NOTE_MAX} className={textareaCls} placeholder={t('noteHint')} />
                </label>
                {first && screening.nextStage && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="move" defaultChecked className="accent-primary" />
                    {t('alsoMove', { stage: screening.nextStage.name })}
                  </label>
                )}
                <button type="submit" className={btnPrimary}>{first ? t('sendButton') : t('reassignButton')}</button>
              </form>
            )}
        </section>
      )}
      {screening.requests.length === 0 && screening.otherAnswers.length === 0 && (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('none')}</p>
      )}
      {screening.requests.length > 0 && (
        <ul className="space-y-3">
          {screening.requests.map((r) => (
            <li key={r.id} id={`request-${r.id}`} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{r.reviewerIsViewer ? t('youReviewer') : r.reviewerName ?? t('unnamedUser')}</p>
                <Pill tone={stateTone[r.state]}>{t(`state.${r.state}`)}</Pill>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('sentBy', { name: r.sentBy ?? t('unnamedUser'), time: klDateTime(locale, r.sentAt) })}
                {r.state !== 'open' && r.state !== 'answered' && r.closedAt && <> · {t('closedAt', { time: klDateTime(locale, r.closedAt) })}</>}
              </p>
              {r.note && <p className="whitespace-pre-wrap rounded-md bg-muted/60 px-3 py-2 text-sm"><span className="font-medium">{t('note')}:</span> {r.note}</p>}
              <ScreeningAnswers answers={r.answers} locale={locale} />
              {r.canAnswer && <ScreeningAnswerForm requestId={r.id} returnTo={here} idPrefix={`answer-${r.id}`} />}
              {r.canWithdraw && (
                <form action={withdrawScreeningAction}>
                  {hidden('requestId', r.id)}{hidden('applicationId', screening.applicationId)}{hidden('returnTo', here)}
                  <button type="submit" className={btnGhost}>{t('withdraw')}</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {screening.otherAnswers.length > 0 && (
        <section aria-labelledby="screening-others-title" className="space-y-2 rounded-xl border border-border bg-card p-4">
          <h2 id="screening-others-title" className="text-sm font-semibold">{t('otherAnswers')}</h2>
          <ScreeningAnswers answers={screening.otherAnswers} locale={locale} />
        </section>
      )}
    </div>
  );
}
