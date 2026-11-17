import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import {
  positionTemplateEditor, positionTemplateSettings, CUSTOM_FORM_MARKER, POSITION_TEMPLATE_NAME_MAX, RecruitmentError,
} from '@/packs/recruitment/service';
import {
  deletePositionTemplateAction, savePositionTemplateFormAction, setPositionTemplateEnabledAction, updatePositionTemplateSettingAction,
} from '../actions';
import { JobInfoFields } from '../positions/job-fields';
import { InterviewPlanInputs, TemplateNotes } from '../positions/interview-plan';
import { CustomFieldInputs } from '../custom-fields-ui';
import { ActionForm, FieldProblem } from '../action-form';
import { Pill, klDateTime, selectCls } from '../shared';

/**
 * Settings › Position templates (slice 15, administrators): the company's switch for "New position from template", and its
 * templates — name, the job form's fields, the recruitment process, the interview plan and custom job field values. A template only
 * pre-fills the new-position form; positions never stay linked to it (D-054: there is no industry JD library). `?template=new` or
 * `?template=<id>` opens the template form, where parts that are no longer usable show empty with a note.
 */
export async function PositionTemplateSettingsSection({ s, companyId, here, template }: {
  s: SessionContext; companyId: string; here: string; template?: string;
}) {
  const [t, locale] = await Promise.all([getTranslations('recruitment.templates'), getLocale()]);
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const listHref = `/recruitment/settings?${new URLSearchParams({ company: companyId, section: 'templates' })}`;
  const formHref = (id: string) => `/recruitment/settings?${new URLSearchParams({ company: companyId, section: 'templates', template: id })}`;
  if (template) return <TemplateForm s={s} companyId={companyId} templateId={template} listHref={listHref} />;
  const settings = await positionTemplateSettings(s, companyId);
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('note')}</p>

      <form action={updatePositionTemplateSettingAction} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
        {hidden('companyId', companyId)}{hidden('returnTo', here)}
        <label className="flex min-w-0 flex-1 items-start gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={settings.on} className="mt-0.5 accent-primary" />
          <span><span className="font-medium">{t('settingLabel')}</span><span className="block text-xs text-muted-foreground">{t('settingNote')}</span></span>
        </label>
        <Pill tone={settings.on ? 'good' : 'neutral'}>{settings.on ? t('on') : t('off')}</Pill>
        <button type="submit" className={btnGhost}>{t('save')}</button>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t('listTitle')} <span className="font-normal tabular-nums text-muted-foreground">({settings.templates.length})</span></h2>
        <Link href={formHref('new')} className={btnPrimary}>{t('new')}</Link>
      </div>
      {settings.templates.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {settings.templates.map((row) => (
            <li key={row.id} className={cn('flex flex-wrap items-start justify-between gap-3 px-4 py-3', !row.enabled && 'bg-muted/30')}>
              <div className="min-w-0 space-y-1">
                <Link href={formHref(row.id)} className="font-medium text-primary hover:underline">{row.name}</Link>
                <p className="text-sm">{row.title}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone={row.enabled ? 'good' : 'neutral'}>{row.enabled ? t('enabled') : t('disabled')}</Pill>
                  {row.processName && <Pill tone="info">{row.processName}</Pill>}
                  {row.rounds > 0 && <Pill>{t('rounds', { count: row.rounds })}</Pill>}
                  {row.customValues > 0 && <Pill>{t('customValues', { count: row.customValues })}</Pill>}
                  <span className="text-xs text-muted-foreground">{t('positions', { count: row.positions })}</span>
                </div>
                <p className="text-xs text-muted-foreground">{t('changed', { by: row.updatedBy ?? t('unnamedUser'), at: klDateTime(locale, row.updatedAt) })}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link href={formHref(row.id)} className={btnGhost}>{t('edit')}</Link>
                <form action={setPositionTemplateEnabledAction}>
                  {hidden('templateId', row.id)}{hidden('enabled', row.enabled ? 'false' : 'true')}{hidden('returnTo', here)}
                  <button type="submit" className={btnGhost} aria-label={t(row.enabled ? 'disableNamed' : 'enableNamed', { name: row.name })}>{row.enabled ? t('disable') : t('enable')}</button>
                </form>
                <form action={deletePositionTemplateAction}>
                  {hidden('templateId', row.id)}{hidden('returnTo', here)}
                  <button type="submit" className="px-2 text-sm text-destructive hover:underline" aria-label={t('deleteNamed', { name: row.name })}>{t('delete')}</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t('deleteNote')}</p>
    </div>
  );
}

async function TemplateForm({ s, companyId, templateId, listHref }: { s: SessionContext; companyId: string; templateId: string; listHref: string }) {
  const [t, tj, locale, editor] = await Promise.all([getTranslations('recruitment.templates'), getTranslations('recruitment.job'), getLocale(),
    positionTemplateEditor(s, companyId, templateId).catch((e) => { if (e instanceof RecruitmentError && e.code === 'not_found') return null; throw e; })]);
  // A template that no longer exists (deleted meanwhile, or another company's) says so instead of an error page.
  if (!editor) {
    return (
      <div className="space-y-3">
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('notFound')}</p>
        <Link href={listHref} className={btnGhost}>{t('backToList')}</Link>
      </div>
    );
  }
  const { draft, options } = editor;
  return (
    // A refused save keeps everything typed and names each refused field beside it; only a successful save goes back to the list.
    <ActionForm action={savePositionTemplateFormAction} className="space-y-5">
      <input type="hidden" name="companyId" value={companyId} />
      {editor.template && <input type="hidden" name="templateId" value={editor.template.id} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{editor.template ? t('editTitle', { name: editor.template.name }) : t('newTitle')}</h2>
        <Link href={listHref} className={btnGhost}>{t('backToList')}</Link>
      </div>
      <TemplateNotes notes={editor.notes} fields={options.customFields} locale={locale} />
      <section className="space-y-4 rounded-xl border border-border bg-card p-4">
        <Field label={t('name')} required requiredAriaLabel={tj('required')}>
          <Input name="name" defaultValue={editor.template?.name ?? ''} maxLength={POSITION_TEMPLATE_NAME_MAX} required />
          <span className="text-xs text-muted-foreground">{t('nameNote')}</span>
          <FieldProblem name="name" required={tj('fieldRequired')} invalid={t('nameProblem')} />
        </Field>
        <JobInfoFields options={options} values={draft} template />
        <CustomFieldInputs fields={editor.custom} locale={locale} optional />
        {/* With no enabled custom job field, saving still clears values of fields since disabled or removed (the form shows none). */}
        {editor.custom.length === 0 && <input type="hidden" name={CUSTOM_FORM_MARKER} value="1" />}
      </section>
      <section className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
        <h3 className="text-sm font-semibold sm:col-span-2">{tj('settingsSection')}</h3>
        <Field label={tj('process')}>
          <select name="processId" defaultValue={draft.processId ?? ''} className={selectCls}>
            <option value="">{t('defaultProcess')}</option>
            {options.processes.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <FieldProblem name="processId" required={tj('fieldRequired')} invalid={tj('fieldInvalid')} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={editor.template?.enabled ?? true} className="accent-primary" />{t('enabledLabel')}
        </label>
        <InterviewPlanInputs forms={options.forms} plan={draft.interviewPlan} />
      </section>
      <div className="flex gap-2">
        <button type="submit" className={btnPrimary}>{t('saveTemplate')}</button>
        <Link href={listHref} className={btnGhost}>{tj('cancel')}</Link>
      </div>
    </ActionForm>
  );
}
