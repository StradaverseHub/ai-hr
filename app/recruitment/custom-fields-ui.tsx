import { getTranslations } from 'next-intl/server';
import { Field, Input } from '@/components/ui';
import { cn } from '@/lib/utils';
import {
  CUSTOM_FORM_MARKER, CUSTOM_LONG_TEXT_MAX, CUSTOM_SHORT_TEXT_MAX, answerable, customInputName, formValue, labelFor, type CustomFieldView, type CustomFilterChoice,
} from '@/packs/recruitment/service';
import { Pill, selectCls, textareaCls } from './shared';
import { FieldProblem } from './action-form';

/**
 * Slice 14: custom candidate and job fields on a form and on a record page, and the one-field filter. Every list here is the
 * service's answer for the viewer (restricted candidate fields only reach an administrator or the candidate's job operators).
 * Labels and options show in the viewer's language, or in English when an administrator gave none.
 */
export async function CustomFieldInputs({ fields, locale, optional = false }: { fields: CustomFieldView[]; locale: string;
  /** Slice 15: a position template's values — every field may be left empty (the position asks for required ones on save). */
  optional?: boolean }) {
  if (!fields.length) return null;
  const [t, tj] = await Promise.all([getTranslations('recruitment.custom'), getTranslations('recruitment.job')]);
  // Inside an ActionForm (new position, position template), a refused custom field says so beside it.
  const problem = { required: tj('fieldRequired'), invalid: tj('fieldInvalid') };
  return (
    <fieldset className="space-y-3 border-t border-border pt-4">
      <input type="hidden" name={CUSTOM_FORM_MARKER} value="1" />
      <legend className="sr-only">{t('section')}</legend>
      <div>
        <h3 className="text-sm font-semibold">{t('section')}</h3>
        <p className="text-xs text-muted-foreground">{t('sectionNote')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => <CustomInput key={f.id} f={optional ? { ...f, required: false } : f} locale={locale} t={t} problem={problem} />)}
      </div>
    </fieldset>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<'recruitment.custom'>>>;

function CustomInput({ f, locale, t, problem }: { f: CustomFieldView; locale: string; t: T; problem: { required: string; invalid: string } }) {
  const name = customInputName(f.id);
  // A required choice field with nothing to choose is not enforced (the service skips it too).
  const required = f.required && answerable(f, f.value);
  const label = labelFor(f.labels, locale);
  const value = formValue(f.value);
  const one = typeof value === 'string' ? value : '';
  const chosen = new Set(Array.isArray(value) ? value : []);
  const help = [f.helpText, f.type === 'number' ? numberHint(f, t) : null].filter(Boolean).join(' · ');
  const helpEl = help ? <span className="text-xs text-muted-foreground">{help}</span> : null;
  const restricted = f.restricted ? <span className="ml-1 align-middle"><Pill tone="warn">{t('restricted')}</Pill></span> : null;
  const optionLabel = (o: CustomFieldView['options'][number]) => (o.enabled ? labelFor(o.labels, locale) : t('disabledOption', { label: labelFor(o.labels, locale) }));
  if (f.type === 'multiple_choice') {
    return (
      <fieldset className={cn('flex flex-col gap-1.5', 'sm:col-span-2 lg:col-span-3')}>
        <legend className="text-xs font-medium text-muted-foreground">
          {label}{required && <span className="ml-0.5 text-destructive" aria-label={t('required')}>*</span>}{restricted}
        </legend>
        {f.options.length === 0 ? <span className="text-sm text-muted-foreground">{t('noOptions')}</span> : (
          <div className="flex flex-wrap gap-2">
            {f.options.map((o) => (
              <label key={o.id} className="inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 text-sm">
                <input type="checkbox" name={name} value={o.id} defaultChecked={chosen.has(o.id)} className="accent-primary" />{optionLabel(o)}
              </label>
            ))}
          </div>
        )}
        {helpEl}
        <FieldProblem name={name} {...problem} />
      </fieldset>
    );
  }
  const wide = f.type === 'long_text' ? 'sm:col-span-2 lg:col-span-3' : undefined;
  let control;
  switch (f.type) {
    case 'long_text':
      control = <textarea name={name} defaultValue={one} maxLength={CUSTOM_LONG_TEXT_MAX} rows={3} required={required} className={textareaCls} />;
      break;
    case 'number': {
      const step = f.numberDecimals ? `0.${'0'.repeat(f.numberDecimals - 1)}1` : '1';
      control = <Input name={name} type="number" inputMode="decimal" step={step} min={f.numberMin ?? undefined} max={f.numberMax ?? undefined} defaultValue={one} required={required} />;
      break;
    }
    case 'date': control = <Input name={name} type="date" defaultValue={one} required={required} />; break;
    case 'year_month': control = <Input name={name} type="month" defaultValue={one} required={required} />; break;
    case 'yes_no':
      control = (
        <select name={name} defaultValue={one} className={selectCls} required={required}>
          <option value="">{t('notAnswered')}</option><option value="yes">{t('yes')}</option><option value="no">{t('no')}</option>
        </select>
      );
      break;
    case 'single_choice':
      control = (
        <select name={name} defaultValue={chosen.values().next().value ?? ''} className={selectCls} required={required}>
          <option value="">{t('choose')}</option>
          {f.options.map((o) => <option key={o.id} value={o.id}>{optionLabel(o)}</option>)}
        </select>
      );
      break;
    default:
      control = <Input name={name} defaultValue={one} maxLength={CUSTOM_SHORT_TEXT_MAX} required={required} />;
  }
  return (
    <div className={cn('flex flex-col gap-1', wide)}>
      <Field label={label} required={required} requiredAriaLabel={t('required')}>{control}<FieldProblem name={name} {...problem} /></Field>
      {(restricted || helpEl) && <div className="flex flex-wrap items-center gap-2">{restricted}{helpEl}</div>}
    </div>
  );
}

const numberHint = (f: CustomFieldView, t: T) => {
  const parts = [
    f.numberMin && f.numberMax ? t('range', { min: f.numberMin, max: f.numberMax }) : f.numberMin ? t('atLeast', { min: f.numberMin }) : f.numberMax ? t('atMost', { max: f.numberMax }) : null,
    t('decimals', { n: f.numberDecimals ?? 0 }),
  ];
  return parts.filter(Boolean).join(' · ');
};

/** The text of a stored value for a record page. */
export function customValueText(f: CustomFieldView, locale: string, t: T): string | null {
  const v = f.value;
  if (!v) return null;
  switch (v.type) {
    case 'short_text': case 'long_text': return v.text;
    case 'number': return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(Number(v.number));
    case 'date': return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${v.date}T00:00:00Z`));
    case 'year_month': return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${v.date}T00:00:00Z`));
    case 'yes_no': return v.bool ? t('yes') : t('no');
    default: return v.optionIds.map((id) => f.options.find((o) => o.id === id)).filter((o) => !!o).map((o) => labelFor(o!.labels, locale)).join(', ');
  }
}

