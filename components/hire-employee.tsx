'use client';

/**
 * Hire-employee entry point (feedback 5c9b73f2): relocates and renames the new-employee creation
 * function. The old surface was a collapsed "+ Hire an employee" <details> at the very BOTTOM of the
 * Personnel (Admin) page — easy to miss. This replaces it with a prominent top-right "+ Create new
 * employee" primary button (in the PageHeader actions) that toggles the very same hire form, now
 * rendered directly above the employee listing.
 *
 * The button and the form live in different parts of the page tree, so shared open/closed state is
 * held in a tiny React context (HireFormProvider wraps the whole page). Presentation only — the form,
 * its fields, validations, the `hireAction` server action, and the org-cascade inline script are all
 * unchanged.
 *
 * IMPORTANT: the panel toggles via the `hidden` attribute, NOT conditional rendering. The
 * server-rendered form (and its `hire-*` select ids) must stay in the DOM at load so the embedded
 * HIRE_ORG_FILTER_SCRIPT (feedback c87bc26a) initialises exactly as it did against the old collapsed
 * <details>. Conditionally mounting the children (open-gated render) would defer/replay that inline
 * <script> and risk double-binding. All labels arrive PRE-TRANSLATED via props (no t() in this island),
 * matching the FilterPanel convention on this page.
 */

import { createContext, useContext, useState, type ReactNode } from 'react';
import { btnPrimary, btnGhost } from './ui';

const HireFormContext = createContext<{
  open: boolean;
  setOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
} | null>(null);

function useHireForm() {
  const ctx = useContext(HireFormContext);
  if (!ctx) throw new Error('Hire-form components must be used within <HireFormProvider>');
  return ctx;
}

/** Wraps the whole Personnel page so the header button and the below-header form panel share state. */
export function HireFormProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <HireFormContext.Provider value={{ open, setOpen }}>{children}</HireFormContext.Provider>;
}

/** Prominent top-right primary button that opens the hire form. Anchors the onboarding tour. */
export function HireFormButton({ label, dataTour }: { label: string; dataTour?: string }) {
  const { open, setOpen } = useHireForm();
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      aria-controls="hire-form-panel"
      data-tour={dataTour}
      className={btnPrimary}
    >
      <span aria-hidden className="text-base leading-none">
        +
      </span>
      {label}
    </button>
  );
}

/**
 * Wraps the (server-rendered) hire form. Kept mounted at all times and shown/hidden via the `hidden`
 * attribute so the form's ids stay in the DOM for the org-cascade script (see file header).
 */
export function HireFormPanel({ children }: { children: ReactNode }) {
  const { open } = useHireForm();
  return (
    <div id="hire-form-panel" hidden={!open}>
      {children}
    </div>
  );
}

/** Ghost "Cancel" button rendered beside the form's submit; collapses the panel. */
export function HireFormCancelButton({ label }: { label: string }) {
  const { setOpen } = useHireForm();
  return (
    <button type="button" onClick={() => setOpen(false)} className={btnGhost}>
      {label}
    </button>
  );
}
