'use client';

import { startTransition, useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/monolith/field';
import { savePayrollCorrections } from './corrections-actions';

type Labels = Record<'title' | 'label' | 'description' | 'scope' | 'readOnly' | 'save' | 'saving' | 'saved', string>;

export function PayrollCorrectionsForm({ enabled, canEdit, labels }: {
  enabled: boolean;
  canEdit: boolean;
  labels: Labels;
}) {
  const [state, action, pending] = useActionState(savePayrollCorrections, {});
  const [dirty, setDirty] = useState(false);
  const [checked, setChecked] = useState(enabled);
  return (
    <Card className="p-5">
      <form onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setDirty(false);
        // Dispatch explicitly so React does not reset the switch after an action returns an error.
        startTransition(() => action(data));
      }}>
        <h2 className="text-base font-semibold">{labels.title}</h2>
        <p id="payroll-corrections-description" className="mt-1 max-w-prose text-sm text-muted-foreground">
          {labels.description}
        </p>
        <fieldset disabled={!canEdit || pending} className="mt-3">
          <Switch
            name="enabled"
            label={labels.label}
            checked={checked}
            aria-describedby="payroll-corrections-description payroll-corrections-scope"
            onCheckedChange={(value) => { setChecked(value); setDirty(true); }}
          />
          <p id="payroll-corrections-scope" className="mt-1 text-sm text-muted-foreground">{labels.scope}</p>
          {canEdit && (
            <Button type="submit" variant="secondary" className="mt-4" disabled={pending} aria-busy={pending}>
              {pending ? labels.saving : labels.save}
            </Button>
          )}
        </fieldset>
        {!canEdit && <p className="mt-3 text-sm text-muted-foreground">{labels.readOnly}</p>}
        <div aria-live="polite" className="mt-2 text-sm">
          {state.error && <p role="alert" className="text-destructive">{state.error}</p>}
          {state.saved && !dirty && !pending && <p role="status">{labels.saved}</p>}
        </div>
      </form>
    </Card>
  );
}
