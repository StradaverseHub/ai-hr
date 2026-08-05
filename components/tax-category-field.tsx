'use client';

/**
 * The LHDN tax category — the SIXTH shared field group of item 35b7af0a (Create New Employee wizard ↔
 * Personnel (Admin) Identification & Tax card). Same shape as groups 1–5: one definition, a discriminated
 * `mode`, both screens render it.
 *
 * THIS ONE IS NOT COSMETIC EITHER. The Personnel card has offered FIVE NAMED options for as long as it has
 * existed — Single, Married & spouse not working, Married & spouse working, Divorced with children, None —
 * mapping onto the three LHDN integer values. The wizard rendered its own private select whose options
 * were labelled, literally, "1", "2" and "3" (`people.wizard.taxCategory.1` / `.2` / `.3`).
 *
 * So whoever created a hire had to already know that category 2 means "married, spouse not working", while
 * whoever edited the same employee an hour later was told in words. A category chosen wrongly at hire is
 * invisible afterwards: it is simply the wrong monthly tax, every month, until somebody notices. That is
 * precisely what this item means by the wizard not following the Personnel module's structure.
 *
 * THE 5→3 MAPPING IS CARRIED OVER EXACTLY, duplicate values included (Single→1, Spouse-not-working→2,
 * Spouse-working→3, Divorced-with-children→3, None→1). Two options sharing a value is deliberate and must
 * not be "tidied": they are different circumstances that LHDN taxes identically, and HR picks the one that
 * describes the employee instead of doing the mapping in their head.
 *
 *   mode: 'form'        → `name` + `defaultValue`, read out of FormData by the Personnel action. No
 *                         function prop, so the card stays renderable from a server page (the r123
 *                         RSC-boundary fault).
 *   mode: 'controlled'  → `value` + `onChange` bound to the wizard's draft state, and NO `name` at all —
 *                         the wizard submits its draft as JSON. r159 recorded why that distinction
 *                         matters: a guard grepping for `name="taxCategory"` must not conclude this posts.
 *
 * LABELS ARE READ WHERE THEY LIVE — `people.detail.taxCategory*`, the Personnel card's own keys. The
 * wizard's `fields.taxCategory` and its `taxCategory.1` / `.2` / `.3` value labels are retired with this
 * change. Checked before retiring them, per the trap that nearly cost three keys in r159: `missingByStep`
 * (lib/employee-draft-schema.ts) never returns 'taxCategory', so the Review step's computed
 * t(`fields.${f}`) cannot ask for it — unlike `fields.bankAccount` and `fields.rateAmount`, which are kept
 * for exactly that reason.
 */
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';

/** The five options, in the order both screens show them, with their LHDN integer values. */
export const TAX_CATEGORY_OPTIONS = [
  { value: '1', key: 'taxCategorySingle' },
  { value: '2', key: 'taxCategoryMarriedSpouseNotWorking' },
  { value: '3', key: 'taxCategoryMarriedSpouseWorking' },
  { value: '3', key: 'taxCategoryDivorcedWithKids' },
  { value: '1', key: 'taxCategoryNone' },
] as const;

type Common = {
  /** Controlled mode only: the wizard's "leave it unset" option label. */
  notSetLabel?: string;
  className?: string;
};

export function TaxCategoryField(
  props:
    | (Common & { mode: 'form'; defaultValue?: number | string | null; name?: string })
    | (Common & { mode: 'controlled'; value: string | undefined; onChange: (value: string) => void }),
) {
  const t = useTranslations('people.detail');
  const options = TAX_CATEGORY_OPTIONS.map((o, i) => (
    // The index is part of the key ON PURPOSE: two options legitimately share a value, so the value alone
    // is not unique and React would collapse them into one.
    <option key={`${o.value}-${i}`} value={o.value}>
      {t(o.key)}
    </option>
  ));

  return (
    <Field label={t('taxCategoryLabel')} className={props.className}>
      {props.mode === 'form' ? (
        <select
          name={props.name ?? 'taxCategory'}
          defaultValue={String(props.defaultValue ?? 1)}
          className={inputCls}
        >
          {options}
        </select>
      ) : (
        <select
          value={props.value ?? ''}
          onChange={(e) => props.onChange(e.target.value)}
          className={inputCls}
          aria-label={t('taxCategoryLabel')}
        >
          {/* The wizard allows "not set": a hire can be created before the tax category is known, and
              setStatutoryProfileMY defaults an absent value to 1. The Personnel card has no such option
              because by then the row exists and always carries a value. */}
          <option value="">{props.notSetLabel ?? ''}</option>
          {options}
        </select>
      )}
    </Field>
  );
}
