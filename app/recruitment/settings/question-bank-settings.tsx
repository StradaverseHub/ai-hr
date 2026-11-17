import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import {
  FORM_QUESTIONS_MAX, QUESTION_CATEGORY_MAX, QUESTION_GUIDANCE_MAX, QUESTION_TITLE_MAX, QUESTIONS_MAX, questionBankSettings, type QuestionBankSettings,
} from '@/packs/recruitment/service';
import { deleteInterviewQuestionAction, saveInterviewQuestionFormAction, setInterviewQuestionRetiredAction } from '../actions';
import { ActionForm, FieldProblem } from '../action-form';
import { Pill, klDateTime, textareaCls } from '../shared';

/**
 * Settings › Question bank (slice 18, administrators): questions with optional guidance and category, linked to scorecard templates
 * (Settings › Interviews). Interviewers see a template's linked questions as read-only guidance on the feedback form; questions are
 * never answered and add nothing to scores. Retiring a question hides it from every feedback form opened afterwards; a linked
 * question cannot be deleted (unlink or retire it).
 */
export async function QuestionBankSettingsSection({ s, companyId }: { s: SessionContext; companyId: string }) {
  const [t, locale, bank] = await Promise.all([getTranslations('recruitment.setup'), getLocale(), questionBankSettings(s, companyId)]);
  const problem = { required: t('fieldRequired'), invalid: t('fieldInvalid') };
  const fields = (q: QuestionBankSettings['questions'][number] | null) => (
    <>
      <Field label={t('questions.title')} required requiredAriaLabel={t('fieldRequired')}>
        <Input name="title" defaultValue={q?.title ?? ''} maxLength={QUESTION_TITLE_MAX} required />
        <FieldProblem name="title" {...problem} />
      </Field>
      <Field label={t('questions.guidance', { max: QUESTION_GUIDANCE_MAX })}>
        <textarea name="guidance" rows={3} maxLength={QUESTION_GUIDANCE_MAX} defaultValue={q?.guidance ?? ''} className={textareaCls} />
        <FieldProblem name="guidance" {...problem} />
      </Field>
      <Field label={t('questions.category')}>
        <Input name="category" defaultValue={q?.category ?? ''} maxLength={QUESTION_CATEGORY_MAX} />
        <FieldProblem name="category" {...problem} />
      </Field>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('questions.templates', { max: FORM_QUESTIONS_MAX })}</legend>
        <div className="grid gap-1 text-sm sm:grid-cols-2">
          {bank.forms.map((f) => (
            <label key={f.id} className="flex items-center gap-1.5">
              <input type="checkbox" name="formIds" value={f.id} defaultChecked={!!q?.forms.some((x) => x.id === f.id)} className="accent-primary"
                disabled={!!q?.retired && !q.forms.some((x) => x.id === f.id)} />
              {f.name}{!f.enabled && <span className="text-xs text-muted-foreground"> ({t('questions.formDisabled')})</span>}
            </label>
          ))}
        </div>
        <FieldProblem name="formIds" {...problem} />
      </fieldset>
    </>
  );
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('questions.note')}</p>
      {bank.forms.length > 0 && (
        <p role="note" className="max-w-3xl rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          {bank.forms.map((f) => t('questions.formCount', { form: f.name, count: f.questions })).join(' · ')}
        </p>
      )}
      {bank.questions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('questions.empty')}</p>
      ) : (
        <ul className="space-y-3">
          {bank.questions.map((q) => (
            <li key={q.id} className={q.retired ? 'space-y-3 rounded-xl border border-dashed border-border p-4' : 'space-y-3 rounded-xl border border-border bg-card p-4'}>
              <details>
                <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{q.title}{q.category && <span className="ml-2 text-xs font-normal text-muted-foreground">{q.category}</span>}</span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {q.retired && <Pill>{t('questions.retired')}</Pill>}
                    {t('changedAt', { at: klDateTime(locale, q.updatedAt) })}
                  </span>
                </summary>
                <ActionForm action={saveInterviewQuestionFormAction} className="mt-3 space-y-3">
                  <input type="hidden" name="questionId" value={q.id} /><input type="hidden" name="companyId" value={companyId} />
                  {fields(q)}
                  <button type="submit" className={btnPrimary}>{t('save')}</button>
                </ActionForm>
              </details>
              <p className="text-xs text-muted-foreground">{q.forms.length ? t('questions.linkedTo', { forms: q.forms.map((f) => f.name).join(', ') }) : t('questions.notLinked')}</p>
              <div className="flex flex-wrap gap-2">
                <form action={setInterviewQuestionRetiredAction}>
                  <input type="hidden" name="questionId" value={q.id} /><input type="hidden" name="companyId" value={companyId} />
                  <input type="hidden" name="retired" value={q.retired ? 'false' : 'true'} />
                  <button type="submit" className={btnGhost}>{q.retired ? t('questions.restore') : t('questions.retire')}</button>
                </form>
                {q.forms.length === 0 && (
                  <form action={deleteInterviewQuestionAction}>
                    <input type="hidden" name="questionId" value={q.id} /><input type="hidden" name="companyId" value={companyId} />
                    <button type="submit" className={btnGhost} aria-label={t('deleteNamed', { name: q.title })}>{t('delete')}</button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {bank.questions.length < QUESTIONS_MAX && (
        <ActionForm action={saveInterviewQuestionFormAction} className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('questions.newTitle')}</h2>
          <input type="hidden" name="companyId" value={companyId} />
          {fields(null)}
          <button type="submit" className={btnPrimary}>{t('add')}</button>
        </ActionForm>
      )}
    </div>
  );
}
