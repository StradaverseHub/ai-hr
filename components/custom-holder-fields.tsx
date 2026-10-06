'use client';

/**
 * Custom payment holder — "Use a custom holder name" / "Use a custom holder identification" and the box
 * each one opens. A shared field group (r393, item 685d2380 step 3a): the Active profile's Bank
 * Information card and the draft employee's Bank & Statutory tab render THIS, so the two ticks, their
 * boxes and their wording cannot drift between a draft and the record it becomes.
 *
 *   mode: 'form'        → `name` + `defaultValue` / `checked` inputs read out of FormData by setBankAction.
 *                         The ticks keep their own state here (a tick opens its box at once). NO function
 *                         prop crosses in (the r123 RSC-boundary fault). Its markup is the card's markup
 *                         from before the extraction, byte for byte — test/r393-draft-custom-holder.dom.test.tsx
 *                         pins it in six locales.
 *   mode: 'controlled'  → bound to the draft's strings: a tick is 'yes' | 'no', each box its own string.
 *                         No `name`: nothing is posted. A ticked box left blank is what `missingByTab`
 *                         lists as still needed (`customHolderGaps`, lib/custom-holder.ts).
 *
 * ONE NAMESPACE (`people.detail`) and every key a literal — the card's existing keys, reused verbatim.
 */

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

// Inlined from components/ui (server module) so this stays a clean client island — the same copy
// components/bank-info-card.tsx carried before the extraction (the classes are part of the pinned markup).
const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export type CustomHolderDefaults = {
  enableCustomHolderName: boolean;
  customHolderName: string | null;
  enableCustomHolderId: boolean;
  customHolderId: string | null;
};

/** The draft's four strings (EmployeeDraftStatutory). */
export type CustomHolderDraftValue = {
  enableCustomHolderName?: string;
  customHolderName?: string;
  enableCustomHolderId?: string;
  customHolderId?: string;
};

type Props =
  | { mode: 'form'; defaults: CustomHolderDefaults }
  | {
      mode: 'controlled';
      value: CustomHolderDraftValue;
      onChange: (patch: CustomHolderDraftValue) => void;
    };

const isYes = (v: string | undefined) => (v ?? '').trim().toLowerCase() === 'yes';

export function CustomHolderFields(props: Props) {
  const t = useTranslations('people.detail');
  // Form mode owns its ticks (as the card always did); controlled mode reads them from the draft. Both
  // hooks run in both modes so the hook order never depends on the mode.
  const [formName, setFormName] = useState(props.mode === 'form' ? props.defaults.enableCustomHolderName : false);
  const [formId, setFormId] = useState(props.mode === 'form' ? props.defaults.enableCustomHolderId : false);
  const enableName = props.mode === 'form' ? formName : isYes(props.value.enableCustomHolderName);
  const enableId = props.mode === 'form' ? formId : isYes(props.value.enableCustomHolderId);

  const tick = (which: 'name' | 'id', checked: boolean) => {
    if (props.mode === 'form') {
      if (which === 'name') setFormName(checked);
      else setFormId(checked);
    } else {
      props.onChange(
        which === 'name'
          ? { enableCustomHolderName: checked ? 'yes' : 'no' }
          : { enableCustomHolderId: checked ? 'yes' : 'no' },
      );
    }
  };

  const box = (which: 'name' | 'id') => {
    const key = which === 'name' ? 'customHolderName' : 'customHolderId';
    return props.mode === 'form'
      ? { name: key, required: true, defaultValue: props.defaults[key] ?? '' }
      : {
          required: true,
          value: props.value[key] ?? '',
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => props.onChange({ [key]: e.target.value }),
        };
  };

  return (
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
              {...(props.mode === 'form' ? { name: 'enableCustomHolderName' } : {})}
              checked={enableName}
              onChange={(e) => tick('name', e.target.checked)}
              className="size-4 rounded"
            />
            {t('enableCustomHolderName')}
          </label>
          {enableName && (
            <Field label={t('customHolderName')}>
              <input {...box('name')} className={inputCls} />
            </Field>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              {...(props.mode === 'form' ? { name: 'enableCustomHolderId' } : {})}
              checked={enableId}
              onChange={(e) => tick('id', e.target.checked)}
              className="size-4 rounded"
            />
            {t('enableCustomHolderId')}
          </label>
          {enableId && (
            <Field label={t('customHolderId')}>
              <input {...box('id')} className={inputCls} />
            </Field>
          )}
        </div>
      </div>
    </fieldset>
  );
}
