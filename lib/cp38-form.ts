/**
 * 038c304b / bc6b5490 — the ONE reading of a CP38 Add/Edit form and the ONE mapping of a CP38 refusal to a message
 * key, shared by the employee's Payroll tab (app/admin/personnel/[employmentId]/cp38-actions.ts) and the
 * Payroll > Transaction Entry > CP38 Deduction page (app/payroll/transactions/cp38/actions.ts), so the two screens
 * accept the same input and say the same thing when the service refuses it.
 *
 * No database import: the service's errors are recognised by name and their own fields (core/cp38.ts), so this
 * module stays a plain parser both server-action files can use without widening the payroll pack's importers.
 */

/** What both forms post. `validTo` is the INCLUSIVE last month ("Effective to"); empty = open-ended. */
export type Cp38FormValues = {
  cp38Ref: string;
  amount: number;
  lastMonthAmount: number | null;
  validFrom: string;
  validTo: string | null;
  remarks: string | null;
};

const text = (v: FormDataEntryValue | null): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Read the form. The "Last month amount" tick box decides whether `lastMonthAmount` is sent: unticked always sends
 * null, so un-ticking on Edit clears it. An empty amount reads as NaN so the service refuses it by name instead of
 * saving RM 0.00 by accident.
 */
export function cp38FormValues(formData: FormData): Cp38FormValues {
  const amountText = text(formData.get('amount'));
  const lastMonthOn = text(formData.get('lastMonthEnabled')) === '1';
  const lastMonthText = text(formData.get('lastMonthAmount'));
  return {
    cp38Ref: text(formData.get('cp38Ref')),
    amount: amountText === '' ? Number.NaN : Number(amountText),
    lastMonthAmount: lastMonthOn ? (lastMonthText === '' ? Number.NaN : Number(lastMonthText)) : null,
    validFrom: text(formData.get('validFrom')),
    validTo: text(formData.get('validTo')) || null,
    remarks: text(formData.get('remarks')) || null,
  };
}

/** The message keys a CP38 refusal maps to (under payroll.transactions.cp38.error on both screens). */
export const CP38_ERROR_KEYS = [
  'refRequired',
  'amount',
  'lastMonthAmount',
  'lastMonthNeedsEnd',
  'backwards',
  'date',
  'overlap',
  'notFound',
  'outOfScope',
  'notStarted',
] as const;
export type Cp38ErrorKey = (typeof CP38_ERROR_KEYS)[number];

/**
 * A service refusal as its message key and ICU arguments (the clashing record for an overlap, the start month for
 * a record that has not started). `key` is null for anything else; the caller then shows the public error text.
 */
export function cp38ErrorKey(e: unknown): { key: Cp38ErrorKey | null; args: Record<string, string> } {
  const err = (e ?? {}) as { name?: unknown; problem?: unknown; cp38Ref?: unknown; validFrom?: unknown; validTo?: unknown };
  switch (err.name) {
    case 'Cp38InputError':
      return {
        key: (CP38_ERROR_KEYS as readonly unknown[]).includes(err.problem) ? (err.problem as Cp38ErrorKey) : null,
        args: {},
      };
    case 'Cp38OverlapError':
      return {
        key: 'overlap',
        args: {
          ref: String(err.cp38Ref ?? ''),
          from: String(err.validFrom ?? '').slice(0, 7),
          to: err.validTo ? String(err.validTo).slice(0, 7) : '',
        },
      };
    case 'Cp38NotFoundError':
      return { key: 'notFound', args: {} };
    case 'Cp38OutOfScopeError':
      return { key: 'outOfScope', args: {} };
    case 'Cp38NotStartedError':
      return { key: 'notStarted', args: { from: String(err.validFrom ?? '').slice(0, 7) } };
    default:
      return { key: null, args: {} };
  }
}
