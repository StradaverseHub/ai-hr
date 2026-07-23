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
 * as props (the established RSC→client pattern). The Card shell stays a Server Component. `isMalaysianNationality`
 * is imported from the leaf `@/localization/my/ic-dob` (zero db deps) so this client bundle stays db-free.
 */

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { IcDobAutofill } from '@/components/ic-dob-autofill';
import { Field, btnPrimary, inputCls } from '@/components/ui';
import { isMalaysianNationality } from '@/localization/my/ic-dob';

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
 * The Nationality picker (searchable Combobox) — same hidden `nationality` input the surrounding
 * setPersonAction form already posts, PLUS it pushes the live value into context so the identity block reacts.
 */
export function NationalityField({
  name,
  value,
  options,
  placeholder,
  searchPlaceholder,
  noResultsLabel,
  legacySuffix,
}: {
  name: string;
  value: string | null | undefined;
  options: ComboboxOption[];
  placeholder: string;
  searchPlaceholder: string;
  noResultsLabel: string;
  legacySuffix: string;
}) {
  const { setNationality } = useIdentity();
  return (
    <Combobox
      name={name}
      value={value}
      options={options}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      noResultsLabel={noResultsLabel}
      legacySuffix={legacySuffix}
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
          posts nothing, so a non-Malaysian's stored ic_number stays untouched. IcDobAutofill derives DOB from
          a valid MyKad and fills the empty DOB input (id=profile-dob-input) in the sibling compliance form;
          the server mirrors this on save. Mandatory whenever shown (Malaysians must have an NRIC). */}
      {isMY && (
        <form action={setIcAction} className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4">
          <input type="hidden" name="employmentId" value={employmentId} />
          <input type="hidden" name="personId" value={personId} />
          <p className="sm:col-span-4 text-sm font-medium text-foreground">{t('identityNricTitle')}</p>
          <Field label={t('icNumber')}>
            <IcDobAutofill
              name="icNumber"
              required
              defaultValue={icDefault}
              placeholder="900101011234"
              className={inputCls}
              dobInputId="profile-dob-input"
              invalidDateNote={t('icDobInvalidDate')}
            />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-3 sm:self-center">{t('icNumberHint')}</p>
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
