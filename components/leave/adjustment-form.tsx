'use client';

import { useState } from 'react';

import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { Button, Field, inputCls } from '@/components/ui';
import { cn } from '@/lib/utils';

type Opt = { value: string; label: string };
type Action = (fd: FormData) => void | Promise<void>;

/**
 * 491c499f — the three-step adjustment flow: which leave types, who, then the adjustment itself.
 *
 * ⚠️ EVERY PROP IS SERIALISABLE, DELIBERATELY. This is a client component mounted from a SERVER page, and
 * r124 took the Entitlements tab down in production by passing a translator closure across exactly that
 * boundary. So the copy arrives as a plain `labels` object rather than a `t` function, and
 * test/server-client-boundary.test.ts fails if anyone reaches for the shorter route. The `action` prop is
 * the one exception the framework allows: a server action is a reference React knows how to serialise.
 *
 * STATE IS LOCAL AND MINIMAL — which step is open, and which targeting mode. Everything else posts as
 * ordinary form fields, so the whole thing works as one submit with no client-side orchestration.
 */
export function AdjustmentForm({
  action,
  today,
  leaveTypes,
  companies,
  departments,
  employmentTypes,
  orgCriteria,
  labels,
}: {
  action: Action;
  today: string;
  leaveTypes: Opt[];
  companies: Opt[];
  departments: Opt[];
  employmentTypes: Opt[];
  /** The eight org axes, each already resolved to its label and its catalogue options. */
  orgCriteria: { key: string; label: string; options: Opt[] }[];
  labels: {
    stepTypes: string;
    stepWho: string;
    stepWhat: string;
    byCriteria: string;
    byIndividual: string;
    days: string;
    daysHelp: string;
    effectiveOn: string;
    reason: string;
    reasonHelp: string;
    employmentIds: string;
    employmentIdsHelp: string;
    everyoneWarning: string;
    submit: string;
  };
}) {
  const [mode, setMode] = useState<'criteria' | 'individual'>('criteria');
  const [anyCriteria, setAnyCriteria] = useState(false);

  return (
    <form action={action} className="space-y-5">
      {/* ── Step 1 — which leave types ─────────────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.stepTypes}
        </span>
        <ChipMultiSelect
          name="leaveTypeIds"
          options={leaveTypes}
          addPlaceholder={labels.stepTypes}
          removeLabelFor={(label) => label}
        />
      </section>

      {/* ── Step 2 — who ───────────────────────────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.stepWho}
        </span>
        <input type="hidden" name="targetMode" value={mode} />
        <div className="flex flex-wrap gap-4">
          {(['criteria', 'individual'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 text-xs text-foreground">
              <input
                type="radio"
                name="targetModeRadio"
                checked={mode === m}
                onChange={() => setMode(m)}
                className="size-3.5 border-border"
              />
              {m === 'criteria' ? labels.byCriteria : labels.byIndividual}
            </label>
          ))}
        </div>

        {mode === 'criteria' ? (
          <div className="space-y-3" onChange={() => setAnyCriteria(true)}>
            <ChipMultiSelect
              name="companyIds"
              label={labels.byCriteria}
              options={companies}
              addPlaceholder={labels.byCriteria}
              removeLabelFor={(label) => label}
            />
            <ChipMultiSelect
              name="departmentIds"
              options={departments}
              addPlaceholder={labels.stepWho}
              removeLabelFor={(label) => label}
            />
            <ChipMultiSelect
              name="employmentTypes"
              options={employmentTypes}
              addPlaceholder={labels.stepWho}
              removeLabelFor={(label) => label}
            />
            {orgCriteria.map((c) => (
              <ChipMultiSelect
                key={c.key}
                name={c.key}
                label={c.label}
                options={c.options}
                addPlaceholder={c.label}
                removeLabelFor={(label) => label}
              />
            ))}
            {/* THE ACCIDENT THIS EXISTS TO PREVENT: an empty criteria set legitimately means "everyone",
                and there is no way for the resolver to tell that apart from a form nobody finished. Said
                out loud rather than guessed at, because the resolver deliberately does not second-guess an
                explicit request. */}
            {!anyCriteria && (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                {labels.everyoneWarning}
              </p>
            )}
          </div>
        ) : (
          <Field label={labels.employmentIds}>
            <textarea
              name="employmentIdsRaw"
              rows={3}
              className={cn(inputCls, 'w-full')}
              placeholder={labels.employmentIdsHelp}
              onChange={(e) => {
                // Split the pasted list into one hidden input per id, so the action reads it with the same
                // getAll() contract the criteria fields use — one posting convention, not two.
                const host = e.currentTarget.parentElement?.querySelector('[data-ids]');
                if (!(host instanceof HTMLElement)) return;
                host.innerHTML = '';
                for (const id of e.currentTarget.value.split(/[\s,]+/).filter(Boolean)) {
                  const input = document.createElement('input');
                  input.type = 'hidden';
                  input.name = 'employmentIds';
                  input.value = id;
                  host.appendChild(input);
                }
              }}
            />
            <span data-ids />
          </Field>
        )}
      </section>

      {/* ── Step 3 — the adjustment ────────────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.stepWhat}
        </span>
        <Field label={labels.days}>
          <input name="days" type="number" step="0.5" required className={cn(inputCls, 'w-full')} />
        </Field>
        <p className="text-xs text-muted-foreground">{labels.daysHelp}</p>
        <Field label={labels.effectiveOn}>
          <input
            name="effectiveOn"
            type="date"
            required
            defaultValue={today}
            className={cn(inputCls, 'w-full')}
          />
        </Field>
        <Field label={labels.reason}>
          <input name="reason" type="text" required maxLength={200} className={cn(inputCls, 'w-full')} />
        </Field>
        <p className="text-xs text-muted-foreground">{labels.reasonHelp}</p>
      </section>

      <Button type="submit" size="sm">
        {labels.submit}
      </Button>
    </form>
  );
}
