'use client';

/**
 * Item e3ce0d4d / 55865c32 / 357faecf — Identity Information (Personnel → Profile → Personal Details).
 *
 * Item 357faecf re-gates the Identity No (NRIC) card on nationality: it renders ONLY while the selected
 * nationality is Malaysian, and hides instantly (no reload) when the nationality changes. Passport
 * Information keeps item 55865c32's behaviour — visible for EVERY employee (issuing country included), with
 * nationality driving only its required flags: a Malaysian's passport is optional, a non-Malaysian's trio is
 * mandatory. This 'use client' island lifts the live nationality selection into a small context so the
 * identity block reacts the moment the nationality changes — no page reload (the server re-derives
 * requiredness from the person record on save; the client's live selection is never trusted). A hidden NRIC
 * card posts nothing, so a non-Malaysian's stored ic_number row is never touched — the data stays and the
 * field reappears if the nationality is ever corrected to Malaysian.
 *
 * Boundary: the RSC page (page.tsx) RENDERS these components as JSX (allowed) and passes the server actions in
 * as props (the established RSC→client pattern). The Card shell stays a Server Component. The nationality
 * predicate arrives via the CLIENT-SAFE pack registry (ADR-0080 rung 5b, D4) — each pack's
 * `identity.isLocalNationality` is a pure leaf function (MY: localization/my/ic-dob, zero db deps) — so this
 * client bundle stays db-free.
 *
 * 35b7af0a GROUP 8 — the Nationality picker and the Identity No (NRIC) field themselves now come from
 * components/identity-fields.tsx, the shared group the Create New Employee wizard renders too. Only the
 * PERSONNEL-SPECIFIC parts stayed here: the context that makes the fork live without a reload, the two
 * `<form>` shells with their server actions and Save buttons, and the passport block.
 *
 * WHY THE PASSPORT BLOCK IS NOT SHARED WITH THE WIZARD. It is not a field-definition question, it is a
 * write-path one. `setPassportProfileMY` makes the number/issue/expiry trio MANDATORY for a non-Malaysian,
 * so a wizard that offered these boxes would refuse to create a hire whose passport HR does not have to
 * hand — stricter than `hireEmployee` and the bulk importer, which lib/employee-draft-schema.ts's header
 * names as precisely how the three ways of creating an employee drift apart. Sharing it needs that rule
 * decided first, and that is a statutory decision rather than a refactor.
 */

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Field, btnPrimary, inputCls } from '@/components/ui';
import {
  IdentityNumberField,
  NationalityPicker,
  // Named locally for what it means on THIS screen. One definition, in the shared group — the wizard
  // applies the identical gate, which is the whole point of group 8.
  isLocalNationality as isMalaysianNationality,
} from '@/components/identity-fields';

type IdentityCtx = { nationality: string; setNationality: (v: string) => void };
const Ctx = createContext<IdentityCtx | null>(null);

function useIdentity(): IdentityCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('IdentityProvider is missing');
  return ctx;
}

/**
 * Wraps the Personal Details Card. Holds the live nationality selection so the Nationality picker and the
 * identity block (separate <form>s) stay in sync. `children` is the RSC subtree — passed straight through.
 */
export function IdentityProvider({
  initialNationality,
  children,
}: {
  initialNationality: string | null | undefined;
  children: ReactNode;
}) {
  const [nationality, setNationality] = useState(initialNationality ?? '');
  return <Ctx.Provider value={{ nationality, setNationality }}>{children}</Ctx.Provider>;
}

/**
 * The Nationality picker, as the Personnel screen needs it: the shared group-8 control (labels, catalog
 * tolerance and all), wired to post the same hidden `nationality` input setPersonAction already read AND
 * to push the live value into context so the identity block reacts without a reload.
 *
 * This wrapper exists because the context bridge cannot live in the shared file and cannot live on the RSC
 * page either — a server component may not hand a function across the boundary (the r123 fault).
 */
export function NationalityField({
  name,
  value,
  options,
}: {
  name: string;
  value: string | null | undefined;
  options: ComboboxOption[];
}) {
  const { setNationality } = useIdentity();
  return (
    <NationalityPicker
      mode="form"
      name={name}
      value={value}
      options={options}
      onValueChange={setNationality}
    />
  );
}

/**
 * The Identity Information block (items 55865c32 + 357faecf): the Identity No (NRIC) card renders ONLY for a
 * Malaysian nationality (live from IdentityProvider — hiding/showing instantly on change, no reload), while
 * Passport Information renders for EVERY employee. Nationality still drives the passport required flags:
 * Malaysian → NRIC mandatory (when shown), passport optional (all-or-nothing, enforced server-side);
 * non-Malaysian → passport trio mandatory, NRIC hidden (stored ic_number rows untouched). The two server
 * actions are received as props from the RSC page.
 */
