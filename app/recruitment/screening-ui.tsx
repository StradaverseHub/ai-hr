import { getTranslations } from 'next-intl/server';
import { btnPrimary } from '@/components/ui';
import { SCREENING_COMMENT_MAX, SCREENING_RESULTS, type AssignmentStatus, type ScreeningAnswerView, type ScreeningResult } from '@/packs/recruitment/service';
import { answerScreeningAction } from './actions';
import { Pill, klDateTime, textareaCls } from './shared';

/** Slice 11 — the screening pieces shared by the board, the application page and the To screen page (server components). */

const STATUS_TONE: Record<AssignmentStatus, 'neutral' | 'warn' | 'good' | 'bad'> = { not_assigned: 'neutral', awaiting: 'warn', positive: 'good', negative: 'bad' };
const RESULT_TONE: Record<ScreeningResult, 'warn' | 'good' | 'bad'> = { pending: 'warn', advance: 'good', reject: 'bad' };

/** An application's assignment status as a pill: the words state it, the colour only reinforces it. */
export async function ScreeningStatusPill({ status }: { status: AssignmentStatus }) {
  const t = await getTranslations('recruitment.screening');
  return <Pill tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Pill>;
}

/** Answers, oldest first: the result, who and when, and the comment. */
export async function ScreeningAnswers({ answers, locale, showName = true }: { answers: ScreeningAnswerView[]; locale: string; showName?: boolean }) {
  if (!answers.length) return null;
  const t = await getTranslations('recruitment.screening');
  return (
    <ol className="space-y-2">
      {answers.map((a) => (
        <li key={a.id} className="space-y-1 border-l-2 border-border pl-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Pill tone={RESULT_TONE[a.result]}>{t(`result.${a.result}`)}</Pill>
            <span className="text-xs text-muted-foreground">
              {showName ? `${a.byViewer ? t('you') : a.answeredBy ?? t('unnamedUser')} · ` : ''}{klDateTime(locale, a.answeredAt)}
            </span>
          </p>
          {a.comment && <p className="whitespace-pre-wrap">{a.comment}</p>}
        </li>
      ))}
    </ol>
  );
}

/** The company screening form (D-040): Advance, Reject or Pending (required) and an optional comment. */
export async function ScreeningAnswerForm({ requestId, returnTo, idPrefix }: { requestId: string; returnTo: string; idPrefix: string }) {
  const t = await getTranslations('recruitment.screening');
  return (
    <form action={answerScreeningAction} className="space-y-3">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">{t('resultLabel')}<span className="ml-0.5 text-destructive" aria-label={t('required')}>*</span></legend>
        <div className="flex flex-wrap gap-2">
          {SCREENING_RESULTS.map((r) => (
            <label key={r} htmlFor={`${idPrefix}-${r}`}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
              <input id={`${idPrefix}-${r}`} type="radio" name="result" value={r} required className="accent-primary" />
              <span>
                <span className="font-medium">{t(`result.${r}`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`resultHint.${r}`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex flex-col gap-1.5" htmlFor={`${idPrefix}-comment`}>
        <span className="text-xs font-medium text-muted-foreground">{t('comment')}</span>
        <textarea id={`${idPrefix}-comment`} name="comment" rows={3} maxLength={SCREENING_COMMENT_MAX} className={textareaCls} placeholder={t('commentHint')} />
      </label>
      <button type="submit" className={btnPrimary}>{t('sendFeedback')}</button>
    </form>
  );
}
