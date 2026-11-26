/**
 * cc8bd87f — what the Fixed Transaction list page, its actions and its View / Edit pop-up share.
 *
 * Plain module on purpose: no 'use client', no 'use server', no core/ import. A 'use server' file may only
 * export async functions, and the client island must not pull the service layer into the browser, so the
 * error vocabulary and the cycle-option rule live here where all three can import them.
 */

/** One configured Payroll Cycle as the Edit pop-up offers it (same shape as cycle-select.tsx). */
export type FixedEditCycleOption = { id: string; label: string };

/**
 * The refusals the screen has a sentence for, under `payroll.transactions.fixed.<key>`. Anything else is
 * shown as the public error text. One set for the list page's banner and the pop-up, so a new refusal is
 * added once.
 */
export const FIXED_ERROR_KEYS: ReadonlySet<string> = new Set([
  'dateError',
  'currencyUnsupported',
  'amountError',
  'required',
  'outOfScope',
  'notFound',
  // 2aed39d4 — removal/edit refused because a CLOSED run covers the row's window.
  'paidOnPayslip',
  // 2aed39d4 — the two overlap refusals. Both name the clashing record via ICU arguments.
  'overlap',
  'backwards',
  // a3d485f6 — the change lands part-way through a month a live record already covers.
  'midMonth',
  // 4fffe638 — the chosen Payroll Cycle is missing, inactive or another company's.
  'cycleInvalid',
  // cc8bd87f — the in-place end-date change: it would flip a closed month, or end in the month the next
  // line for the same pay item starts.
  'endClosedMonth',
  'endSameMonth',
]);

/** The ICU arguments a refusal can carry. Built only from a TYPED error's own fields, never from input. */
export type FixedErrorArgs = Partial<Record<'code' | 'from' | 'to' | 'period' | 'nextFirst' | 'latestEnd', string>>;

/** How each argument travels in a redirect's query string (the names the list page has always read). */
export const FIXED_ERROR_QS = {
  code: 'clashCode',
  from: 'clashFrom',
  to: 'clashTo',
  period: 'clashPeriod',
  nextFirst: 'nextFirst',
  latestEnd: 'latestEnd',
} as const satisfies Record<keyof FixedErrorArgs, string>;

/**
 * Every argument, filled. Passed to every key rather than only to the ones that use them: next-intl ignores
 * unused arguments, and `—` rather than an empty string makes a missing value visible instead of blank.
 */
export function fixedErrorValues(args: FixedErrorArgs, openEnded: string): Record<keyof FixedErrorArgs, string> {
  return {
    code: args.code ?? '—',
    from: args.from ?? '—',
    to: args.to ?? openEnded,
    period: args.period ?? '—',
    nextFirst: args.nextFirst ?? '—',
    latestEnd: args.latestEnd ?? '—',
  };
}

/**
 * 4fffe638 rule, kept from the old Edit page: the employee's OWN company's ACTIVE configured cycles in the
 * Payroll Cycles order, and a row linked to a cycle since made inactive shows that cycle FIRST, marked
 * inactive, so an untouched save keeps it (it is offered to nobody choosing afresh).
 */
export function fixedEditCycleOptions(
  activeCycles: readonly { id: string; name: string }[],
  row: { payrollCycleId: string | null; payrollCycleName: string | null },
  inactiveLabel: (name: string) => string,
): FixedEditCycleOption[] {
  const options = activeCycles.map((c) => ({ id: c.id, label: c.name }));
  if (row.payrollCycleId && !activeCycles.some((c) => c.id === row.payrollCycleId)) {
    options.unshift({ id: row.payrollCycleId, label: inactiveLabel(row.payrollCycleName ?? '—') });
  }
  return options;
}