export function IdentityFields({
  employmentId,
  personId,
  icDefault,
  passportNumber,
  passportIssueDate,
  passportExpiryDate,
  passportIssuingCountry,
  passportRemark,
  countryOptions,
  setIcAction,
  setPassportAction,
}: {
  employmentId: string;
  personId: string;
  icDefault: string;
  passportNumber: string;
  passportIssueDate: string;
  passportExpiryDate: string;
  passportIssuingCountry: string;
  passportRemark: string;
  /** Item 55865c32 — the international country list for the passport's Issuing Country picker (the same
   *  catalog source the Nationality Combobox reads, passed down by the RSC page). */
  countryOptions: ComboboxOption[];
  setIcAction: (formData: FormData) => void | Promise<void>;
  setPassportAction: (formData: FormData) => void | Promise<void>;
}) {
  const t = useTranslations('people.detail');
  const { nationality } = useIdentity();
  const isMY = isMalaysianNationality(nationality);

  return (
    <>
      {/* Identity No (NRIC) — item 357faecf: rendered ONLY while the nationality is Malaysian; a hidden card
          posts nothing, so a non-Malaysian's stored ic_number stays untouched. 35b7af0a group 8 — the field
          itself is now the SHARED group (components/identity-fields.tsx), which applies the same gate; the
          fork stays here because hiding the field without hiding this form would leave a card with nothing
          in it but a Save button. `mode="form"` keeps the input exactly what it was: an uncontrolled
          name/defaultValue box inside this server-action form, with IcDobAutofill still deriving the DOB
          from a valid MyKad into the sibling compliance form's input (id=profile-dob-input). */}
      {isMY && (
        <form action={setIcAction} className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4">
          <input type="hidden" name="employmentId" value={employmentId} />
          <input type="hidden" name="personId" value={personId} />
          <p className="sm:col-span-4 text-sm font-medium text-foreground">{t('identityNricTitle')}</p>
          <IdentityNumberField
            mode="form"
            nationality={nationality}
            icNumber={icDefault}
            dobInputId="profile-dob-input"
            hintClassName="sm:col-span-3 sm:self-center"
          />
          <div className="sm:col-span-4 flex justify-end">
            <button className={btnPrimary}>{t('saveIc')}</button>
          </div>
        </form>
      )}

      {/* Passport Information — shown for EVERY employee. The number/issue/expiry required attrs apply
          only for non-Malaysians; the server re-derives requiredness from the person record (a Malaysian's
          passport is optional but all-or-nothing). Issuing country + remark are always optional. */}
      <form action={setPassportAction} className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4">
        <input type="hidden" name="employmentId" value={employmentId} />
        <input type="hidden" name="personId" value={personId} />
        <p className="sm:col-span-4 text-sm font-medium text-foreground">{t('passportInfoTitle')}</p>
        <Field label={t('passportNumber')}>
          <input name="passportNumber" required={!isMY} defaultValue={passportNumber} placeholder={t('passportNumberPlaceholder')} className={inputCls} />
        </Field>
        <Field label={t('passportIssueDate')}>
          <input name="passportIssueDate" type="date" required={!isMY} defaultValue={passportIssueDate} className={inputCls} />
        </Field>
        <Field label={t('passportExpiryDate')}>
          <input name="passportExpiryDate" type="date" required={!isMY} defaultValue={passportExpiryDate} className={inputCls} />
        </Field>
        <Field label={t('passportIssuingCountry')}>
          <Combobox
            name="passportIssuingCountry"
            value={passportIssuingCountry}
            options={countryOptions}
            placeholder={t('optionNotSet')}
            searchPlaceholder={t('passportIssuingCountrySearchPlaceholder')}
            noResultsLabel={t('passportIssuingCountryNoResults')}
            legacySuffix={t('optionLegacySuffix')}
          />
        </Field>
        <Field label={t('passportRemark')}>
          <textarea name="passportRemark" rows={2} defaultValue={passportRemark} className={`${inputCls} sm:col-span-4`} />
        </Field>
        <p className="text-xs text-muted-foreground sm:col-span-4">{t('passportHint')}</p>
        <div className="sm:col-span-4 flex justify-end">
          <button className={btnPrimary}>{t('savePassport')}</button>
        </div>
      </form>
    </>
  );
}
