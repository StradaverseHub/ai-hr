'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from './ui';
import { findCompanyCodeClash, type CompanyCodeHolder } from '@/lib/company-code';

/**
 * Item 7d2df42a — THE COMPANY CODE INPUT, PLUS THE WARNING THAT NAMES WHO ELSE USES IT.
 *
 * One component for BOTH screens that edit the code (the create form and the company's General tab),
 * because a warning that appears on one of them and not the other is the shape of defect this item was
 * raised over: the operator finds out on whichever screen somebody remembered.
 *
 * ⚠️ IT IS A WARNING, NOT A CONSTRAINT, AND IT MUST NOT BECOME ONE BY ACCIDENT.
 *   - no `required` — the code is optional and stays optional (7 of 13 production companies have none);
 *   - no `pattern`, no `setCustomValidity`, no `aria-invalid` — none of which would merely look
 *     different, they would make the browser REFUSE the submit;
 *   - the submit button is never disabled from here, and this component owns no form state but the
 *     input's own value.
 * The point is that the operator finds out at the moment it matters, so an accident looks different
 * from an intention. They can still save, and `createCompany` / `updateCompany` still store what they
 * typed. The rules behind `findCompanyCodeClash` (archived companies do not collide; case and
 * whitespace do not distinguish two codes; storage is byte-for-byte what was typed) are stated once,
 * in lib/company-code.ts.
 *
 * ⚠️ ONE i18n NAMESPACE (`admin.organization`) — test/i18n-coverage.test.ts check C skips any file that
 * opens more than one, which is how a screen of MISSING_MESSAGEs once shipped behind a green suite.
 * `companyCodeDuplicate` is the only new key, and it exists in all six catalogues (`messages/*.json`),
 * asserted per locale in test/7d2df42a-company-code-duplicate.dom.test.tsx rather than left to
 * i18n/request.ts's English deep-merge, which would render English and look fine.
 */
export function CompanyCodeField({
  defaultValue = '',
  codesInUse,
  excludeId = null,
}: {
  /** The stored code (the General tab) or nothing (the create form). */
  defaultValue?: string;
  /** Companies that already hold a code — built by `companyCodeHolders` on the server. */
  codesInUse: readonly CompanyCodeHolder[];
  /** The company being edited, so its own stored code is not reported as a duplicate of itself. */
  excludeId?: string | null;
}) {
  const t = useTranslations('admin.organization');
  const [value, setValue] = useState(defaultValue);
  const warnId = useId();
  const clash = findCompanyCodeClash(value, codesInUse, excludeId);

  return (
    <>
      <input
        name="companyLabel"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={inputCls}
        placeholder={t('companyCodeHint')}
        // Describes, never invalidates. `aria-invalid` here would tell a screen reader the field is in
        // error, which is the one thing this warning is not.
        aria-describedby={clash ? warnId : undefined}
      />
      {clash ? (
        <span
          id={warnId}
          role="status"
          aria-live="polite"
          data-company-code-warning={clash.id}
          className="text-xs font-medium text-amber-700 dark:text-amber-400"
        >
          {t('companyCodeDuplicate', { company: clash.name })}
        </span>
      ) : null}
    </>
  );
}
