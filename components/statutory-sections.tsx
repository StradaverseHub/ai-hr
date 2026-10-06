'use client';

/**
 * r393 (item 685d2380 step 3b) — THE ACTIVE RECORD'S STATUTORY (MALAYSIA) CHROME, for the Create New
 * Employee draft: the section legends, hints and the two plain switches the record renders inline in
 * app/admin/personnel/[employmentId]/page.tsx (statutoryCard) and components/identity-tax-card.tsx, with
 * the SAME keys, classes and wording.
 *
 * WHY A COMPONENT AND NOT `useTranslations('people.detail')` IN THE WIZARD. test/i18n-coverage.test.ts
 * check C silently skips a file that speaks more than one namespace, so the draft screen stays
 * `people.wizard`-only (test/da7463b4-draft-ic-dob-address.test.ts §3) and the record's words come across
 * inside components that speak `people.detail` — this file, like every shared field group.
 *
 * The record's own markup is NOT routed through here: those cards are full-row server forms whose inputs
 * must stay mounted and named, and moving them is a change of its own. The values here are CONTROLLED
 * ('yes' | 'no' strings, like every draft switch) and carry no `name`.
 */
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

const legendBoxed =
  '-ml-1 rounded-md bg-card px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-foreground';
const fieldsetBoxed = 'flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4';
const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';

/** "EPF contribution" — the record's EPF fieldset, legend and election hint. */
export function EpfContributionSection({ children }: { children: ReactNode }) {
  const t = useTranslations('people.detail');
  return (
    <fieldset data-draft-section="epf" className={fieldsetBoxed}>
      <legend className={legendBoxed}>{t('epfContribTitle')}</legend>
      <p className="text-xs text-muted-foreground">{t('epfElectionHint')}</p>
      {children}
    </fieldset>
  );
}

/** "SOCSO & EIS information" — the record's fieldset, with its Eligibility (Subject to SKBBK) and
 *  "Employer bears contribution" columns under the registration fields. */
export function SocsoEisSection({
  children,
  subjectToSkbbk,
  onSubjectToSkbbk,
  employerBears,
}: {
  children: ReactNode;
  subjectToSkbbk: string | undefined;
  onSubjectToSkbbk: (value: string) => void;
  employerBears: ReactNode;
}) {
  const t = useTranslations('people.detail');
  return (
    <fieldset data-draft-section="socsoEis" className={fieldsetBoxed}>
      <legend className={legendBoxed}>{t('socsoEisCardTitle')}</legend>
      {children}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('subjectToLegend')}</p>
          <label className="flex items-center gap-2 text-sm" title={t('subjectToSkbbkHint')}>
            <input
              type="checkbox"
              checked={subjectToSkbbk === 'yes'}
              onChange={(e) => onSubjectToSkbbk(e.target.checked ? 'yes' : 'no')}
              className="size-4 rounded"
            />
            {t('subjectToSkbbk')}
          </label>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground" title={t('employerBearsHint')}>
            {t('employerBearsLegend')}
          </p>
          {employerBears}
        </div>
      </div>
    </fieldset>
  );
}

/** "Income Tax (PCB)" — the record's nested section: Tax information, Children (PCB relief) and
 *  "Employer bears tax contribution", in that order. */
export function IncomeTaxSection({
  taxInformation,
  childRelief,
  employerBearsTax,
  onEmployerBearsTax,
}: {
  taxInformation: ReactNode;
  childRelief: ReactNode;
  employerBearsTax: string | undefined;
  onEmployerBearsTax: (value: string) => void;
}) {
  const t = useTranslations('people.detail');
  return (
    <section data-draft-section="incomeTax" className="flex flex-col gap-6 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-foreground">{t('incomeTaxPcbSection')}</h3>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('taxInfoLegend')}
        </legend>
        {taxInformation}
      </fieldset>
      <fieldset className={fieldsetBoxed}>
        <legend className={legendBoxed}>{t('childReliefLegend')}</legend>
        {childRelief}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm" title={t('employerBearsTaxHint')}>
          <input
            type="checkbox"
            checked={employerBearsTax === 'yes'}
            onChange={(e) => onEmployerBearsTax(e.target.checked ? 'yes' : 'no')}
            className="size-4 rounded"
          />
          {t('employerBearsTax')}
        </label>
        <p className="text-xs text-muted-foreground">{t('employerBearsTaxHint')}</p>
      </fieldset>
    </section>
  );
}

/** "Tax number", the record's label, controlled. */
export function TaxNumberField({ value, onChange }: { value: string | undefined; onChange: (value: string) => void }) {
  const t = useTranslations('people.detail');
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{t('taxNumber')}</span>
      <input className={inputCls} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** The body of the record's "Others Statutory" card: its hint, the levy control, the levy hint. */
export function OthersStatutoryBody({ children }: { children: ReactNode }) {
  const t = useTranslations('people.detail');
  return (
    <div data-draft-section="othersStatutory" className="flex flex-col gap-3 p-4">
      <p className="text-xs text-muted-foreground">{t('othersStatutoryHint')}</p>
      {children}
      <p className="text-xs text-muted-foreground">{t('subjectToHrdfHint')}</p>
    </div>
  );
}
