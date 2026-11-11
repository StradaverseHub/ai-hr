import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { btnPrimary } from '@/components/ui';
import { pgSqlState } from '@/lib/db-error';
import { RecruitmentError, SCREENING_NOTE_MAX, screeningSendOptions } from '@/packs/recruitment/service';
import { sendForScreeningAction } from '../actions';
import { textareaCls } from '../shared';

/** The form the board's card checkboxes belong to (their `form` attribute), so one or several cards go in one send. */
export const SCREENING_SEND_FORM = 'screening-send';

/**
 * Slice 11 — "Send to hiring manager" for the cards ticked on the board (one job): the job's hiring managers (all ticked by
 * default), an optional note, and "also move to <next stage>" (on by default; offered only when the stage has a next one).
 * The service and 4411 refuse anybody but the job's operators and administrators.
 */
export async function ScreeningSendPanel({ s, jobId, here, nextStage, selectable }: {
  s: SessionContext; jobId: string; here: string; nextStage: string | null; selectable: number;
}) {
  const t = await getTranslations('recruitment.screening');
  // A refusal hides the panel; any other failure (a timeout, a replica conflict) is logged by kind and the board still renders.
  const options = await screeningSendOptions(s, jobId).catch((e) => {
    if (!(e instanceof RecruitmentError)) console.error('recruitment send options failed', e instanceof Error ? e.name : typeof e, pgSqlState(e) ?? '');
    return null;
  });
  if (!options) return null;
  return (
    <section id="screening-send-panel" aria-labelledby="screening-send-title" className="scroll-mt-20 space-y-3 rounded-xl border border-border bg-card p-4">
      <h2 id="screening-send-title" className="text-sm font-semibold">{t('send')}</h2>
      {options.reviewers === null ? <p className="text-sm text-muted-foreground">{t('reviewersUnavailable')}</p>
        : options.reviewers.length === 0 ? <p className="text-sm text-muted-foreground">{t('noHiringManager')}</p> : selectable === 0 ? (
        <p className="text-sm text-muted-foreground">{t('nothingToSend')}</p>
      ) : (
        <form id={SCREENING_SEND_FORM} action={sendForScreeningAction} className="space-y-3">
          <input type="hidden" name="returnTo" value={here} />
          <input type="hidden" name="reviewersChosen" value="1" />
          <p className="text-xs text-muted-foreground">{t('selectHint')}</p>
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-muted-foreground">{t('reviewers')}</legend>
            {options.reviewers.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="reviewerUserIds" value={r.id} defaultChecked className="accent-primary" />
                {r.name ?? t('unnamedUser')}
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('note')}</span>
            <textarea name="note" rows={3} maxLength={SCREENING_NOTE_MAX} className={textareaCls} placeholder={t('noteHint')} />
          </label>
          {nextStage && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="move" defaultChecked className="accent-primary" />
              {t('alsoMove', { stage: nextStage })}
            </label>
          )}
          <button type="submit" className={btnPrimary}>{t('sendButton')}</button>
        </form>
      )}
    </section>
  );
}
