'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
// 35b7af0a group 5 — the Bank + Bank Account Number field group, shared with the Create New Employee
// wizard. The BNM catalog it renders moved with it (it was this file's module-level BANK_NAMES).
import { BankAccountFields } from '@/components/bank-account-fields';

// Inlined from components/ui (server module) so this stays a clean client island — same pattern as
// components/epf-election.tsx.
const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';
const btnPrimary =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export type BankInfoDefaults = {
  bankName: string | null;
  bankAccountNo: string | null;
  enableCustomHolderName: boolean;
  customHolderName: string | null;
  enableCustomHolderId: boolean;
  customHolderId: string | null;
};

/**
 * Bank Information card (item ef720d3a). Dedicated, visually-separated card with its OWN save (the server
 * action `action`, a partial update of only the bank + custom-holder columns — setBankAction). The bank name
 * is a pick-from-catalog select (no more free text); the two custom-payment-holder switches reveal their
 * value box only when on, and the value is required-when-enabled (client here + server in setBankProfileMY).
 * This is a client island so the reveal/require behaviour is interactive; the page renders it as JSX only,
 * so the RSC server/client boundary is respected.
 */
export function BankInfoCard({
  action,
  employmentId,
  personId,
  defaults,
}: {
  action: (formData: FormData) => void | Promise<void>;
  employmentId: string;
  personId: string;
  defaults: BankInfoDefaults;
}) {
  const t = useTranslations('people.detail');
  const [enableName, setEnableName] = useState(defaults.enableCustomHolderName);
  const [enableId, setEnableId] = useState(defaults.enableCustomHolderId);

  // The catalog, and the rule that preserves a legacy / non-catalog bank name so an existing value isn't
  // silently dropped from the picker, moved into BankAccountFields with the fields themselves (35b7af0a
  // group 5) — the wizard needs both and had neither.

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{t('bankCardTitle')}</h3>
      </div>
      <form action={action} className="flex flex-col gap-6 p-4">
        <input type="hidden" name="employmentId" value={employmentId} />
        <input type="hidden" name="personId" value={personId} />

        {/* Employee bank information */}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('bankGroupEmployee')}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* 35b7af0a group 5 — Bank and Bank Account Number are now ONE shared field group
                (components/bank-account-fields.tsx), rendered identically here and on the Create New
                Employee wizard. The wizard had a FREE-TEXT bank box against this card's catalog picker, so
                a hire could be created with hand-typed text that no BNM code can be derived from and that
                only surfaces when a payment file is built. `mode="form"` keeps these inputs exactly what
                they were: uncontrolled name/defaultValue inputs inside this setBankAction form. */}
            <BankAccountFields
              mode="form"
              bankName={defaults.bankName}
              bankAccountNo={defaults.bankAccountNo}
            />
          </div>
        </fieldset>

        {/* Custom payment holder — pay salary into a third party's account (spouse / authorised person). */}
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <legend className="-ml-1 rounded-md bg-card px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-foreground">
            {t('customHolderTitle')}
          </legend>
          <p className="text-xs text-muted-foreground">{t('customHolderHint')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="enableCustomHolderName"
                  checked={enableName}
                  onChange={(e) => setEnableName(e.target.checked)}
                  className="size-4 rounded"
                />
                {t('enableCustomHolderName')}
              </label>
              {enableName && (
                <Field label={t('customHolderName')}>
                  <input
                    name="customHolderName"
                    required
                    defaultValue={defaults.customHolderName ?? ''}
                    className={inputCls}
                  />
                </Field>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="enableCustomHolderId"
                  checked={enableId}
                  onChange={(e) => setEnableId(e.target.checked)}
                  className="size-4 rounded"
                />
                {t('enableCustomHolderId')}
              </label>
              {enableId && (
                <Field label={t('customHolderId')}>
                  <input
                    name="customHolderId"
                    required
                    defaultValue={defaults.customHolderId ?? ''}
                    className={inputCls}
                  />
                </Field>
              )}
            </div>
          </div>
        </fieldset>

        <div className="flex items-end justify-end">
          <button className={btnPrimary}>{t('bankSave')}</button>
        </div>
      </form>
    </div>
  );
}