/** Read-only custom values (hiring managers, interviewers, a job team member), after the fixed fields. */
export async function CustomFieldValues({ fields, locale }: { fields: CustomFieldView[]; locale: string }) {
  if (!fields.length) return null;
  const t = await getTranslations('recruitment.custom');
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('section')}</h3>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => (
          <div key={f.id} className={f.type === 'long_text' ? 'sm:col-span-2 lg:col-span-3' : undefined}>
            <dt className="text-xs text-muted-foreground">{labelFor(f.labels, locale)}{f.restricted && <span className="ml-1"><Pill tone="warn">{t('restricted')}</Pill></span>}</dt>
            <dd className="whitespace-pre-wrap">{customValueText(f, locale, t) || '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** "Custom field" filter: one select of field · answer pairs, grouped by field (one filter at a time). Hidden when there is none. */
export async function CustomFilterSelect({ choices, value, locale, className }: { choices: CustomFilterChoice[]; value: string | null; locale: string; className?: string }) {
  if (!choices.length) return null;
  const t = await getTranslations('recruitment.custom');
  return (
    <Field label={t('filterLabel')} className={className ?? 'min-w-48'}>
      <select name="cf" defaultValue={value ?? ''} className={selectCls}>
        <option value="">{t('anyAnswer')}</option>
        {choices.map((c) => (
          <optgroup key={c.fieldId} label={labelFor(c.labels, locale)}>
            {c.answers.map((a) => <option key={a.key} value={a.key}>{a.labels ? labelFor(a.labels, locale) : a.bool ? t('yes') : t('no')}</option>)}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}
