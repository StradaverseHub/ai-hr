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

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { IcDobAutofill, deriveDobFromIcInput, nextAutofilledDob } from '@/components/ic-dob-autofill';
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
    | {
        mode: 'controlled';
        icNumber?: string;
        onChange: (icNumber: string) => void;
        /**
         * ITEM da7463b4 — THE DATE OF BIRTH, so the controlled copy of this field autofills it too.
         *
         * The reporter's complaint is that the DRAFT screen does not behave like the ACTIVATED one, and
         * IC → Date of Birth was the first example. It already worked on the record (item 354a500d) and
         * in the bulk importer (feedback b9fd8fd5) and NOT on the draft, where the comment three lines
         * below used to explain that the server would derive a blank one at Activate — true, and no help
         * at all to somebody looking at the screen, because the Age beside it read "Not Available" for
         * the entire time the record was a draft.
         *
         * OPTIONAL, so the pair is all-or-nothing rather than a second required prop on every caller:
         * without them this renders exactly as it did before.
         */
        dateOfBirth?: string;
        onDateOfBirthChange?: (dateOfBirth: string) => void;
      }
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
          // da7463b4 — the draft's Date of Birth is React state in THIS tree, so there is no second form
          // to reach into and no DOM write: the same shared decision (`deriveDobFromIcInput` +
          // `nextAutofilledDob`, components/ic-dob-autofill.tsx) is applied through the caller's setter.
          // `completeEmployeeDraft` still re-derives server-side at Activate, exactly as `setIcAction`
          // and `commitEmployeeImport` do — the screen is a preview of a rule the server owns.
          <ControlledIcNumberInput
            icNumber={props.icNumber}
            onChange={props.onChange}
            dateOfBirth={props.dateOfBirth}
            onDateOfBirthChange={props.onDateOfBirthChange}
          />
        )}
      </Field>
      <p className={`text-xs text-muted-foreground ${props.hintClassName ?? ''}`}>{t('icNumberHint')}</p>
    </>
  );
}


/**
 * THE CONTROLLED IC INPUT AND ITS DATE-OF-BIRTH AUTOFILL — item da7463b4.
 *
 * Its own component because it needs two hooks (the "unreal date" note, and the memory of what we last
 * derived) and `IdentityNumberField` returns null for a non-local nationality BEFORE it would reach
 * them. That early return is the rule item 357faecf made, so the hooks move rather than the gate.
 *
 * IT IS ALSO WHY REQUIREMENT (d) HOLDS WITHOUT A SECOND RULE: for a non-Malaysian nationality this
 * component is never rendered, so no IC is collected on the draft and nothing is derived from one.
 *
 * WHAT IT DOES NOT DO IS BLOCK. An IC whose first six digits are not a real date shows a note and leaves
 * the Date of Birth alone; it never prevents a keystroke and never prevents Save Draft. That is
 * feedback b9fd8fd5's rule for the importer ("derives nothing (null) and is skipped, not failed") applied
 * to the screen, and `saveEmployeeDraft` validates nothing, which is the whole of what a draft is.
 */
function ControlledIcNumberInput({
  icNumber,
  onChange,
  dateOfBirth,
  onDateOfBirthChange,
}: {
  icNumber?: string;
  onChange: (icNumber: string) => void;
  dateOfBirth?: string;
  onDateOfBirthChange?: (dateOfBirth: string) => void;
}) {
  // The labels are read HERE rather than passed in, so this file stays single-namespace and
  // test/i18n-coverage.test.ts check C keeps resolving every key in it (a file using two namespaces is
  // SKIPPED by that check, silently — which is how the wizard would have lost its whole coverage had the
  // note been handed down as a prop).
  const t = useTranslations('people.detail');
  const [showNote, setShowNote] = useState(false);
  // The last date WE derived — a ref, not state, because nothing re-renders when it changes. It is what
  // lets a CORRECTED IC number move the Date of Birth while a hand-typed one is never touched.
  const autofilledRef = useRef<string | null>(null);

  const apply = (raw: string) => {
    onChange(raw);
    if (!onDateOfBirthChange) return;
    const { status, dob } = deriveDobFromIcInput(raw);
    setShowNote(status === 'unreal');
    if (dob === null) return;
    const next = nextAutofilledDob(dateOfBirth ?? '', dob, autofilledRef.current);
    if (next !== null) {
      autofilledRef.current = next;
      onDateOfBirthChange(next);
    }
  };

  return (
    <>
      <input
        value={icNumber ?? ''}
        onChange={(e) => apply(e.target.value)}
        placeholder={IC_PLACEHOLDER}
        className={inputCls}
        aria-label={t('icNumber')}
      />
      {showNote ? <span className="text-xs text-destructive">{t('icDobInvalidDate')}</span> : null}
    </>
  );
}
