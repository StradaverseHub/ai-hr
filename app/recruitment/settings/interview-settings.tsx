import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnPrimary } from '@/components/ui';
import { FEEDBACK_EDIT_LOCKS, interviewSettings } from '@/packs/recruitment/service';
import { saveEvaluationFormAction, updateInterviewSettingsAction } from '../actions';
import { selectCls, textareaCls } from '../shared';

/**
 * Settings › Interviews (slice 2): who may see scorecards, when feedback locks, whether the overall result is required,
 * and the evaluation forms. A form an interview already uses keeps its questions; create a new form to change them.
 */
export async function InterviewSettingsSection({ s, companyId, here }: { s: SessionContext; companyId: string; here: string }) {
  const [t, settings] = await Promise.all([getTranslations('recruitment.settings.iv'), interviewSettings(s, companyId)]);
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  return (
    <div className="space-y-6">
      <form action={updateInterviewSettingsAction} className="space-y-4 rounded-xl border border-border bg-card p-4">
        {hidden('companyId', companyId)}{hidden('returnTo', here)}
        <h2 className="text-base font-semibold">{t('rulesTitle')}</h2>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="scorecardsPrivate" defaultChecked={settings.scorecardsPrivate} className="mt-0.5" />
          <span>{t('private')}<span className="block text-xs text-muted-foreground">{t('privateNote')}</span></span></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="resultRequired" defaultChecked={settings.resultRequired} className="mt-0.5" />{t('resultRequired')}</label>
        <Field label={t('lock')} className="max-w-md">
          <select name="feedbackEditLock" defaultValue={settings.feedbackEditLock} className={selectCls}>
            {FEEDBACK_EDIT_LOCKS.map((l) => <option key={l} value={l}>{t(`locks.${l}`)}</option>)}
          </select>
        </Field>
        <button type="submit" className={btnPrimary}>{t('save')}</button>
      </form>

      <section className="space-y-3" aria-labelledby="forms-title">
        <div><h2 id="forms-title" className="text-base font-semibold">{t('formsTitle')}</h2><p className="text-sm text-muted-foreground">{t('formsNote')}</p></div>
        {settings.forms.map((f) => (
          <form key={f.id} action={saveEvaluationFormAction} className="space-y-3 rounded-xl border border-border bg-card p-4">
            {hidden('formId', f.id)}{hidden('returnTo', here)}
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <Field label={t('formName')}><Input name="name" defaultValue={f.name} maxLength={120} required /></Field>
              <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="isDefault" defaultChecked={f.isDefault} disabled={f.isDefault} />{t('default')}
                {f.isDefault && hidden('isDefault', 'on')}</label>
              <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={f.enabled} />{t('enabled')}</label>
            </div>
            <Field label={t('questions')}>
              <textarea name="source" defaultValue={f.source} rows={8} readOnly={f.inUse} className={textareaCls} />
              <span className="text-xs text-muted-foreground">{f.inUse ? t('inUse') : t('editorHint')}</span>
            </Field>
            <button type="submit" className={btnPrimary}>{t('saveForm')}</button>
          </form>
        ))}
        <form action={saveEvaluationFormAction} className="space-y-3 rounded-xl border border-dashed border-border p-4">
          {hidden('companyId', companyId)}{hidden('returnTo', here)}
          <h3 className="text-sm font-semibold">{t('newForm')}</h3>
          <Field label={t('formName')}><Input name="name" maxLength={120} required /></Field>
          <Field label={t('questions')}>
            <textarea name="source" rows={6} required placeholder={t('editorPlaceholder')} className={textareaCls} />
            <span className="text-xs text-muted-foreground">{t('editorHint')}</span>
          </Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked />{t('enabled')}</label>
          <button type="submit" className={btnPrimary}>{t('addForm')}</button>
        </form>
      </section>
    </div>
  );
}
