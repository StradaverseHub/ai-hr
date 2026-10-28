import { getTranslations } from 'next-intl/server';
import { Field, inputCls } from '@/components/ui';
import { rewardCalendarStages, rewardOffcycleSlaStages, type RewardCalendarValues } from '@/packs/rewards/service';
import { RewardSubmit } from '../submit-button';
import { calendarAction } from '../actions';

/** Reward calendar for the review's cycle in its company (migration 0646). Writers: Group Rewards or HR admin. */
export async function RewardCalendarForm({ unitId, revision, values, canEdit }: { unitId: string; revision: number; values: RewardCalendarValues; canEdit: boolean }) {
  const t = await getTranslations('rewards');
  const days = (n: number | null) => n == null ? t('calendar.notSet') : t('calendar.days', { days: n });
  return <section id="calendar" className="max-w-3xl scroll-mt-20 space-y-4">
    <h2 className="font-semibold">{t('calendar.title')}</h2>
    <p className="text-sm text-muted-foreground">{t('calendar.help')}</p>
    {!canEdit && <p className="text-sm text-muted-foreground">{t('calendar.readOnly')}</p>}
    {canEdit ? <form action={calendarAction} className="space-y-5">
      <input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={revision} />
      <fieldset className="grid gap-4 sm:grid-cols-2"><legend className="mb-2 text-sm font-medium">{t('calendar.annual')}</legend>
        {rewardCalendarStages.map(k => <Field key={k} label={t(`calendar.stage.${k}`)}><input type="date" name={`due.${k}`} defaultValue={values.due[k] ?? ''} className={inputCls} /></Field>)}
        <Field label={t('calendar.caseDue')}><input type="date" name="caseDue" defaultValue={values.caseDue ?? ''} className={inputCls} /></Field>
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2"><legend className="mb-1 text-sm font-medium">{t('calendar.offcycle')}</legend>
        <p className="text-sm text-muted-foreground sm:col-span-2">{t('calendar.offcycleHelp')}</p>
        {rewardOffcycleSlaStages.map(k => <Field key={k} label={t(`calendar.stage.${k}`)}><input type="number" min={1} max={90} step={1} name={`days.${k}`} defaultValue={values.offcycleDays[k] ?? ''} className={inputCls} /></Field>)}
      </fieldset>
      <RewardSubmit type="submit">{t('calendar.save')}</RewardSubmit>
    </form> : <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {rewardCalendarStages.map(k => <div key={k}><dt className="text-muted-foreground">{t(`calendar.stage.${k}`)}</dt><dd className="tabular-nums">{values.due[k] ?? t('calendar.notSet')}</dd></div>)}
      <div><dt className="text-muted-foreground">{t('calendar.caseDue')}</dt><dd className="tabular-nums">{values.caseDue ?? t('calendar.notSet')}</dd></div>
      {rewardOffcycleSlaStages.map(k => <div key={`d-${k}`}><dt className="text-muted-foreground">{t('calendar.offcycle')} · {t(`calendar.stage.${k}`)}</dt><dd className="tabular-nums">{days(values.offcycleDays[k])}</dd></div>)}
    </dl>}
  </section>;
}
