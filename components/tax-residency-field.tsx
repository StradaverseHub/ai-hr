'use client';

/**
 * r393 (item 685d2380 step 3b) — "Income Tax Resident", the select the Active Income Tax (PCB) card has
 * carried inline since the employer-scoped tax selection, now ONE control with two branches so the Create
 * New Employee draft offers the SAME five choices in the SAME words:
 *
 *   mode="form"        the Active card (components/identity-tax-card.tsx). Byte-identical to the inline
 *                      select it replaced: it posts `taxResidency` (or, under "Not subject to income tax",
 *                      nothing — the card's own hidden input posts 'none'), is required, and offers the
 *                      disabled "Choose…" placeholder. The card still owns the value (its state) and the
 *                      `key` that resets it when the employer context changes.
 *   mode="controlled"  the draft. No `name`, no `id`: nothing posts by itself. A draft field is optional,
 *                      so the blank choice is a SELECTABLE "— Not set —" (lands as Resident, which is what an
 *                      untouched draft has always activated as) rather than a disabled placeholder.
 *
 * One literal t() per option — a template key is invisible to test/i18n-coverage.test.ts check C.
 */
import { useTranslations } from 'next-intl';

const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';

function TaxResidencyOptions() {
  const t = useTranslations('people.detail');
  return (
    <>
      <option value="resident">{t('taxResidencyResident')}</option>
      <option value="non_resident">{t('taxResidencyNonResident')}</option>
      <option value="rep">{t('taxResidencyRep')}</option>
      <option value="knowledge_worker">{t('taxResidencyKnowledgeWorker')}</option>
      <option value="c_suite">{t('taxResidencyCSuite')}</option>
    </>
  );
}

export function TaxResidencySelect(
  props:
    | { mode: 'form'; none: boolean; value: string; onChange: (value: string) => void }
    | { mode: 'controlled'; none: boolean; value: string | undefined; onChange: (value: string) => void; notSetLabel: string },
) {
  const t = useTranslations('people.detail');
  const { none } = props;
  if (props.mode === 'form') {
    return (
      <select id="income-tax-resident" aria-label={t('incomeTaxResident')} name={none?undefined:'taxResidency'} value={none?'none':props.value} onChange={e=>props.onChange(e.target.value)} disabled={none} required={!none} className={inputCls}>
        {none&&<option value="none">{t('taxCategoryNone')}</option>}
        <option value="" disabled>{t('taxSelectionChoose')}</option>
        <TaxResidencyOptions />
      </select>
    );
  }
  return (
    <select aria-label={t('incomeTaxResident')} value={none ? 'none' : (props.value ?? '')} onChange={(e) => props.onChange(e.target.value)} disabled={none} className={inputCls}>
      {none && <option value="none">{t('taxCategoryNone')}</option>}
      <option value="">{props.notSetLabel}</option>
      <TaxResidencyOptions />
    </select>
  );
}
