'use client';

import { EmployeeScopePanel, type ScopeEmployee } from '@/components/collapsible-employee-panel';

/**
 * Fixed Transaction — Step-1 employee picker (feedback ee21508c), now a THIN ADAPTER over the shared
 * `EmployeeScopePanel` (r168a).
 *
 * WHAT WAS HERE AND WHY IT IS GONE. This file used to hold its own 192-line search/filter list: the same
 * Company / Business Unit / Department / Status filters, the same Employee-ID-or-name search, the same
 * 25-row cap, the same "Selected" tag — a near-copy of the list inlined in individual/txn-workspace.tsx.
 * Three more screens (Zakat 6a1f2bd6, Loans 6d72816e, Individual Payslip da4af51f) then asked for the same
 * control. Copying it three more times was the outcome the shared component exists to prevent, so the body
 * moved into components/collapsible-employee-panel.tsx beside the collapse shell it already sat inside.
 *
 * THE EXPORTS ARE DELIBERATELY UNCHANGED. `EmployeePicker` and `PickerEmployee` keep their names and their
 * shapes, so `fixed/page.tsx` is untouched by this refactor — the swap cannot alter a screen whose file it
 * never opened. `PickerEmployee` is now an alias of `ScopeEmployee`; they were already field-for-field
 * identical, which is precisely the evidence that one of them was redundant.
 *
 * BEHAVIOUR IS THE SAME, including the one thing worth naming: selecting a person still navigates to
 * `/payroll/transactions/fixed?employmentId=<id>` and the SERVER's scope guard still decides what that
 * means. This list has only ever been a navigation convenience over an already access-fenced set.
 */

/** @deprecated Prefer `ScopeEmployee` directly. Kept so existing imports do not have to change. */
export type PickerEmployee = ScopeEmployee;

export function EmployeePicker({
  employees,
  selectedId,
}: {
  employees: PickerEmployee[];
  selectedId: string | null;
}) {
  return (
    <EmployeeScopePanel
      employees={employees}
      selectedId={selectedId}
      basePath="/payroll/transactions/fixed"
    />
  );
}
