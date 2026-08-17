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
 * Attendance, leave and reporting are meant to ask the same question. Twelve call sites each writing their
 * own "look at the assignment rows, mind the NULLs, mind the gaps" is how two screens end up disagreeing
 * about which entity paid a day. The resolver is proven on PAYROLL FIRST precisely so that when the other
 * readers adopt it there is nothing left to discover about it.
 *
 * ⚠️ WHERE THAT ADOPTION ACTUALLY STANDS, because a stale plan reference here would send the next reader
 * looking for work that was done and past work that was not. Stage one (r194) added the column, the
 * resolver and the within-run month split. STAGE TWO (r197, item 1b0943d5) did the CROSS-BATCH half: the
 * membership predicate on every payroll site that needed it, payslip coverage dates (migration 0442) and
 * the completeness control in core/payroll-coverage.ts. Attendance, leave and reporting still read
 * `employment.company_id` at their dated call sites and are NOT adopted — deliberately, and last, because
 * the plan gates that pass on the payroll half being exercised against real data first (the production
 * backfill has not been run).
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
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
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

/**
 * The calendar day before `d` ('YYYY-MM-DD'). Used to turn an exclusive valid_to inclusive.
 *
 * EXPORTED for core/payroll-coverage.ts, which decides whether two payslips are ADJACENT or leave a gap —
 * the same one-day step, asked of the same date format. A second copy of this arithmetic is how a tiling
 * check and the resolver that produced the ranges start disagreeing about whether 10 August and 11 August
 * touch, so there is exactly one.
 */
