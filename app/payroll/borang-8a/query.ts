/**
 * r408 (item e74af58c) — THE BORANG 8A REQUEST, AS ONE LIST OF PARAMETERS. Pure. The Borang A twin of this
 * file (`../borang-a/query.ts`, r407) is the pattern, and the two defects it names are the reason:
 *
 *   1. The review screen built its loader query with `if (typeof v === 'string') q.set(…)`, so a selection
 *      of two cycles (`run: ['1', '2']`, an ARRAY) was dropped and the screen reviewed the WHOLE month.
 *      `borang8AQuery` appends every value of every parameter.
 *   2. Its download form carried `companyId` and `periodKey` as hidden inputs and no `run`, so a filtered
 *      review would have downloaded a whole-month PDF, text copy and ASSIST file. `borang8ADocumentPairs` is
 *      the ONE list the viewer's frame, every download link and the schedule form's hidden inputs are built
 *      from, and it carries the selection.
 *
 * THE TYPED STATUSES TRAVEL TOO. A status typed against a row (`st_<employmentId>`, S or T) is part of what
 * the reviewed form IS, so every surface repeats it — BY VALUE: an untouched box is submitted empty and
 * carried nowhere (CLAUDE.md §8, "a field that is always submitted cannot be read by presence").
 *
 * Everything about a parameter's MEANING is the loader's (`./shared.ts`): this file only decides that the
 * surfaces are handed the same parameters.
 */
import { RUN_PARAM } from '@/lib/payroll-run-selection';
import { BORANG_8A_STATUS_PARAM_PREFIX } from '@/lib/borang-8a';

export type Search = Record<string, string | string[] | undefined>;

/** The screen's params → the URLSearchParams the shared loader reads. EVERY value of a repeated key. */
export function borang8AQuery(sp: Search): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') q.append(k, v);
    else if (Array.isArray(v)) for (const x of v) q.append(k, x);
  }
  return q;
}

/**
 * The parameters that name ONE Borang 8A: company, payroll month, the payroll cycles (absent = all), and the
 * typed statuses that are non-empty. Order is fixed so two surfaces build identical URLs.
 */
export function borang8ADocumentPairs(p: {
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
  for (const [k, v] of p.query ?? []) {
    if (k.startsWith(BORANG_8A_STATUS_PARAM_PREFIX) && (v ?? '').trim() !== '') out.push({ name: k, value: v });
  }
  return out;
}

export function borang8ADocumentQuery(p: Parameters<typeof borang8ADocumentPairs>[0]): string {
  const q = new URLSearchParams();
  for (const { name, value } of borang8ADocumentPairs(p)) q.append(name, value);
  return q.toString();
}

/**
 * r408 — IS THERE ANYTHING TO FILE? At least one row, and at least one sen of SOCSO across them
 * (`contribution` is the SOCSO employer + employee pair the read took off the run). Pure, so the rule is
 * pinned without a session.
 *
 * ⚠️ A BONUS-ONLY SELECTION IS NOT DECIDED HERE. Its rows carry zero SOCSO, but the read names every person
 * on it with the "not in this selection" reason (`socsoEisOutsideSelection`, r373), and that refusal — the
 * review screen names them and every download is held — is the one the reporter was told about. So the
 * loader asks this question only when the readiness list is empty; see `loadBorang8A`.
 */
export function borang8AHasContributions(rows: readonly Record<string, unknown>[]): boolean {
  const sen = rows.reduce((a, r) => a + Math.round((Number(r.contribution) || 0) * 100), 0);
  return rows.length > 0 && sen !== 0;
}
