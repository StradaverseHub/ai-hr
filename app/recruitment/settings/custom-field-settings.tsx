import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { localeNames } from '@/i18n/config';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import {
  customFieldSettings, labelFor, CHOICE_TYPES, CUSTOM_DECIMALS_MAX, CUSTOM_FIELD_KINDS, CUSTOM_FIELD_LOCALES, CUSTOM_FIELD_TYPES, CUSTOM_HELP_MAX, CUSTOM_LABEL_MAX,
  type CustomFieldKind, type CustomFieldRow, type CustomLabels,
} from '@/packs/recruitment/service';
import {
  deleteCustomFieldAction, deleteCustomFieldOptionAction, moveCustomFieldAction, moveCustomFieldOptionAction, saveCustomFieldAction, saveCustomFieldOptionAction,
} from '../actions';
import { Pill, klDateTime, selectCls } from '../shared';

type T = Awaited<ReturnType<typeof getTranslations<'recruitment.custom.settings'>>>;
type TC = Awaited<ReturnType<typeof getTranslations<'recruitment.custom'>>>;

/**
 * Settings › Custom fields (slice 14, administrators): the company's own fields for candidates and for jobs, shown after the
 * standard fields on the candidate profile and the job form, in this order. Labels in each language (English required), help
 * text, type, required, restricted (candidates only), enabled; options for choice fields. A field with values keeps its type and
 * restricted setting and cannot be deleted (disable it); an option in use is disabled, not deleted. CANDIDATE fields (and their
 * options) about race, religion, health, pregnancy, criminal records or family details are refused (D-052); job fields are not
 * checked. A required choice field keeps at least one enabled option. "In use" is a yes/no probe, never a count of every value.
 */
export async function CustomFieldSettingsSection({ s, companyId, kind }: { s: SessionContext; companyId: string; kind?: string }) {
  const [t, tc, locale, settings] = await Promise.all([getTranslations('recruitment.custom.settings'), getTranslations('recruitment.custom'), getLocale(),
    customFieldSettings(s, companyId, kind)]);
  const k = settings.kind;
  const kindHref = (next: CustomFieldKind) => `/recruitment/settings?${new URLSearchParams({ company: companyId, section: 'fields', ...(next === 'candidate' ? {} : { kind: next }) })}`;
  const back = kindHref(k);
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('note')}</p>
      <nav aria-label={t('kindLabel')} className="flex gap-2">
        {CUSTOM_FIELD_KINDS.map((key) => (
          <Link key={key} href={kindHref(key)} aria-current={k === key ? 'page' : undefined}
            className={cn('rounded-full border px-3 py-1 text-sm', k === key ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent')}>
            {t(`kinds.${key}`)} <span className="tabular-nums">{k === key ? `(${settings.fields.length})` : ''}</span>
          </Link>
        ))}
      </nav>

      {settings.fields.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ol className="space-y-3">
          {settings.fields.map((f, i) => (
            <li key={f.id} className={cn('space-y-3 rounded-xl border border-border bg-card p-4', !f.enabled && 'border-dashed')}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">{i + 1}. {labelFor(f.labels, locale)}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Pill tone="info">{tc(`types.${f.type}`)}</Pill>
                    <Pill>{f.required ? t('required') : t('optional')}</Pill>
                    {f.restricted && <Pill tone="warn">{tc('restricted')}</Pill>}
                    <Pill tone={f.enabled ? 'good' : 'neutral'}>{f.enabled ? t('enabled') : t('disabled')}</Pill>
                    <span className="text-xs text-muted-foreground">{f.inUse ? t('inUse') : t('notInUse')}</span>
                  </div>
                  {f.helpText && <p className="text-xs text-muted-foreground">{f.helpText}</p>}
                </div>
                <div className="flex items-center gap-1">
                  {(['up', 'down'] as const).map((dir) => (
                    <form key={dir} action={moveCustomFieldAction}>
                      {hidden('fieldId', f.id)}{hidden('direction', dir)}{hidden('returnTo', back)}
                      <button type="submit" className={cn(btnGhost, 'px-2')} disabled={dir === 'up' ? i === 0 : i === settings.fields.length - 1}
                        aria-label={t(dir === 'up' ? 'moveUpNamed' : 'moveDownNamed', { name: labelFor(f.labels, locale) })}>{dir === 'up' ? '↑' : '↓'}</button>
                    </form>
                  ))}
                </div>
              </div>

              <details className="rounded-lg border border-border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">{t('edit')}</summary>
                <FieldForm t={t} tc={tc} kind={k} field={f} companyId={companyId} back={back} />
                <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
                  <span>{t('changed', { by: f.updatedBy ?? t('unnamedUser'), at: klDateTime(locale, f.updatedAt) })}</span>
                  {!f.inUse ? (
                    <form action={deleteCustomFieldAction}>
                      {hidden('fieldId', f.id)}{hidden('returnTo', back)}
                      <button type="submit" className="text-destructive hover:underline">{t('delete')}</button>
                    </form>
                  ) : <span>{t('inUseNote')}</span>}
                </div>
              </details>

              {CHOICE_TYPES.includes(f.type) && <OptionsEditor t={t} f={f} locale={locale} back={back} />}
            </li>
          ))}
        </ol>
      )}

      <section aria-labelledby="new-custom-field" className="space-y-3 rounded-xl border border-dashed border-border p-4">
        <h2 id="new-custom-field" className="text-sm font-semibold">{t(k === 'job' ? 'newJobField' : 'newCandidateField')}</h2>
        <FieldForm t={t} tc={tc} kind={k} companyId={companyId} back={back} />
      </section>
    </div>
  );
}

