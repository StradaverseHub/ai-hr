import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import { WAITING_ARCHIVE_MAX, WAITING_DAY_KINDS, WAITING_REMIND_MAX, waitingRuleSettings } from '@/packs/recruitment/service';
import { deleteWaitingRuleAction, saveWaitingRuleFormAction } from '../actions';
import { ActionForm, FieldProblem } from '../action-form';
import { Pill, klDateTime, selectCls } from '../shared';

/**
 * Settings › Waiting limits (slice 17, administrators): per enabled stage, remind after N days and optionally suggest archiving after
 * M days, in calendar or working days. Working days skip weekends and the company's public holidays from the holiday calendar; the
 * page says which applies. The limits only remind and suggest: an operator archives from a job's "Suggested to archive" list (D-057).
 * Each stage's form keeps what was typed when a save is refused.
 */
export async function WaitingSettingsSection({ s, companyId, here }: { s: SessionContext; companyId: string; here: string }) {
  const [t, locale, settings] = await Promise.all([getTranslations('recruitment.waiting'), getLocale(), waitingRuleSettings(s, companyId)]);
  const problem = { required: t('fieldRequired'), invalid: t('fieldInvalid') };
  return (
    <div className="space-y-6">
      <div className="max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>{t('settingsNote')}</p>
        <p role="note" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-foreground">
          {settings.holidaysThisYear > 0 ? t('calendarConfigured', { count: settings.holidaysThisYear, year: settings.year }) : t('calendarWeekendsOnly')}
        </p>
      </div>
      {settings.stages.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('noStages')}</p>
      ) : (
        <ul className="space-y-3">
          {settings.stages.map((row) => (
            <li key={row.stageId} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-medium">{row.stageName}</h2>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {!row.stageEnabled && <Pill>{t('stageDisabled')}</Pill>}
                  {row.rule ? t('changed', { by: row.rule.updatedBy ?? t('unnamedUser'), at: klDateTime(locale, row.rule.updatedAt) }) : t('noRule')}
                </span>
              </div>
              <ActionForm action={saveWaitingRuleFormAction} className="grid gap-3 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end">
                <input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="stageId" value={row.stageId} />
                <Field label={t('remindDays', { max: WAITING_REMIND_MAX })} required requiredAriaLabel={t('fieldRequired')}>
                  <Input name="remindDays" type="number" inputMode="numeric" min={1} max={WAITING_REMIND_MAX} step={1} required defaultValue={row.rule?.remindDays ?? ''} />
                  <FieldProblem name="remindDays" {...problem} />
                </Field>
                <Field label={t('archiveDays', { max: WAITING_ARCHIVE_MAX })}>
                  <Input name="archiveDays" type="number" inputMode="numeric" min={2} max={WAITING_ARCHIVE_MAX} step={1} defaultValue={row.rule?.archiveDays ?? ''} />
                  <FieldProblem name="archiveDays" {...problem} />
                </Field>
                <Field label={t('dayKind')} required requiredAriaLabel={t('fieldRequired')}>
                  <select name="dayKind" defaultValue={row.rule?.dayKind ?? 'working'} className={selectCls} required>
                    {WAITING_DAY_KINDS.map((k) => <option key={k} value={k}>{t(`dayKinds.${k}`)}</option>)}
                  </select>
                  <FieldProblem name="dayKind" {...problem} />
                </Field>
                <button type="submit" className={btnPrimary}>{row.rule ? t('save') : t('add')}</button>
              </ActionForm>
              {row.rule && (
                <form action={deleteWaitingRuleAction}>
                  <input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="stageId" value={row.stageId} />
                  <input type="hidden" name="returnTo" value={here} />
                  <button type="submit" className={btnGhost} aria-label={t('removeNamed', { stage: row.stageName })}>{t('remove')}</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="max-w-3xl text-xs text-muted-foreground">{t('archiveNote')}</p>
    </div>
  );
}
