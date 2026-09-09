'use client';

/**
 * Employee bank details — Bank + Bank Account Number. The FIFTH shared field group of item 35b7af0a
 * (Create New Employee wizard ↔ Personnel (Admin) Bank & Statutory tab). Same shape as groups 1–4: one
 * definition, a discriminated `mode`, both screens render it.
 *
 * THIS ONE IS NOT COSMETIC. The Personnel card has been a PICK-FROM-CATALOG select since item ef720d3a —
 * the BNM bank catalog the bank-file builders already use, so a chosen value normalises cleanly and its BNM
 * code stays derivable (`tryBnmCodeForBankName`). The wizard kept a FREE-TEXT box. So a hire could be
 * created with "may bank" or "MBB Bhd" typed by hand, which reads perfectly to a human, is invisible on the
 * Personnel screen (the card preserves an unrecognised value rather than dropping it), and only surfaces
 * when the first salary payment file is built for that employee. Both screens now offer the same catalog.
 *
 * A NON-CATALOG VALUE IS STILL PRESERVED, exactly as the Personnel card already did: an existing or drafted
 * bank name that is not in the catalog is prepended as its own option rather than silently replaced. Two
 * reasons — a stored value must never be lost by a screen that merely renders it, and a wizard draft saved
 * before this change may hold hand-typed text that HR should be able to see and correct rather than have
 * quietly rewritten.
 *
 *   mode: 'form'        → `name` + `defaultValue`, read out of FormData by setBankAction. NO function prop
 *                         (the r123 RSC-boundary fault), so the card stays renderable from a server page.
 *   mode: 'controlled'  → `value` + `onChange`, bound to the wizard's draft state.
 *
 * LABELS ARE READ WHERE THEY LIVE — `people.detail.bank` / `.bankSelectPlaceholder` / `.bankAccount`. The
 * wizard's `fields.bankName` and `fields.bankAccountNo` are retired. `fields.bankAccount` is DELIBERATELY
 * KEPT: `missingByTab` returns that field name when exactly one of the two is filled (half a bank
 * instruction cannot pay anybody) and the Review step renders it through a COMPUTED t(`fields.${f}`) the
 * i18n static check cannot see — the same reason `fields.rateAmount` was kept in group 2.
 *
 * ONE NAMESPACE PER FILE and every key a literal: test/i18n-coverage.test.ts check C skips multi-namespace
 * files and cannot see a computed key.
 */

import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';
import { clientCountryPacks } from '@/localization/registry.client';

/** Canonical bank names for the picker (item ef720d3a), served by the CLIENT-SAFE pack registry
 *  (ADR-0080 rung 5b, D4): each pack's `bankNames` is its jurisdiction's payment-directory projection
 *  (MY: the BNM catalog the bank-file builders already use). Union across packs in catalog order. */
const BANK_NAMES = clientCountryPacks().flatMap((p) => p.bankNames);

type Mode =
  | { mode: 'form' }
  | { mode: 'controlled'; onChange: (patch: { bankName?: string; bankAccountNo?: string }) => void };

export type BankAccountFieldsProps = Mode & {
  bankName: string | null | undefined;
  bankAccountNo: string | null | undefined;
  /** Optional guidance under the account number (the wizard states the all-or-nothing rule there). */
  hint?: string;
  /** Optional extra classes on each Field wrapper, so a caller's grid decides the layout, not this file. */
  fieldClassName?: string;
};

export function BankAccountFields(props: BankAccountFieldsProps) {
  const t = useTranslations('people.detail');
  const current = props.bankName?.trim() || '';
  const accountNo = props.bankAccountNo ?? '';
  // Preserve a legacy / hand-typed bank name so an existing value isn't silently dropped from the picker.
  const options = current && !BANK_NAMES.includes(current) ? [current, ...BANK_NAMES] : BANK_NAMES;

  return (
    <>
      <Field label={t('bank')} className={props.fieldClassName}>
        <select
          className={inputCls}
          {...(props.mode === 'form'
            ? { name: 'bankName', defaultValue: current }
            : {
                value: current,
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                  props.onChange({ bankName: e.target.value }),
              })}
        >
          <option value="">{t('bankSelectPlaceholder')}</option>
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('bankAccount')} className={props.fieldClassName}>
        <input
          className={inputCls}
          {...(props.mode === 'form'
            ? { name: 'bankAccountNo', defaultValue: accountNo }
            : {
                value: accountNo,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                  props.onChange({ bankAccountNo: e.target.value }),
              })}
        />
        {props.hint && <p className="mt-1 text-xs text-muted-foreground">{props.hint}</p>}
      </Field>
    </>
  );
}
