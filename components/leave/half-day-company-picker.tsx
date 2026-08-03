'use client';

import { useTranslations } from 'next-intl';

import { ChipMultiSelect } from '@/components/ui/chip-multi-select';

/**
 * The half-day-deduction card's company picker (10e96227), wrapped for a SERVER caller.
 *
 * ⚠️ THIS WRAPPER EXISTS BECAUSE OF A LIVE PRODUCTION BREAKAGE, AND DELETING IT WOULD REINSTATE IT.
 *
 * r123 dropped `ChipMultiSelect` straight into app/admin/leave/entitlements/page.tsx, which is a SERVER
 * component, and passed it `removeLabelFor` and `countLabelFor` — closures over the server's `t`.
 * `ChipMultiSelect` is `'use client'`, so React had to serialise those props across the boundary and threw
 * at RENDER time:
 *
 *   Error: Functions cannot be passed directly to Client Components unless you explicitly expose it by
 *   marking it with "use server".
 *
 * The whole Entitlements tab returned "This page couldn't load" until this was fixed. Every OTHER caller of
 * ChipMultiSelect lives inside components/leave-type-panel.tsx, which is itself a client component, so
 * function props are legal there — which is exactly why the idiom looked safe when it was copied.
 *
 * NOTHING CAUGHT IT: `tsc` is happy (a function prop is well-typed), `next build` is happy (this is a
 * runtime serialisation error, not a build error), and the suite's static-source and core-behaviour tests
 * never render the page. See test/server-client-boundary.test.ts, added with this fix.
 *
 * So the rule this file encodes: a server component may pass a client component only SERIALISABLE props.
 * The translator has to be resolved on the client side of the boundary, which is what `useTranslations`
 * does here. `options` and `defaultSelected` are plain data and cross the boundary fine.
 */
export function HalfDayCompanyPicker({
  companies,
  selected,
}: {
  /** Plain data — id + display name. Serialisable, so it may cross the boundary. */
  companies: { value: string; label: string }[];
  /** The companies the rule applies to today, so first render reproduces the stored configuration. */
  selected: string[];
}) {
  const t = useTranslations('admin.leave');
  return (
    <ChipMultiSelect
      name="companyIds"
      label={t('halfDayDeductionCompaniesLabel')}
      options={companies}
      defaultSelected={selected}
      addPlaceholder={t('halfDayDeductionCompaniesPlaceholder')}
      removeLabelFor={(label) => t('chipRemoveAria', { name: label })}
      selectAllLabel={t('halfDayDeductionSelectAll')}
      clearAllLabel={t('halfDayDeductionClearAll')}
      allSelectedLabel={t('halfDayDeductionAllSelected')}
      countLabelFor={(count) => t('halfDayDeductionCountSelected', { count })}
    />
  );
}
