/**
 * WP-C (APR-022) — pure model of the head-of-department (HOD) department view: no database imports, so the
 * screen and DOM tests can import it. The reading service is department-view.ts; the population and the
 * overall come from app.onehr_department_view (0664).
 *
 * Source behaviour kept here:
 *  - Row order is a forest: roots are people whose live line manager is the HOD, who have no line manager, or
 *    whose line manager is outside the population, by name; each manager's people follow depth-first, by
 *    name. A person reachable only through a manager loop has no root and is not listed (as in the source).
 *  - The spread counts finalized people per band; each percentage is over the finalized people only.
 *    "N of M" is the finalized count over the listed population.
 *  - The overall reads as two decimals for mechanism A and one decimal plus a percent sign for mechanism B;
 *    spread percentages are whole numbers. Exact halves round to even, as the source's formatting does.
 */
import { pmBands, type PMBand } from './model';

export type DepartmentViewRow = {
  employmentId: string;
  /** The live administrative manager, only when that manager is in the same population. */
  parentEmploymentId: string | null;
  fullName: string;
  department: string | null;
  jobTitle: string | null;
  direct: boolean;
  /** Every KPI line locked and the moderated overall stored. */
  finalized: boolean;
  overallBand: PMBand | null;
  overallScore: number | null;
  mechanism: 'A' | 'B' | null;
};
export type DepartmentOrderedRow = DepartmentViewRow & { depth: number };
export type DepartmentCycle = { id: string; name: string; periodEnd: string; people: number; finalized: number };
export type DepartmentSpread = { counts: Record<PMBand, number>; pct: Record<PMBand, number>; finalized: number; total: number };

const byName = (a: DepartmentViewRow, b: DepartmentViewRow) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0);

/** The source's forest order, flattened depth-first. Input order breaks name ties (the service passes name, id). */
export function departmentForest(rows: readonly DepartmentViewRow[]): DepartmentOrderedRow[] {
  const byId = new Map(rows.map((r) => [r.employmentId, r]));
  const children = new Map<string, DepartmentViewRow[]>();
  const roots: DepartmentViewRow[] = [];
  for (const r of rows) {
    if (r.parentEmploymentId == null || !byId.has(r.parentEmploymentId)) roots.push(r);
    else children.set(r.parentEmploymentId, [...(children.get(r.parentEmploymentId) ?? []), r]);
  }
  const out: DepartmentOrderedRow[] = [];
  const visit = (r: DepartmentViewRow, depth: number, ancestry: Set<string>) => {
    out.push({ ...r, depth });
    for (const c of [...(children.get(r.employmentId) ?? [])].sort(byName)) {
      if (ancestry.has(c.employmentId)) continue;
      visit(c, depth + 1, new Set([...ancestry, c.employmentId]));
    }
  };
  for (const r of [...roots].sort(byName)) visit(r, 0, new Set([r.employmentId]));
  return out;
}

export function departmentSpread(rows: readonly DepartmentViewRow[]): DepartmentSpread {
  const counts = Object.fromEntries(pmBands.map((b) => [b, 0])) as Record<PMBand, number>;
  for (const r of rows) if (r.finalized && r.overallBand) counts[r.overallBand] += 1;
  const finalized = pmBands.reduce((n, b) => n + counts[b], 0);
  const pct = Object.fromEntries(pmBands.map((b) => [b, finalized ? (counts[b] / finalized) * 100 : 0])) as Record<PMBand, number>;
  return { counts, pct, finalized, total: rows.length };
}

/**
 * Fixed-point text for a non-negative figure, as the source's printf-style formatting reads it: the stored
 * binary value rounds to nearest, and only an EXACT half rounds to even. toFixed(100) is the exact decimal
 * expansion of the double, so a value like 112.35 (stored just below the half) is not mistaken for a tie.
 */
export function fixedHalfEven(value: number, digits: number): string {
  const [whole, frac = ''] = value.toFixed(100).split('.');
  if (/^50*$/.test(frac.slice(digits))) {
    const kept = digits ? `${whole}.${frac.slice(0, digits)}` : whole;
    if (Number(kept.at(-1)) % 2 === 0) return kept;
  }
  return value.toFixed(digits);
}

/** The overall figure before its band name: "3.25" (mechanism A) or "102.4%" (mechanism B). */
export function formatOverallScore(score: number, mechanism: 'A' | 'B' | null): string {
  return mechanism === 'A' ? fixedHalfEven(score, 2) : `${fixedHalfEven(score, 1)}%`;
}

export function formatSpreadPct(pct: number): string {
  return `${fixedHalfEven(pct, 0)}%`;
}

/** The cycle shown: the requested one when the viewer heads someone in it, else the first offered (open first). */
export function pickDepartmentCycle(cycles: readonly DepartmentCycle[], wanted: string | undefined): DepartmentCycle | null {
  return cycles.find((c) => c.id === wanted) ?? cycles[0] ?? null;
}