/** Labels: English (required) and the other five languages (optional; blank shows English). */
function LabelInputs({ t, labels, required, idPrefix }: { t: T; labels?: CustomLabels; required: string; idPrefix: string }) {
  return (
    <>
      <Field label={t('labelEn')} required requiredAriaLabel={required}>
        <Input name="label_en" defaultValue={labels?.en ?? ''} maxLength={CUSTOM_LABEL_MAX} required />
      </Field>
      <details className="sm:col-span-2" id={`${idPrefix}-translations`}>
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t('translations')}</summary>
        <p className="mt-1 text-xs text-muted-foreground">{t('translationsNote')}</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CUSTOM_FIELD_LOCALES.filter((l) => l !== 'en').map((l) => (
            <Field key={l} label={localeNames[l]}><Input name={`label_${l}`} lang={l} defaultValue={labels?.[l] ?? ''} maxLength={CUSTOM_LABEL_MAX} /></Field>
          ))}
        </div>
      </details>
    </>
  );
}

function FieldForm({ t, tc, kind, field, companyId, back }: { t: T; tc: TC; kind: CustomFieldKind; field?: CustomFieldRow; companyId: string; back: string }) {
  const locked = !!field && field.inUse;
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  return (
    <form action={saveCustomFieldAction} className="mt-3 grid gap-3 sm:grid-cols-2">
      {field ? hidden('fieldId', field.id) : <>{hidden('companyId', companyId)}{hidden('kind', kind)}</>}
      {hidden('returnTo', back)}
      <LabelInputs t={t} labels={field?.labels} required={t('requiredMark')} idPrefix={field?.id ?? `new-${kind}`} />
      <Field label={t('type')} required requiredAriaLabel={t('requiredMark')}>
        <select name="type" defaultValue={field?.type ?? 'short_text'} className={selectCls} disabled={locked}>
          {CUSTOM_FIELD_TYPES.map((v) => <option key={v} value={v}>{tc(`types.${v}`)}</option>)}
        </select>
        {locked && <span className="text-xs text-muted-foreground">{t('typeLocked')}</span>}
      </Field>
      <Field label={t('helpText')}><Input name="helpText" defaultValue={field?.helpText ?? ''} maxLength={CUSTOM_HELP_MAX} /></Field>
      <fieldset className="grid gap-3 rounded-lg border border-border p-3 sm:col-span-2 sm:grid-cols-3">
        <legend className="px-1 text-xs font-medium text-muted-foreground">{t('numberSettings')}</legend>
        <Field label={t('numberMin')}><Input name="numberMin" inputMode="decimal" defaultValue={field?.numberMin ?? ''} /></Field>
        <Field label={t('numberMax')}><Input name="numberMax" inputMode="decimal" defaultValue={field?.numberMax ?? ''} /></Field>
        <Field label={t('numberDecimals')}><Input name="numberDecimals" type="number" min={0} max={CUSTOM_DECIMALS_MAX} defaultValue={field?.numberDecimals ?? 0} /></Field>
        <p className="text-xs text-muted-foreground sm:col-span-3">{t('numberNote')}</p>
      </fieldset>
      <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="required" defaultChecked={field?.required ?? false} className="accent-primary" />{t('required')}</label>
        {kind === 'candidate' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="restricted" defaultChecked={field?.restricted ?? false} disabled={locked} className="accent-primary" />{tc('restricted')}
          </label>
        )}
        {locked && field?.restricted && <input type="hidden" name="restricted" value="on" />}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={field?.enabled ?? true} className="accent-primary" />{t('enabled')}</label>
        <button type="submit" className={field ? btnGhost : btnPrimary}>{field ? t('save') : t('add')}</button>
      </div>
      {kind === 'candidate' && <p className="text-xs text-muted-foreground sm:col-span-2">{t('restrictedHint')}</p>}
    </form>
  );
}

