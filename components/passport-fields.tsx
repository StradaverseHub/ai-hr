'use client';

/**
 * THE PASSPORT BLOCK — number, issue date, expiry date, issuing country, country code and remark —
 * shared between the Personnel Profile tab's Identity Information card and the Create New Employee
 * draft (item a72610af).
 *
 * IT WAS EXPLICITLY NOT SHARED BEFORE, and the note that said so (components/personnel-identity.tsx)
 * was right about the reason and is answered rather than ignored. It read: sharing it "is not a field-
 * definition question, it is a write-path one. `setPassportProfileMY` makes the number/issue/expiry trio
 * MANDATORY for a non-Malaysian, so a wizard that offered these boxes would refuse to create a hire whose
 * passport HR does not have to hand — stricter than `hireEmployee` and the bulk importer."
 *
 * WHAT CHANGED IS THE WRITE PATH, NOT THE FIELDS. `completeEmployeeDraft` calls `setPassport` ONLY when
 * the draft carries at least one passport value — exactly what `commitEmployeeImport` has done since item
 * 2983802f — so a draft that names no passport never reaches that writer and never meets its mandatory
 * trio. The all-or-nothing rule that remains is judged on the TAB (`missingByTab`, profile → 'passport'),
 * before anything is created, because that writer can only run after `hireEmployee` has committed and a
 * refusal there would fail an activation that had already made an employee. So the wizard is no stricter
 * than the importer, and the statutory decision the old note was waiting on is not needed: nothing here
 * makes a passport mandatory for anybody.
 *
 *   mode: 'form'        → `name`d inputs read out of FormData by `setPassportAction`. `required` is
 *                         driven by `requiredTrio`, which the Personnel card derives from the LIVE
 *                         nationality selection; the server re-derives it from the person record and
 *                         never trusts this.
 *   mode: 'controlled'  → value/onChange bound to the draft's React state, NO `name`, and NO `required`:
 *                         a draft refuses nothing until Activate, and `missingByTab` is what names an
 *                         incomplete block.
 *
 * LABELS FROM `people.detail.passport*` — the Personnel card's own keys, so the two screens cannot drift
 * and this change adds no message key.
 */
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Field, inputCls } from '@/components/ui';
import { DateField } from '@/components/ui/date-field';
import { COUNTRY_CODE_OPTIONS } from '@/lib/countries';

export type PassportValue = {
  passportNumber?: string | null;
  passportIssueDate?: string | null;
  passportExpiryDate?: string | null;
  passportIssuingCountry?: string | null;
  passportIssuingCountryCode?: string | null;
  passportRemark?: string | null;
};

/**
 * What a controlled caller RECEIVES on a change — narrower than `PassportValue` on purpose: reading
 * tolerates `null` (a database column holds one), but a control can only emit a string and the draft blob
 * stores strings.
 */
export type PassportPatch = { [K in keyof PassportValue]?: string };

/** The three fields `setPassportProfileMY` requires TOGETHER once any passport detail is entered. */
export const PASSPORT_TRIO = ['passportNumber', 'passportIssueDate', 'passportExpiryDate'] as const;

type Common = {
  value: PassportValue;
  /** The international country list for the Issuing Country picker, resolved by the caller. */
  countryOptions: ComboboxOption[];
  /** Extra classes on the remark TEXTAREA, so each screen's own grid decides its span. Applied to the
   *  textarea rather than to the Field, which is where the Personnel card has always put it. */
  remarkClassName?: string;
};

/** The block's own heading, in the Personnel card's words — so a screen that needs the title can have it
 *  without opening a second translation namespace of its own. */
export function PassportSectionTitle({ className }: { className?: string }) {
  const t = useTranslations('people.detail');
  return <p className={className ?? 'text-sm font-medium text-foreground'}>{t('passportInfoTitle')}</p>;
}

