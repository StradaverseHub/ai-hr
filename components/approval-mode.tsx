'use client';
/** The caller derives the mode from its levels; this control owns no separate policy state. */
export function ApprovalMode({ anyOne, onChange, labels }: {
  anyOne: boolean;
  onChange: (anyOne: boolean) => void;
  labels: { modeTitle: string; modeSequential: string; modeSequentialHint: string; modeAnyOne: string; modeAnyOneHint: string };
}) {
  return <fieldset className="space-y-3 rounded-lg border border-border p-4">
    <legend className="px-1 text-sm font-semibold">{labels.modeTitle}</legend>
    {[false, true].map(alternatives => <label key={String(alternatives)} className="flex cursor-pointer items-start gap-2 text-sm">
      <input type="radio" name="approvalMode" value={alternatives ? 'any_one' : 'sequential'} className="mt-0.5" checked={anyOne === alternatives} onChange={() => onChange(alternatives)}/>
      <span><span className="font-medium">{alternatives ? labels.modeAnyOne : labels.modeSequential}</span><span className="block text-xs text-muted-foreground">{alternatives ? labels.modeAnyOneHint : labels.modeSequentialHint}</span></span>
    </label>)}
  </fieldset>;
}