function OptionsEditor({ t, f, locale, back }: { t: T; f: CustomFieldRow; locale: string; back: string }) {
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  return (
    <section aria-label={t('optionsOf', { name: labelFor(f.labels, locale) })} className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('options')}</h3>
      {f.options.length === 0 ? <p className="text-sm text-muted-foreground">{t('noOptions')}</p> : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {f.options.map((o, i) => (
            <li key={o.id} className="space-y-2 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={cn('text-sm', !o.enabled && 'text-muted-foreground line-through')}>{labelFor(o.labels, locale)}</span>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span>{o.inUse ? t('inUse') : t('notInUse')}</span>
                  {(['up', 'down'] as const).map((dir) => (
                    <form key={dir} action={moveCustomFieldOptionAction}>
                      {hidden('optionId', o.id)}{hidden('direction', dir)}{hidden('returnTo', back)}
                      <button type="submit" className={cn(btnGhost, 'px-2')} disabled={dir === 'up' ? i === 0 : i === f.options.length - 1}
                        aria-label={t(dir === 'up' ? 'moveUpNamed' : 'moveDownNamed', { name: labelFor(o.labels, locale) })}>{dir === 'up' ? '↑' : '↓'}</button>
                    </form>
                  ))}
                </div>
              </div>
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">{t('edit')}</summary>
                <form action={saveCustomFieldOptionAction} className="mt-2 grid gap-3 sm:grid-cols-2">
                  {hidden('optionId', o.id)}{hidden('returnTo', back)}
                  <LabelInputs t={t} labels={o.labels} required={t('requiredMark')} idPrefix={o.id} />
                  <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={o.enabled} className="accent-primary" />{t('enabled')}</label>
                    <button type="submit" className={btnGhost}>{t('save')}</button>
                  </div>
                </form>
                {!o.inUse ? (
                  <form action={deleteCustomFieldOptionAction} className="mt-2">
                    {hidden('optionId', o.id)}{hidden('returnTo', back)}
                    <button type="submit" className="text-xs text-destructive hover:underline">{t('delete')}</button>
                  </form>
                ) : <p className="mt-2 text-xs text-muted-foreground">{t('optionInUse')}</p>}
              </details>
            </li>
          ))}
        </ul>
      )}
      <form action={saveCustomFieldOptionAction} className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-2">
        {hidden('fieldId', f.id)}{hidden('returnTo', back)}{hidden('enabled', 'on')}
        <LabelInputs t={t} required={t('requiredMark')} idPrefix={`${f.id}-new`} />
        <div className="sm:col-span-2"><button type="submit" className={btnGhost}>{t('addOption')}</button></div>
      </form>
    </section>
  );
}
