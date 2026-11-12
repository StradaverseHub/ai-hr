'use client';

import { createContext, startTransition, useActionState, useContext, useEffect, useRef, type ReactNode } from 'react';
import { ErrorBanner } from '@/components/ui';
import { restoreFormValues, type FormRefusal } from './form-state';

const RefusalContext = createContext<FormRefusal | null>(null);

/**
 * Slice 15 review: a Recruitment form whose save returns its refusal (the new-position form and the position template form), in the
 * pattern of ./candidates/add-application-form. The form has no `action` prop: onSubmit dispatches the server action itself, so
 * React never resets what was typed. A refusal shows its sentence above the form and each refused field says so beside it
 * (FieldProblem); the values the action returned are put back as well, in case the fields were re-rendered. A successful save
 * redirects on the server. The fields themselves are rendered on the server (children) and stay as they are.
 */
export function ActionForm({ action, className, children }: {
  action: (prev: FormRefusal, form: FormData) => Promise<FormRefusal>;
  className?: string;
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState<FormRefusal, FormData>(action, { status: 'idle' });
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const form = ref.current;
    if (state.status !== 'refused' || !form) return;
    if (state.values) restoreFormValues(form, state.values);
    const first = state.fields?.map((name) => form.querySelector<HTMLElement>(`[name="${name.replace(/["\\]/g, '\\$&')}"]:not([type="hidden"])`)).find(Boolean);
    (first ?? form.querySelector<HTMLElement>('[role="alert"]'))?.focus?.();
  }, [state]);
  return (
    <RefusalContext.Provider value={state}>
      <form
        ref={ref}
        aria-busy={pending}
        className={className}
        onSubmit={(e) => {
          e.preventDefault();
          const formData = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
          startTransition(() => formAction(formData));
        }}
      >
        <div role="alert" tabIndex={-1}>
          <ErrorBanner message={state.status === 'refused' ? state.errorText : undefined} />
        </div>
        {children}
      </form>
    </RefusalContext.Provider>
  );
}

/**
 * The message beside a field the last save refused (nothing otherwise, and nothing outside an ActionForm): `required` for a
 * missing value, `invalid` for one that does not fit. All text arrives translated.
 */
export function FieldProblem({ name, required, invalid }: { name: string; required: string; invalid: string }) {
  const state = useContext(RefusalContext);
  if (!state || state.status !== 'refused' || !state.fields?.includes(name)) return null;
  const missing = state.problem === 'missing_fields' || state.problem === 'custom_field_required';
  return <span className="text-xs font-medium text-destructive" data-field-problem={name}>{missing ? required : invalid}</span>;
}
