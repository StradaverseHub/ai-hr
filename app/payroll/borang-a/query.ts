/**
 * r407 (item 4f45f9b0) — THE BORANG A REQUEST, AS ONE LIST OF PARAMETERS. Pure.
 *
 * TWO DEFECTS LIVED HERE BEFORE THIS FILE, BOTH IN THE CONTRACT BETWEEN THE REVIEW SCREEN AND ITS ROUTES:
 *
 *   1. The review screen turned its search params into a query with `if (typeof v === 'string') q.set(…)`.
 *      A selection of two cycles arrives as `run: ['1', '2']` — an ARRAY — so it was skipped entirely and
 *      the screen reviewed the WHOLE MONTH under a link that named two cycles. `borangAQuery` appends every
 *      value of every parameter.
 *   2. Its download form carried `companyId`, `periodKey`, `year` and `month` as hidden inputs and no `run`
 *      (preview/page.tsx:319-323 on r405), so even a correctly filtered review downloaded a whole-month
 *      PDF, text copy and i-Akaun file. `borangADocumentPairs` is the ONE list the hidden inputs, the
 *      viewer's frame and every download link are built from, and it carries the selection.
 *
 * Everything else about a parameter's MEANING is the loader's (`./shared.ts`): this file only decides that
 * the four surfaces are handed the same parameters.
 */
import { RUN_PARAM } from '@/lib/payroll-run-selection';

export type Search = Record<string, string | string[] | undefined>;

/** The screen's params → the URLSearchParams the shared loader reads. EVERY value of a repeated key. */
export function borangAQuery(sp: Search): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') q.append(k, v);
    else if (Array.isArray(v)) for (const x of v) q.append(k, x);
  }
  return q;
}

/** The per-generation inputs the review screen applies and every download must repeat. */
const CARRIED = ['epfPeriod', 'code', 'batch', 'control'] as const;

/**
 * The parameters that name ONE Borang A: company, payroll month, the payroll cycles (absent = all), and the
 * per-generation inputs as they were last applied. Order is fixed so two surfaces build identical URLs.
 */
export function borangADocumentPairs(p: {
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
  for (const k of CARRIED) {
    const v = p.query?.get(k) ?? '';
    if (v !== '') out.push({ name: k, value: v });
  }
  return out;
}

export function borangADocumentQuery(p: Parameters<typeof borangADocumentPairs>[0]): string {
  const q = new URLSearchParams();
  for (const { name, value } of borangADocumentPairs(p)) q.append(name, value);
  return q.toString();
}
