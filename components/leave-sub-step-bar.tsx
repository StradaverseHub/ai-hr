'use client';

import { cn } from '@/lib/utils';

/** One entry of a sub-step bar: a stable storage key + its localized label. */
export type SubStep = { key: string; label: string };

/**
 * Reusable SUB-STEP control (feedback e1a51aea): the R61 leave-workspace step-bar mechanism generalized
 * into a nested, second-level step switcher — the same accent/active pattern as the main bar
 * (components/leave-type-panel.tsx stepBtn: bg-accent wash + semibold label on the active pill,
 * aria-current="step", numbered badges), rendered SMALLER and nested under the main bar so the two levels
 * read as parent/child rather than competing.
 *
 * First used by the General step's five sub-steps (1 Details · 2 Leave Year Type · 3 Earning Method ·
 * 4 Carry Forward Policy · 5 Approval Workflow). The Condition and Entitlements secondary flows (items
 * 08bc6841 / 7b945408) MUST reuse this component rather than reinventing their own nested bar — that is
 * the reuse contract this file exists for. Purely presentational: the parent owns the active key, its
 * persistence, and what each sub-step renders.
 */
export function SubStepBar({
  steps,
  active,
  onSelect,
  ariaLabel,
}: {
  steps: SubStep[];
  active: string;
  onSelect: (key: string) => void;
  ariaLabel: string;
}) {
  return (
    <ol aria-label={ariaLabel} className="flex flex-wrap items-center gap-1">
      {steps.map((step, i) => {
        const stepActive = active === step.key;
        return (
          <li key={step.key} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden className="hidden h-px w-2 bg-border sm:block" />}
            <button
              type="button"
              onClick={() => onSelect(step.key)}
              aria-current={stepActive ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                stepActive
                  ? 'border-transparent bg-accent font-semibold text-accent-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] tabular-nums',
                  stepActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
              >
                {i + 1}
              </span>
              {step.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
