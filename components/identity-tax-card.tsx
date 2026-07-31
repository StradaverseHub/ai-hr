'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

// Inlined design tokens (server module) so this stays a clean client island — same pattern as bank-info-card.tsx.
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

export type IdentityTaxDefaults = {
  taxNumber: string | null;
  taxCategory: number;
  taxResidency: string;
  numChildren: number;
  childReliefMode: string;
  employerBearsTax: boolean;
  /** Item d64d0df4 — registered disabled individual (OKU). Defaults to false. */
  disabledIndividual: boolean;
};

/**
 * Identification & Tax card (item 8b5334db). Dedicated, visually-separated card with its OWN save (setTaxAction,
 * a partial update of only the tax columns). IC lives on the Profile tab now; this card carries only tax-related
 * information: Tax Number, Tax Category, Income Tax Resident, Children (PCB relief) with manual/auto control, and
 * the Employer-bears-tax switch. Client island so the child-relief auto suggestion is interactive; the RSC page
 * renders it as JSX only, so the server/client boundary is respected.
 *
 * Tax Category maps the five business labels to the LHDN integers the PCB engine needs (Single→1, Married &
 * Spouse Not Working→2, Married & Spouse Working→3, Divorced/Single with Kids→3, None→1). Two labels share value
 * 3 and two share value 1; the browser highlights the first option for a given stored value on reload (we only
 * persist the integer the engine uses — the label is a data-entry convenience).
 *
 * Children auto mode SURFACES the family-derived eligible count for HR to confirm into numChildren — it never
 * silently syncs (respects the benefits-vs-tax firewall). Manual mode keeps HR's keyed figure.
 */
