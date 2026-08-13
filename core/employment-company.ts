/**
 * 3c88d593 — WHICH LEGAL ENTITY DID THIS PERSON BELONG TO ON THIS DATE?
 *
 * Until migration 0440 there was no way to ask. `employment.company_id` holds one mutable value; an Entity
 * Transfer overwrites it and keeps no record of what came before. So an August payroll run for an employee
 * who moved on 11 August paid the whole month under the destination entity — not because payroll ignored
 * the transfer, but because there was nothing to look up. `assignment` — the effective-dated spine that
 * already versions department, position, cost centre, business unit, location and employment type — now
 * carries `company_id` too, and this module is the ONE place that reads it.
 *
 * ── WHY A MODULE AND NOT A LINE IN core/payroll.ts ──────────────────────────────────────────────────
 * Stage two of this item puts attendance, leave and reporting on the same question. Twelve call sites each
 * writing their own "look at the assignment rows, mind the NULLs, mind the gaps" is how two screens end up
 * disagreeing about which entity paid a day. The resolver is proven on payroll FIRST (stage one, this
 * round) precisely so that when the other readers adopt it there is nothing left to discover about it.
 *
 * ── THE FALLBACK IS THE WHOLE COMPATIBILITY STORY ───────────────────────────────────────────────────
 * `assignment.company_id` is nullable and every row that existed before 0440 holds NULL. A NULL is read
 * as "this range carries no entity history", and the answer falls back to `employment.company_id` — the
 * single current value, which is exactly what every caller used before this module existed. So:
 *   • a tenant whose backfill has not run yet resolves ONE segment covering the whole range, on today's
 *     company, and computes byte-identical payroll;
 *   • an employment that has never transferred resolves one segment whether or not it is backfilled;
 *   • only an employment with a REAL, dated entity change resolves more than one segment.
 * There is no flag. The behaviour change is carried entirely by the data.
 *
 * ── WHAT A SEGMENT IS ───────────────────────────────────────────────────────────────────────────────
 * A maximal inclusive [from, to] date range over which one company applied. Adjacent assignment versions
 * naming the SAME company are merged (a department change inside one entity is not an entity change, and
 * must not split a payroll month). Segments are returned in date order, never overlap, and together cover
 * the whole requested range with no gaps — a gap in the assignment history is filled from
 * `employment.company_id` rather than dropped, because "we have no row for 3 August" must never mean
 * "nobody was employed on 3 August".
 *
 * Dates are 'YYYY-MM-DD' strings throughout, the repo's convention for a calendar date with no timezone.
 * String comparison IS date comparison for that format, which is why this module does no Date parsing.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { assignment, employment } from '../db/schema';
import type { Tx } from '../db/client';

/** One maximal range over which a single legal entity applied. Inclusive on both ends. */
export type CompanySegment = {
  companyId: string;
  /** First day of the range, 'YYYY-MM-DD' (already clamped to the caller's window). */
  from: string;
  /** Last day of the range, 'YYYY-MM-DD' (already clamped to the caller's window). */
  to: string;
};

const maxDate = (a: string, b: string) => (a > b ? a : b);
const minDate = (a: string, b: string) => (a < b ? a : b);

/**
 * The raw entity-history rows for a set of employments, ordered. Only CURRENT (non-superseded) versions
 * are read — a superseded row is a corrected mistake, not history.
 *
 * `valid_to` is EXCLUSIVE in this table's own convention: the writers CLOSE the outgoing version by
 * setting `valid_to = effectiveDate` and open the new one at `valid_from = effectiveDate`, so the day of
 * the change belongs to the NEW row. That convention is not negotiable here — the exclusion constraint
 * `assignment_no_overlap` (migration 0001) is what makes the two rows legal side by side — so this module
 * converts to an inclusive `to` exactly once, at the boundary below, and every date it hands out after
 * that is inclusive.
 */
async function entityRowsFor(
  tx: Tx,
  employmentIds: string[],
  from: string,
  to: string,
): Promise<Map<string, { companyId: string; from: string; to: string | null }[]>> {
  const rows = employmentIds.length
    ? await tx
        .select({
          employmentId: assignment.employmentId,
          companyId: assignment.companyId,
          validFrom: assignment.validFrom,
          validTo: assignment.validTo,
        })
        .from(assignment)
        .where(
          and(
            inArray(assignment.employmentId, employmentIds),
            isNull(assignment.supersededAt),
            isNotNull(assignment.companyId),
            // Overlaps [from, to]: starts on/before the window end, and is still open or closes strictly
            // AFTER the window start. `gt`, not `gte`, because valid_to is exclusive — a row closing at
            // `from` last applied on the day BEFORE it and does not touch the window at all.
            lte(assignment.validFrom, to),
            or(isNull(assignment.validTo), gt(assignment.validTo, from)),
          ),
        )
        .orderBy(asc(assignment.employmentId), asc(assignment.validFrom))
    : [];
  const byEmp = new Map<string, { companyId: string; from: string; to: string | null }[]>();
  for (const r of rows) {
    if (!r.companyId) continue;
    const list = byEmp.get(r.employmentId) ?? [];
    // valid_to is exclusive → the last day this version applied is the day before it.
    list.push({ companyId: r.companyId, from: r.validFrom, to: r.validTo ? dayBefore(r.validTo) : null });
    byEmp.set(r.employmentId, list);
  }
  return byEmp;
}