export function dayBefore(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** The calendar day after `d` ('YYYY-MM-DD'). Exported for the same reason as `dayBefore`. */
export function dayAfter(d: string): string {
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
 *
 * ⚠️ [from, to] IS THE EMPLOYMENT'S OWN WINDOW, NOT THE BARE CALENDAR ONE, and the caller owes that
 * clamp. The gap-fill below covers every uncovered day with the CURRENT company, which is right for a day
 * the person was employed and had no dated row, and wrong for a day they were not employed at all. Handed
 * a whole month for somebody hired on the 15th and transferred on the 25th, it answers
 * B[01–14], A[15–24], B[25–31] — B twice, non-adjacent so the merge cannot join them, and claiming days
 * before the hire. `segmentForCompany` then hands B's run the FIRST of its two ranges (01–14), which is
 * a window the employee had not been hired for, and B pays nothing for the days it actually owns.
 * `companySegmentsForPeriodBulk` narrows the window to `hired_on` / `terminated_on` before calling this,
 * which is why it is the only DB-backed producer of segments.
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
 *
 * ── THE WINDOW IS CLAMPED TO THE EMPLOYMENT'S OWN TENURE, and that is a correctness fix rather than a
 * tidy-up. A MID-MONTH HIRE PLUS A SAME-MONTH TRANSFER is the shape that breaks without it: hired into A
 * on 15 August, A → B on the 25th. Over the bare month the resolver's gap-fill answers
 * B[01–14], A[15–24], B[25–31] — the same entity twice, non-adjacent, so the merge cannot join them —
 * and `segmentForCompany` hands B's payroll run the FIRST B range, 01–14, eleven days before the person
 * was hired. B then prorates against a window that ends before its own segment begins and pays for none
 * of the days it actually owns, while A pays 15–24; the employee is short a week. Clamped, the same
 * history answers A[15–24], B[25–31]: adjacent, each employer owning exactly its own days, and the
 * completeness control tiles the TENURE inside the period rather than the whole calendar month.
 *
 * Nothing moves for an employment hired before the period and not terminated in it, which is ~every
 * employment on ~every run: the clamp is then the identity.
 */
export async function companySegmentsForPeriodBulk(
  tx: Tx,
  employmentIds: string[],
  from: string,
  to: string,
  currentCompanyById: Map<string, string>,
): Promise<Map<string, CompanySegment[]>> {
  const ids = [...new Set(employmentIds)];
  if (ids.length === 0) return new Map();
  const rowsByEmp = await entityRowsFor(tx, ids, from, to);
  const tenureRows = await tx
    .select({ id: employment.id, hiredOn: employment.hiredOn, terminatedOn: employment.terminatedOn })
    .from(employment)
    .where(inArray(employment.id, ids));
  const tenureById = new Map(tenureRows.map((r) => [r.id, r] as const));
  const out = new Map<string, CompanySegment[]>();
  for (const id of ids) {
    const current = currentCompanyById.get(id);
    if (!current) continue;
    // An employment RLS hides (or that has been deleted between the two statements) keeps the caller's
    // window: narrowing on a tenure we cannot read would invent a gap out of a missing row.
    const t = tenureById.get(id);
    const winFrom = t?.hiredOn ? maxDate(from, t.hiredOn) : from;
    const winTo = t?.terminatedOn ? minDate(to, t.terminatedOn) : to;
    out.set(id, mergeCompanySegments(rowsByEmp.get(id) ?? [], current, winFrom, winTo));
  }
  return out;
}

/**
 * "Does this employment's entity history name an entity OTHER than the one it sits in today, at any point
 * in [from, to]?" — a SQL predicate over `employment`, and the cheapest exact answer to "could this
 * person's month be SPLIT?".
 *
 * WHY IT EXISTS AT ALL. The completeness control has to examine everybody the period's history says this
 * employer owns part of — NOT merely everybody the run happened to pay, which is the hole that let a
 * scoped run drop the one person it owed and close clean. Asking the resolver about every employment of
 * every company on every close would be honest and wasteful; this predicate reduces that to the handful
 * who actually moved, in the WHERE clause, before a single segment is resolved.
 *
 * IT IS EXACT, not a heuristic, and the reason is `mergeCompanySegments`: every day the history does not
 * cover is filled with `employment.company_id`, and adjacent ranges naming the same entity are merged. So
 * if every dated row overlapping the window names today's company, every segment names today's company
 * and they collapse into ONE — not split. More than one segment therefore REQUIRES a row naming a
 * different entity, which is exactly what this asks. (The converse does not hold — a single row naming a
 * different entity across the whole window is one segment — so this is a superset, and the caller still
 * filters on the resolved segment count. A superset is the safe direction: it can cost a resolver query,
 * never a missed employee.)
 *
 * INERT BEFORE THE BACKFILL, like `employedByCompanyDuring`: pre-0440 rows hold a NULL company, so this
 * matches nothing and the control examines exactly the population it examined before — and the resolver
 * agrees, because a NULL-history employment resolves to one segment and is not split either.
 */
export function entityChangedDuring(from: string, to: string): SQL {
  return sql`exists (
    select 1 from assignment a
    where a.employment_id = ${employment.id}
      and a.superseded_at is null
      and a.company_id is not null
      and a.company_id <> ${employment.companyId}
      and a.valid_from <= ${to}
      and (a.valid_to is null or a.valid_to > ${from})
  )`;
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
 * "Was this employment with `companyId` at ANY POINT in [from, to]?", as a SQL predicate over the
 * `employment` table — the question every company-scoped payroll read has to ask once the entity is
 * effective-dated.
 *
 * ONE EXPRESSION, SHARED, because the alternative is what this item is fixing in miniature: the payroll
 * KERNEL asking the dated question while the input screen, the eligibility list and the pre-processing
 * check still ask the column-only one. Those four disagreeing is an employee who is paid by a run that
 * would not let you key their overtime, and does not appear on the readiness check that is supposed to
 * gate the run they are on.
 *
 *   • the column — everyone currently here, which is everyone who never moved plus anyone who moved IN;
 *   • the dated history — anyone the `assignment` spine says belonged here over part of the window,
 *     which is how the OUTGOING employer keeps seeing someone whose column has already moved on.
 *
 * `gt(valid_to, from)`, not `gte`: valid_to is EXCLUSIVE (migration 0001's `daterange(…, '[)')`), so a
 * version closing at `from` last applied the day before and does not touch the window.
 *
 * INERT BEFORE THE BACKFILL — every pre-0440 row holds a NULL company, so the EXISTS matches nothing and
 * the predicate collapses to the column test it replaced.
 *
 * ⚠️ RLS STILL FENCES THE ROWS THIS RETURNS. `employment_rls` uses `app.can_see_employment(id)`, which
 * resolves through TODAY's `employment.company_id`, so an operator scoped to the OUTGOING company alone
 * cannot see a transferred-out employment at all and this predicate returns nothing for them. It works for
 * a group-wide operator and for one who administers both entities — which is who performs a transfer.
 * Widening the RLS predicate to the dated history is a security-shaped decision and is NOT taken here.
 */
export function employedByCompanyDuring(companyId: string, from: string, to: string): SQL {
  return sql`(${employment.companyId} = ${companyId} or exists (
    select 1 from assignment a
    where a.employment_id = ${employment.id}
      and a.superseded_at is null
      and a.company_id = ${companyId}
      and a.valid_from <= ${to}
      and (a.valid_to is null or a.valid_to > ${from})
  ))`;
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
