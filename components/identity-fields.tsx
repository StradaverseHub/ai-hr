'use client';

/**
 * Identity — Nationality plus the Identity No (NRIC) it gates. The EIGHTH shared field group of item
 * 35b7af0a (Create New Employee wizard ↔ Personnel (Admin) → Profile → Personal Details). Same shape as
 * groups 1–7: one definition, a discriminated `mode`, both screens render it.
 *
 * ## THE WIZARD NEVER ASKED FOR A NATIONALITY, AND THAT IS NOT A COSMETIC GAP
 *
 * Item 357faecf gates the Identity No (NRIC) card on nationality — shown only for a LOCAL nationality,
 * because a passport holder has no NRIC. The wizard offered a bare "Identity No" box and never asked the
 * question, so every employee it created arrived with `person.nationality` NULL. `isLocalNationality(null)`
 * is false. The consequence is the opposite of tidiness: the moment HR opened that new hire on the
 * Personnel screen the NRIC card was HIDDEN, so the identity number the wizard had just collected could
 * not be seen or corrected there until somebody first set a nationality and saved the Personal Details
 * card. The wizard was writing into a field its own product then refused to show.
 *
 * It also blocked group 7. The shared SOCSO/EIS group defaults a blank number to a local employee's IC
 * (PERKESO registers locals under their MyKad) and `defaultSocsoEisNumber` keys on NATIONALITY — so the
 * wizard call site had to pass `nationality={undefined}` and the default could never fire there. It fires
 * now, and `completeEmployeeDraft` applies the same default server-side exactly as `setStatutoryAction`
 * does, so both doors STORE the same number instead of one of them merely displaying it.
 *
 * ## WHAT EACH SCREEN STILL OWNS
 *
 * The gate — "is this a local nationality" — has ONE definition here (`isLocalNationality`) and arrives via
 * the CLIENT-SAFE pack registry (ADR-0080 rung 5b, D4), never a hardcoded jurisdiction: each pack's
 * `identity.isLocalNationality` is a pure leaf function (MY: localization/my/ic-dob, zero db deps), so this
 * client bundle stays db-free. `IdentityNumberField` applies that gate ITSELF, so neither screen can drift
 * from it. What this file cannot own is the CONTAINER: on Personnel the NRIC field sits inside its own
 * `<form action={setIcAction}>` with its own Save button, and hiding the field without hiding the form
 * would leave a card holding nothing but a button — so personnel-identity.tsx keeps its `{isMY && …}` fork
 * around the form, driven by this same predicate rather than by a second copy of the rule.
 *
 * PASSPORT INFORMATION IS DELIBERATELY NOT IN THIS GROUP — see personnel-identity.tsx's header for why the
 * wizard does not collect it.
 *
 *   mode: 'form'        → `name`d inputs read out of FormData by setPersonAction / setIcAction.
 *   mode: 'controlled'  → value/onChange bound to the wizard's draft state, and NO `name` at all.
 *
 * LABELS ARE READ WHERE THEY LIVE — `people.detail.*`, the Personnel card's own keys. The wizard's
 * `fields.icNumber` and `hints.icNumber` are retired with this change. Checked first, per the trap that
 * nearly cost three keys in r159: `missingByTab` never returns 'icNumber' — the IC is optional by design
 * (item e3ce0d4d made the column nullable so a passport holder can be employed) — so the Review step's
 * computed t(`fields.${f}`) cannot ask for either of them.
 *
 * ONE NAMESPACE PER FILE and every key a literal: test/i18n-coverage.test.ts check C skips multi-namespace
 * files and cannot see a computed key.
 */

import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { IcDobAutofill } from '@/components/ic-dob-autofill';
import { Field, inputCls } from '@/components/ui';
import { clientCountryPacks } from '@/localization/registry.client';

/**
 * Does this nationality belong to a registered country pack's own jurisdiction? Union across packs (rung
 * 5b — MY-only today, so the truth table is identical to a direct `isMalaysianNationality` import); the
 * per-company narrowing is the second-country rung's decision. THE ONE DEFINITION of the NRIC-vs-passport
 * gate: both screens call this, neither restates it.
 */
export const isLocalNationality = (nationality?: string | null): boolean =>
  clientCountryPacks().some((p) => p.identity.isLocalNationality(nationality));

/** The MyKad shape shown as placeholder text on both screens — 12 digits, no dashes. */
const IC_PLACEHOLDER = '900101011234';

