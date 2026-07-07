'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { btnPrimary, btnGhost, inputCls } from './ui';

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
}: {
  title: string;
  count: number;
  createAction: Action;
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
          <input
            name="currency"
            defaultValue="MYR"
            placeholder={t('currency')}
            pattern="[A-Za-z]{3}"
            maxLength={3}
            title={t('currencyHint')}
            className={`${inputCls} uppercase`}
          />
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