/** The calendar day before `d` ('YYYY-MM-DD'). Used to turn an exclusive valid_to inclusive. */
function dayBefore(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** The calendar day after `d` ('YYYY-MM-DD'). */
function dayAfter(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Turn one employment's raw entity rows into merged, gap-filled segments over [from, to].
 *
 * PURE — no database, no clock — so the merge and gap rules are unit-testable without a fixture, which is
 * the whole reason payroll's month-splitting can be pinned by a table of dates rather than by a payroll run.
 *
 * `currentCompanyId` is `employment.company_id`: what fills a gap, and what the answer is when there is no
 * history at all. A zero-length row (valid_from === valid_to, which a movement dated on the day a previous
 * version started can produce) contributes nothing and is skipped.
 */
export function mergeCompanySegments(
  rows: { companyId: string; from: string; to: string | null }[],
  currentCompanyId: string,
  from: string,
  to: string,
): CompanySegment[] {
  if (from > to) return [];
  const clipped: CompanySegment[] = [];
  for (const r of [...rows].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))) {
    const segFrom = maxDate(r.from, from);
    const segTo = r.to == null ? to : minDate(r.to, to);
    if (segFrom > segTo) continue; // outside the window, or a zero-length version
    clipped.push({ companyId: r.companyId, from: segFrom, to: segTo });
  }

  // Fill any day the history does not cover with the employment's CURRENT company. An employment hired
  // before the backfill and transferred after it has history only from the transfer onward; the days
  // before it are not "unemployed", they are simply unrecorded, and today's column is the best (and only)
  // answer available for them.
  const filled: CompanySegment[] = [];
  let cursor = from;
  for (const seg of clipped) {
    if (seg.to < cursor) continue; // wholly inside a range already emitted
    const segFrom = maxDate(seg.from, cursor);
    if (segFrom > cursor) filled.push({ companyId: currentCompanyId, from: cursor, to: dayBefore(segFrom) });
    filled.push({ companyId: seg.companyId, from: segFrom, to: seg.to });
    cursor = dayAfter(seg.to);
    if (cursor > to) break;
  }
  if (cursor <= to) filled.push({ companyId: currentCompanyId, from: cursor, to });

  // Merge adjacent ranges naming the same entity. A department transfer inside one company writes a new
  // assignment version carrying the SAME company_id; without this merge it would split a payroll month
  // into two segments of one entity and produce two payslips for one employer — the exact opposite of
  // what this item is for.
  const merged: CompanySegment[] = [];
  for (const seg of filled) {
    const last = merged[merged.length - 1];
    if (last && last.companyId === seg.companyId) last.to = seg.to;
    else merged.push({ ...seg });
  }
  return merged;
}

/**
 * Entity segments over [from, to] for MANY employments in ONE query — the shape payroll needs, because a
 * batch resolves this for every employee on the run and a per-employee round trip would be a query per
 * head. `currentCompanyById` supplies the fallback; an employment absent from it is skipped rather than
 * guessed at.
 */
export async function companySegmentsForPeriodBulk(
  tx: Tx,
  employmentIds: string[],
  from: string,
  to: string,
  currentCompanyById: Map<string, string>,
): Promise<Map<string, CompanySegment[]>> {
  const ids = [...new Set(employmentIds)];
  const rowsByEmp = await entityRowsFor(tx, ids, from, to);
  const out = new Map<string, CompanySegment[]>();
  for (const id of ids) {
    const current = currentCompanyById.get(id);
    if (!current) continue;
    out.set(id, mergeCompanySegments(rowsByEmp.get(id) ?? [], current, from, to));
  }
  return out;
}

/**
 * Entity segments over [from, to] for ONE employment, reading its current company itself. The convenience
 * form for a caller that has one employment in hand (stage two's readers, and the tests).
 */
export async function companySegmentsForPeriod(
  tx: Tx,
  employmentId: string,
  from: string,
  to: string,
): Promise<CompanySegment[]> {
  const [emp] = await tx
    .select({ companyId: employment.companyId })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) return [];
  const map = await companySegmentsForPeriodBulk(
    tx,
    [employmentId],
    from,
    to,
    new Map([[employmentId, emp.companyId]]),
  );
  return map.get(employmentId) ?? [];
}

/** The legal entity this employment belonged to on one date, or null when the employment does not exist. */
export async function companyOnDate(tx: Tx, employmentId: string, date: string): Promise<string | null> {
  const segs = await companySegmentsForPeriod(tx, employmentId, date, date);
  return segs[0]?.companyId ?? null;
}

/**
 * The part of [from, to] during which this employment belonged to `companyId`, or null when it never did.
 *
 * Deliberately ONE range rather than a list: an employee who leaves an entity and comes back inside a
 * single payroll month would produce two disjoint ranges, and a payslip cannot represent that. Returning
 * the outer hull would silently pay the middle stretch under the wrong employer, so this returns the
 * FIRST range and reports `split: true` so the caller can say so rather than quietly getting it wrong.
 * (No production employment has ever done this; the flag exists so that if one ever does, it is visible.)
 */
export function segmentForCompany(
  segments: CompanySegment[],
  companyId: string,
): { from: string; to: string; split: boolean } | null {
  const mine = segments.filter((s) => s.companyId === companyId);
  if (mine.length === 0) return null;
  return { from: mine[0].from, to: mine[0].to, split: mine.length > 1 };
}
