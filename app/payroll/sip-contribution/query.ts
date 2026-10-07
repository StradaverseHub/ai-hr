/**
 * r412 (item e74af58c, step 2) — THE EIS (SIP) SCHEDULE REQUEST, AS ONE LIST OF PARAMETERS. Pure. The Borang 8A
 * twin (`../borang-8a/query.ts`, r408) is the pattern, for its two reasons: every value of a repeated `run`
 * is kept (a string-only conversion drops the array and reviews the whole month), and the viewer's frame and
 * every download are built from ONE list that carries the selection — so a filtered preview cannot download
 * a whole-month PDF. No typed statuses here: this schedule has no status column.
 */
import { RUN_PARAM } from '@/lib/payroll-run-selection';

export type Search = Record<string, string | string[] | undefined>;

/** The screen's params → the URLSearchParams the shared loader reads. EVERY value of a repeated key. */
export function sipQuery(sp: Search): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') q.append(k, v);
    else if (Array.isArray(v)) for (const x of v) q.append(k, x);
  }
  return q;
}

/** Company, payroll month and the cycles (absent = all). Order is fixed so two surfaces build identical URLs. */
export function sipDocumentPairs(p: {
  companyId: string;
  periodKey: string;
  runSeqs: readonly number[] | undefined;
}): { name: string; value: string }[] {
  const out = [
    { name: 'companyId', value: p.companyId },
    { name: 'periodKey', value: p.periodKey },
  ];
  for (const seq of p.runSeqs ?? []) out.push({ name: RUN_PARAM, value: String(seq) });
  return out;
}

export function sipDocumentQuery(p: Parameters<typeof sipDocumentPairs>[0]): string {
  const q = new URLSearchParams();
  for (const { name, value } of sipDocumentPairs(p)) q.append(name, value);
  return q.toString();
}

/**
 * IS THERE ANYTHING TO FILE? At least one line and at least one sen of EIS across them. Pure. As with the 8A,
 * a BONUS-ONLY selection is not decided here: the read names everyone on it with the not-in-selection reason,
 * and the loader asks this question only when nobody is named (see `loadSip`).
 */
export function sipHasContributions(rows: readonly Record<string, unknown>[]): boolean {
  const sen = rows.reduce((a, r) => a + Math.round((Number(r.contribution) || 0) * 100), 0);
  return rows.length > 0 && sen !== 0;
}
