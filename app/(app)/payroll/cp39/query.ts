/**
 * r409 (item 79f3f64d) — THE CP39 REQUEST, AS ONE LIST OF PARAMETERS. Pure. Borang A's `../borang-a/query.ts`,
 * copied for the second form that is filed per payroll cycle.
 *
 * THE TWO DEFECTS r407 FOUND ON BORANG A WERE ON THIS SCREEN TOO, and this file is why they are not now:
 *
 *   1. The review screen built its query with `if (typeof v === 'string') q.set(…)`, so a selection of two
 *      cycles (`run: ['1', '2']`, an ARRAY) was dropped and the screen reviewed the whole month under a link
 *      that named two. `cp39Query` appends every value of every parameter.
 *   2. Its schedule form's hidden inputs were companyId / periodKey / year / month and no `run`, so every
 *      download — the PDF, the text copy and the e-Data PCB file — was the whole month whatever was ticked.
 *      `cp39DocumentPairs` is the ONE list the hidden inputs, the viewer's frame and every download link are
 *      built from, and it carries the selection.
 *
 * What a parameter MEANS is the loader's (`./shared.ts`); this file only decides that every surface is
 * handed the same parameters.
 */
import { RUN_PARAM } from '@/lib/payroll-run-selection';

export type Search = Record<string, string | string[] | undefined>;

/** The screen's params → the URLSearchParams the shared loader reads. EVERY value of a repeated key. */
export function cp39Query(sp: Search): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') q.append(k, v);
    else if (Array.isArray(v)) for (const x of v) q.append(k, x);
  }
  return q;
}

/**
 * The per-generation inputs the review screen applies (the preparer block, the print date and the payment
 * instrument) and every download must repeat, or the reviewed statement and the saved one differ.
 */
export const CP39_CARRIED = ['prepName', 'prepIc', 'prepPosition', 'prepPhone', 'date', 'payRef', 'payBranch'] as const;

/**
 * The parameters that name ONE CP39: company, payroll month, the payroll cycles (absent = all), and the
 * per-generation inputs as last applied. Order is fixed so two surfaces build identical URLs.
 */
export function cp39DocumentPairs(p: {
  companyId: string;
  periodKey: string;
  runSeqs: readonly number[] | undefined;
  query?: URLSearchParams;
}): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [
    { name: 'companyId', value: p.companyId },
    { name: 'periodKey', value: p.periodKey },
  ];
  for (const seq of p.runSeqs ?? []) out.push({ name: RUN_PARAM, value: String(seq) });
  for (const k of CP39_CARRIED) {
    const v = p.query?.get(k) ?? '';
    if (v !== '') out.push({ name: k, value: v });
  }
  return out;
}

export function cp39DocumentQuery(p: Parameters<typeof cp39DocumentPairs>[0]): string {
  const q = new URLSearchParams();
  for (const { name, value } of cp39DocumentPairs(p)) q.append(name, value);
  return q.toString();
}

/**
 * IS THERE ANYTHING TO FILE? At least one row with PCB or CP38 deducted. The statement prints the DEDUCTED
 * (`cp39PrintedRows`), so a selection where nobody had a sen of either withheld is a CP39 with an empty
 * schedule and RM 0.00 boxes — a statement of nothing. Pure, so the rule is pinned without a session;
 * `loadCp39Form` refuses with `'no-deductions'` when it is false, for every surface at once.
 */
export function cp39HasDeductions(rows: readonly Record<string, unknown>[]): boolean {
  return rows.some((r) => Math.round((Number(r.pcb) || 0) * 100) > 0 || Math.round((Number(r.cp38) || 0) * 100) > 0);
}
