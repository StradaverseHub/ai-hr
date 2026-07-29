'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { btnPrimary, btnGhost, inputCls } from './ui';
import { CurrencySelect } from './currency-select';

type Action = (fd: FormData) => void | Promise<void>;

/**
 * Client wrapper for the companies-card header: renders the section title + count on the left and a
 * prominent top-right "+ Add new company" primary button. The button toggles a collapsible create form
 * (the existing quick-create form, unchanged — it still posts to `createCompanyAction`). Presentation only;
 * the server action is passed straight through as a prop so no action wiring changes.
 */
export function CompaniesCardHeader({
  title,
  count,
  createAction,
  cycleOptions,
}: {
  title: string;
  count: number;
  createAction: Action;
  // Organization Module (361e3b15): the standard payroll cycle NAMES the new Default Payroll Cycle picker
  // lists (passed from the server so this client component pulls no DB-backed module). Pre-set to 'Monthly'.
  cycleOptions: string[];
}) {
  const t = useTranslations('admin.organization');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="text-sm font-medium">
          {title}
          <span className="ml-2 text-muted-foreground">({count})</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={btnPrimary}
          data-tour="people-org-add"
        >
          <span aria-hidden className="text-base leading-none">
            +
          </span>
          {t('addNewCompany')}
        </button>
      </div>
      {open && (
        <form
          action={createAction}
          className="grid grid-cols-1 gap-3 border-b border-border bg-muted/20 p-4 sm:grid-cols-4"
        >
          <input
            name="legalName"
            required
            placeholder={t('legalName')}
            className={`${inputCls} sm:col-span-2`}
          />
          <input
            name="country"
            defaultValue="MY"
            placeholder={t('country')}
            pattern="[A-Za-z]{2}"
            maxLength={2}
            title={t('countryHint')}
            className={`${inputCls} uppercase`}
          />
          {/* r79a (4fb8b75a step 3) — company.currency became the Basic Salary form's default currency, and
              createCompany now rejects anything outside the ISO 4217 master. The picker replaces the
              free-text box so the form cannot post a code the service will refuse. */}
          <label className="flex flex-col gap-1" title={t('currencyHint')}>
            <span className="text-xs font-medium text-muted-foreground">{t('currency')}</span>
            <CurrencySelect name="currency" value="MYR" />
          </label>
          {/* Organization Module (361e3b15): Default Payroll Cycle, pre-set to Monthly so most admins just
              accept it. The company comes payroll-ready with the standard cycles seeded on create. */}
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">{t('defaultPayrollCycle')}</span>
            <select name="defaultPayrollCycle" defaultValue="Monthly" title={t('defaultPayrollCycleHint')} className={inputCls}>
              {cycleOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2 sm:col-span-4">
            <button className={btnPrimary}>{t('addCompany')}</button>
            <button type="button" onClick={() => setOpen(false)} className={btnGhost}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