/**
 * The Nationality picker: a searchable Combobox over the tenant's nationality catalog (item 59047802 —
 * the list is ≈197 ISO 3166-1 demonyms, which a native <select> cannot make findable).
 *
 * `options` stays a PROP rather than being read here: the catalog is tenant data from
 * `listAllProfileOptions`, so it can only come from a server component. Both screens pass the same
 * catalog, and the Combobox's own legacy-value tolerance keeps an off-catalog stored value selected so a
 * save can never blank it.
 */
export function NationalityPicker(
  props: {
    value: string | null | undefined;
    options: ComboboxOption[];
    /** Optional extra classes on the Field wrapper, so a caller's grid decides the layout, not this file. */
    fieldClassName?: string;
  } & (
    | {
        mode: 'form';
        name: string;
        /** Lets a client parent react to the pick before any submit (the Personnel identity context). */
        onValueChange?: (value: string) => void;
      }
    | { mode: 'controlled'; onChange: (value: string) => void }
  ),
) {
  const t = useTranslations('people.detail');
  return (
    <Field label={t('nationality')} className={props.fieldClassName}>
      <Combobox
        // form mode posts a hidden input under `name`; controlled mode carries NO name at all, so a guard
        // grepping for name="nationality" can never conclude that the wizard's copy posts (the r159 lesson).
        {...(props.mode === 'form'
          ? { name: props.name, onValueChange: props.onValueChange }
          : { onValueChange: props.onChange })}
        value={props.value}
        options={props.options}
        placeholder={t('optionNotSet')}
        searchPlaceholder={t('nationalitySearchPlaceholder')}
        noResultsLabel={t('nationalityNoResults')}
        legacySuffix={t('optionLegacySuffix')}
      />
    </Field>
  );
}

/**
 * The Identity No (NRIC) field and its hint.
 *
 * RENDERS NOTHING for a non-local nationality — item 357faecf's rule, now applied identically on both
 * screens. Rendering nothing rather than disabling is what keeps a stored `ic_number` untouched: a field
 * that is not on screen posts nothing on Personnel, and on the wizard it simply never enters the draft.
 * The data stays and the field reappears if the nationality is ever corrected.
 *
 * MANDATORY ONLY IN `form` MODE. A Malaysian employee must have an NRIC, and the Personnel card has always
 * marked it required. The wizard deliberately does not: `missingByTab` never returns 'icNumber', because
 * making the wizard stricter than `hireEmployee` and the bulk importer is exactly how the three ways of
 * creating an employee drift apart (lib/employee-draft-schema.ts's header states the rule).
 */
export function IdentityNumberField(
  props: {
    /** The LIVE nationality selection — the gate. Both screens pass what they currently have on screen. */
    nationality?: string | null;
    fieldClassName?: string;
    /** Optional extra classes on the hint paragraph, so a caller's grid decides where it sits. */
    hintClassName?: string;
  } & (
    | {
        mode: 'form';
        icNumber: string;
        /** The DOM id of the sibling form's Date of Birth input — see IcDobAutofill (item 354a500d). */
        dobInputId: string;
      }
    | { mode: 'controlled'; icNumber?: string; onChange: (icNumber: string) => void }
  ),
) {
  const t = useTranslations('people.detail');
  if (!isLocalNationality(props.nationality)) return null;

  return (
    <>
      <Field label={t('icNumber')} className={props.fieldClassName}>
        {props.mode === 'form' ? (
          // IcDobAutofill derives the DOB from a valid MyKad and writes it into the DOB input of a
          // SEPARATE server-action form, found by DOM id — a coordination only the Personnel page needs.
          <IcDobAutofill
            name="icNumber"
            required
            defaultValue={props.icNumber}
            placeholder={IC_PLACEHOLDER}
            className={inputCls}
            dobInputId={props.dobInputId}
            invalidDateNote={t('icDobInvalidDate')}
          />
        ) : (
          // The wizard's Date of Birth is React state in this same tree and `completeEmployeeDraft`
          // derives a blank one from the IC server-side (`dobOnlyIfEmpty`), so there is no second form to
          // reach into — a plain controlled input is the whole of it here.
          <input
            value={props.icNumber ?? ''}
            onChange={(e) => props.onChange(e.target.value)}
            placeholder={IC_PLACEHOLDER}
            className={inputCls}
            aria-label={t('icNumber')}
          />
        )}
      </Field>
      <p className={`text-xs text-muted-foreground ${props.hintClassName ?? ''}`}>{t('icNumberHint')}</p>
    </>
  );
}
