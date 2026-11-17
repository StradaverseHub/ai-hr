import { getTranslations } from 'next-intl/server';
import { Field } from '@/components/ui';
import { INTERVIEW_PLAN_FORM_MARKER, INTERVIEW_PLAN_MAX, labelFor, type JobFormOptions, type TemplateNote } from '@/packs/recruitment/service';
import { selectCls } from '../shared';
import { FieldProblem } from '../action-form';

/**
 * Slice 15: the interview plan — one scorecard template (evaluation form) per round, in order. Shared by the new-position form,
 * Job settings and the position template form. The plan has no gaps: empty rounds may only end it (an empty round before a filled
 * one is refused on save, so later rounds are never renumbered). A form
 * that has since been disabled shows only where the plan already holds it. No plan = the default 1st, 2nd and 3rd round (D-005).
 */
export async function InterviewPlanInputs({ forms, plan }: { forms: JobFormOptions['forms']; plan: readonly (string | null)[] }) {
  const [t, tr] = await Promise.all([getTranslations('recruitment.job.plan'), getTranslations('recruitment.iv')]);
  const rows = Math.min(INTERVIEW_PLAN_MAX, Math.max(4, plan.length + 1));
  return (
    <fieldset className="space-y-2 sm:col-span-2">
      <input type="hidden" name={INTERVIEW_PLAN_FORM_MARKER} value="1" />
      <legend className="text-sm font-semibold">{t('title')}</legend>
      <p className="text-xs text-muted-foreground">{t('note')}</p>
      <FieldProblem name="interviewPlan" required={t('problem')} invalid={t('problem')} />
      {forms.length === 0 ? <p className="text-sm text-muted-foreground">{t('noForms')}</p> : (
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: rows }, (_, i) => {
            const chosen = plan[i] ?? '';
            return (
              <li key={i}>
                <Field label={tr('round', { n: i + 1 })}>
                  <select name="interviewPlanFormIds" defaultValue={chosen} className={selectCls}>
                    <option value="">{t('noRound')}</option>
                    {forms.filter((f) => f.enabled || f.id === chosen).map((f) => (
                      <option key={f.id} value={f.id}>{f.enabled ? f.name : t('disabledForm', { name: f.name })}</option>
                    ))}
                  </select>
                </Field>
              </li>
            );
          })}
        </ol>
      )}
    </fieldset>
  );
}

/**
 * Slice 15: what a template named that is no longer usable, in plain words (left empty on the form). Custom fields are named by
 * their label in the viewer's language.
 */
export async function TemplateNotes({ notes, fields, locale }: { notes: readonly TemplateNote[]; fields: JobFormOptions['customFields']; locale: string }) {
  if (!notes.length) return null;
  const [t, tr] = await Promise.all([getTranslations('recruitment.templates.notes'), getTranslations('recruitment.iv')]);
  const text = (n: TemplateNote) => {
    switch (n.kind) {
      case 'jobLevels': return t('jobLevels', { count: n.count });
      case 'interviewRound': return t('interviewRound', { round: tr('round', { n: n.round }) });
      case 'customFields': return t('customFields', { count: n.count });
      case 'customValue': {
        const f = fields.find((x) => x.id === n.fieldId);
        return t('customValue', { field: f ? labelFor(f.labels, locale) : t('unnamedField') });
      }
      default: return t(n.kind);
    }
  };
  return (
    <div role="note" className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
      <p className="font-medium">{t('title')}</p>
      <ul className="list-disc space-y-0.5 pl-5">
        {notes.map((n, i) => <li key={i}>{text(n)}</li>)}
      </ul>
    </div>
  );
}
