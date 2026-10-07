'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RunPicker, type RunPickerStrings } from '@/components/run-picker';

/**
 * r407 (item 4f45f9b0) — THE `cycles` CRITERION ON THE CRITERIA STEP.
 *
 * The step itself is a server-rendered GET form (and must stay one: its address bar is the destination's
 * criteria, test/statutory-forms-criteria-858a1128.test.ts). The payroll-cycle list, though, depends on the
 * Company, Year and Month the operator is choosing on the SAME form, after it rendered — so this island
 * listens to that form's own `change` events and re-asks the shared picker for the month now selected.
 *
 * IT READS THE FORM, IT DOES NOT OWN IT. The three selects stay plain uncontrolled server-rendered
 * controls named with the destination's own field names (passed in), so nothing about the form's
 * submission changes when this island is absent or still hydrating: no `run` parameter is the whole month.
 *
 * NOTHING TICKED DISABLES CONTINUE. An empty selection cannot be written on a URL at all — absent means
 * "all cycles" — so a Continue pressed with nothing ticked would quietly produce the whole month, which is
 * the opposite of what it looks like. The submit button is found by `data-criteria-submit` inside the same
 * form. With NO runs listed, Continue stays enabled on purpose: the server-side gate is what answers that,
 * with the sentence the step then shows.
 *
 * Serialisable props only (it is mounted by a server component).
 */
export function CyclesCriterion({
  companyField,
  yearField,
  monthField,
  initialCompanyId,
  initialYear,
  initialMonth,
  endpoint,
  initialRunSeqs,
  strings,
}: {
  companyField: string;
  yearField: string;
  monthField: string;
  initialCompanyId: string;
  initialYear: string;
  initialMonth: string;
  endpoint: string;
  initialRunSeqs?: number[];
  strings: RunPickerStrings;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [crit, setCrit] = useState({ companyId: initialCompanyId, year: initialYear, month: initialMonth });

  useEffect(() => {
    const form = ref.current?.closest('form');
    if (!form) return;
    const read = () => {
      const v = (name: string) => {
        const el = form.elements.namedItem(name);
        return el instanceof HTMLSelectElement || el instanceof HTMLInputElement ? el.value : '';
      };
      setCrit({ companyId: v(companyField), year: v(yearField), month: v(monthField) });
    };
    form.addEventListener('change', read);
    return () => form.removeEventListener('change', read);
  }, [companyField, yearField, monthField]);

  const onPickedChange = useCallback(({ available, picked }: { available: number; picked: number }) => {
    const button = ref.current?.closest('form')?.querySelector<HTMLButtonElement>('[data-criteria-submit]');
    if (button) button.disabled = available > 0 && picked === 0;
  }, []);

  return (
    <div ref={ref} data-cycles-criterion>
      <RunPicker
        companyId={crit.companyId}
        periodKey={`${crit.year}-${crit.month}`}
        endpoint={endpoint}
        strings={strings}
        initialRunSeqs={initialRunSeqs}
        showClear
        onPickedChange={onPickedChange}
      />
    </div>
  );
}