export function IdentityTaxCard({
  action,
  employmentId,
  personId,
  defaults,
  derivedChildCount,
  embedded = false,
}: {
  action: (formData: FormData) => void | Promise<void>;
  employmentId: string;
  personId: string;
  defaults: IdentityTaxDefaults;
  derivedChildCount: number;
  /**
   * Item df09f22a — when true the island drops its own outer card chrome and renders as an "Income Tax (PCB)"
   * section nested inside the Statutory (Malaysia) card (visual merge). It keeps its OWN <form action={setTaxAction}>
   * and Save button — only the surrounding presentation changes, so the two-action design is preserved.
   */
  embedded?: boolean;
}) {
  const t = useTranslations('people.detail');
  const [mode, setMode] = useState(defaults.childReliefMode === 'auto' ? 'auto' : 'manual');
  const [numChildren, setNumChildren] = useState<string>(String(defaults.numChildren ?? 0));

  const heading = embedded ? (
    <div className="px-4 py-3">
      <h3 className="text-sm font-semibold text-foreground">{t('incomeTaxPcbSection')}</h3>
    </div>
  ) : (
    <div className="border-b border-border px-4 py-3">
      <h3 className="text-sm font-semibold text-foreground">{t('identityTaxCardTitle')}</h3>
    </div>
  );

  const wrapperCls = embedded
    ? 'border-t border-border'
    : 'rounded-xl border border-border bg-card shadow-sm';

  return (
    <div className={wrapperCls}>
      {heading}
      <form action={action} className="flex flex-col gap-6 px-4 pb-4">
        <input type="hidden" name="employmentId" value={employmentId} />
        <input type="hidden" name="personId" value={personId} />

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('taxInfoLegend')}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('taxNumber')}>
              {/* Grey placeholder example; the sample seed value is no longer defaulted in (item 8b5334db). */}
              <input name="taxNumber" defaultValue={defaults.taxNumber ?? ''} placeholder="IG1234567890" className={inputCls} />
            </Field>
            <Field label={t('taxCategoryLabel')}>
              {/* 5 labels → LHDN integer values (Single/None→1, Spouse-not-working→2, Spouse-working/Divorced→3). */}
              <select name="taxCategory" defaultValue={String(defaults.taxCategory ?? 1)} className={inputCls}>
                <option value="1">{t('taxCategorySingle')}</option>
                <option value="2">{t('taxCategoryMarriedSpouseNotWorking')}</option>
                <option value="3">{t('taxCategoryMarriedSpouseWorking')}</option>
                <option value="3">{t('taxCategoryDivorcedWithKids')}</option>
                <option value="1">{t('taxCategoryNone')}</option>
              </select>
            </Field>
            <Field label={t('incomeTaxResident')}>
              <select name="taxResidency" defaultValue={defaults.taxResidency || 'resident'} className={inputCls}>
                <option value="resident">{t('taxResidencyResident')}</option>
                <option value="non_resident">{t('taxResidencyNonResident')}</option>
                <option value="rep">{t('taxResidencyRep')}</option>
                <option value="knowledge_worker">{t('taxResidencyKnowledgeWorker')}</option>
              </select>
            </Field>
            {/* Item d64d0df4 — Disabled Individual (OKU). Yes/No, defaulting to No, so nobody's monthly tax
                moves until an admin makes the claim. Setting it to Yes DOES move it: monthly tax is worked
                out from the year to date, so the month of the change absorbs the whole year-to-date
                correction — which is what the rules require, and what the hint below says out loud rather
                than letting it arrive as a surprise on a payslip. */}
            <Field label={t('disabledIndividualLabel')}>
              <select
                name="disabledIndividual"
                defaultValue={defaults.disabledIndividual ? 'yes' : 'no'}
                className={inputCls}
              >
                <option value="no">{t('disabledIndividualNo')}</option>
                <option value="yes">{t('disabledIndividualYes')}</option>
              </select>
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('disabledIndividualHint')}</p>
        </fieldset>

        {/* Children (PCB relief) — manual or auto (derive from Family records, confirm into numChildren). */}
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <legend className="-ml-1 rounded-md bg-card px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-foreground">
            {t('childReliefLegend')}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('childReliefModeLabel')}>
              <select
                name="childReliefMode"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className={inputCls}
              >
                <option value="manual">{t('childReliefModeManual')}</option>
                <option value="auto">{t('childReliefModeAuto')}</option>
              </select>
            </Field>
            {/* R46 47146ea3 — in 'auto' the count is machine-maintained, so the input goes read-only and
                shows the DERIVED value rather than the stored one. readOnly (not disabled) is deliberate: a
                disabled input submits nothing, and setTaxProfileMY overwrites the whole tax column set, so
                disabling it would reset num_children to 0 on the next manual save of this card. Switching
                back to 'manual' restores the editable stored value. */}
            <Field label={t('childrenPcbRelief')}>
              <input
                name="numChildren"
                type="number"
                min="0"
                step="1"
                value={mode === 'auto' ? String(derivedChildCount) : numChildren}
                onChange={(e) => setNumChildren(e.target.value)}
                readOnly={mode === 'auto'}
                aria-readonly={mode === 'auto'}
                className={`${inputCls}${mode === 'auto' ? ' bg-muted/50 text-muted-foreground' : ''}`}
              />
            </Field>
          </div>
          {mode === 'auto' && (
            // R46 47146ea3 — the "Use {count}" button and its client-side confirm step are GONE. The count is
            // now synced server-side from the Family register on every dependent add / edit / archive (see
            // syncChildReliefFromFamily in core/dependents.ts), so there is nothing left for a human to
            // confirm. What remains is an explanation of where the number comes from and that it maintains
            // itself — plus the honest warning that this is a tax figure moving without a human in the loop.
            <div className="rounded-md border border-dashed border-border bg-card/60 p-3">
              <p className="text-xs text-muted-foreground">
                {t('childReliefAutoSyncNote', { count: derivedChildCount })}
              </p>
            </div>
          )}
        </fieldset>

        {/* Employer bears tax contribution. */}
        <fieldset className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm" title={t('employerBearsTaxHint')}>
            <input
              type="checkbox"
              name="employerBearsTax"
              defaultChecked={defaults.employerBearsTax}
              className="size-4 rounded"
            />
            {t('employerBearsTax')}
          </label>
          <p className="text-xs text-muted-foreground">{t('employerBearsTaxHint')}</p>
        </fieldset>

        <div className="flex items-end justify-end">
          <button className={btnPrimary}>{t('identityTaxSave')}</button>
        </div>
      </form>
    </div>
  );
}