export function PassportFields(
  props:
    | (Common & {
        mode: 'form';
        /** Personnel only: a non-Malaysian's passport is their primary identification, so the trio is
         *  marked required. Advisory — the server re-derives it from `person.nationality`. */
        requiredTrio: boolean;
        /** r422 — OPT-IN: draw the two dates as DD-MMM-YYYY (components/ui/date-field.tsx), posting the same
         *  names and ISO values. The Personnel profile passes it; the Create New Employee draft (controlled
         *  mode) does not. */
        dmyDisplay?: boolean;
      })
    | (Common & { mode: 'controlled'; onChange: (patch: PassportPatch) => void }),
) {
  const t = useTranslations('people.detail');
  const v = props.value;
  const req = props.mode === 'form' && props.requiredTrio;

  /** One text or date box, in whichever of the two shapes this screen needs. */
  const box = (key: keyof PassportValue, extra: Record<string, unknown> = {}) => (
    <input
      className={inputCls}
      {...extra}
      {...(props.mode === 'form'
        ? { name: key, defaultValue: v[key] ?? '' }
        : { value: v[key] ?? '', onChange: (e) => props.onChange({ [key]: e.target.value }) })}
    />
  );

  /** A date box: the r422 DD-MMM-YYYY field where the caller opted in, else the native one as before. */
  const dateBox = (key: 'passportIssueDate' | 'passportExpiryDate', label: string) =>
    props.mode === 'form' && props.dmyDisplay ? (
      <DateField name={key} defaultValue={v[key] ?? ''} required={req} className={inputCls} label={label} />
    ) : (
      box(key, { type: 'date', required: req })
    );

  /** One catalog picker. The Combobox already speaks both dialects (a hidden `name`d input, or
   *  `onValueChange`), which is why the nationality picker could share it first. */
  const picker = (key: 'passportIssuingCountry' | 'passportIssuingCountryCode', options: ComboboxOption[]) => (
    <Combobox
      {...(props.mode === 'form'
        ? { name: key }
        : { onValueChange: (value: string) => props.onChange({ [key]: value }) })}
      value={v[key]}
      options={options}
      placeholder={t('optionNotSet')}
      searchPlaceholder={t('passportIssuingCountrySearchPlaceholder')}
      noResultsLabel={t('passportIssuingCountryNoResults')}
      legacySuffix={t('optionLegacySuffix')}
    />
  );

  return (
    <>
      <Field label={t('passportNumber')}>
        {box('passportNumber', { required: req, placeholder: t('passportNumberPlaceholder') })}
      </Field>
      <Field label={t('passportIssueDate')}>{dateBox('passportIssueDate', t('passportIssueDate'))}</Field>
      <Field label={t('passportExpiryDate')}>{dateBox('passportExpiryDate', t('passportExpiryDate'))}</Field>
      <Field label={t('passportIssuingCountry')}>{picker('passportIssuingCountry', props.countryOptions)}</Field>
      {/* e4b541c6 — the ISO alpha-2 the CP39's `Kod Negara` column wants. A SEPARATE field from the
          issuing country above, which is fed from the tenant's nationality list and therefore holds a
          demonym: "Malaysian" is not "MY", and deriving one from the other would print an invented code
          on a tax document. HR picks it. */}
      <Field label={t('passportIssuingCountryCode')}>
        {picker('passportIssuingCountryCode', COUNTRY_CODE_OPTIONS)}
      </Field>
      <Field label={t('passportRemark')}>
        {props.mode === 'form' ? (
          <textarea
            name="passportRemark"
            rows={2}
            defaultValue={v.passportRemark ?? ''}
            className={`${inputCls}${props.remarkClassName ? ` ${props.remarkClassName}` : ''}`}
          />
        ) : (
          <textarea
            rows={2}
            value={v.passportRemark ?? ''}
            onChange={(e) => props.onChange({ passportRemark: e.target.value })}
            className={`${inputCls}${props.remarkClassName ? ` ${props.remarkClassName}` : ''}`}
          />
        )}
      </Field>
    </>
  );
}
