'use client';

/**
 * Item e3ce0d4d — Nationality-conditional identification (Personnel → Profile → Personal Details).
 *
 * A Malaysian employee is identified by their MyKad IC; a non-Malaysian by their Passport. The IC field and
 * the passport fields live in the SAME Card but different <form>s than the Nationality picker (which posts via
 * setPersonAction). This 'use client' island lifts the live nationality selection into a small context so the
 * identity block can flip IC ⇄ passport the moment the nationality changes — no page reload — matching the
 * request's "automatic field switching".
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
 * The nationality-conditional identity block. Malaysian → the IC form (IcDobAutofill, IC mandatory, DOB
 * autofill preserved). Non-Malaysian → the passport form (number/issue/expiry mandatory, remark optional; NO
 * MyKad validation). Only the relevant card is shown, so the required attributes only apply to the visible form.
 * The two server actions are received as props from the RSC page.
 */
export function IdentityFields({
  employmentId,
  personId,
  icDefault,
  passportNumber,
  passportIssueDate,
  passportExpiryDate,
  passportRemark,
  setIcAction,
  setPassportAction,
}: {
  employmentId: string;
  personId: string;
  icDefault: string;
  passportNumber: string;
  passportIssueDate: string;
  passportExpiryDate: string;
  passportRemark: string;
  setIcAction: (formData: FormData) => void | Promise<void>;
  setPassportAction: (formData: FormData) => void | Promise<void>;
}) {
  const t = useTranslations('people.detail');
  const { nationality } = useIdentity();
  const isMY = isMalaysianNationality(nationality);

  if (isMY) {
    return (
      <form action={setIcAction} className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4">
        <input type="hidden" name="employmentId" value={employmentId} />
        <input type="hidden" name="personId" value={personId} />
        <Field label={t('icNumber')}>
          {/* IcDobAutofill derives DOB from a valid MyKad and fills the empty DOB input (id=profile-dob-input)
              in the sibling compliance form; the server mirrors this on save. IC mandatory for Malaysians. */}
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
    );
  }

  return (
    <form action={setPassportAction} className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4">
      <input type="hidden" name="employmentId" value={employmentId} />
      <input type="hidden" name="personId" value={personId} />
      <Field label={t('passportNumber')}>
        <input name="passportNumber" required defaultValue={passportNumber} placeholder={t('passportNumberPlaceholder')} className={inputCls} />
      </Field>
      <Field label={t('passportIssueDate')}>
        <input name="passportIssueDate" type="date" required defaultValue={passportIssueDate} className={inputCls} />
      </Field>
      <Field label={t('passportExpiryDate')}>
        <input name="passportExpiryDate" type="date" required defaultValue={passportExpiryDate} className={inputCls} />
      </Field>
      <Field label={t('passportRemark')}>
        <textarea name="passportRemark" rows={2} defaultValue={passportRemark} className={`${inputCls} sm:col-span-4`} />
      </Field>
      <p className="text-xs text-muted-foreground sm:col-span-4">{t('passportHint')}</p>
      <div className="sm:col-span-4 flex justify-end">
        <button className={btnPrimary}>{t('savePassport')}</button>
      </div>
    </form>
  );
}
