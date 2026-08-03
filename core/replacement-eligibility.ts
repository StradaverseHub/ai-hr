/**
 * 296fc027 · WHO MAY ASK FOR REPLACEMENT LEAVE — the AS-OF eligibility resolver.
 *
 * THE POINT OF THIS FILE, AND WHY IT IS NOT core/leave-org-criteria.ts. That module's own header states
 * that Department, Position, Employment Type and Job Grade were DEFERRED from the leave-type criteria
 * tranche, and gives the reason: its eight criteria are all plain TEXT columns on `employment` compared by
 * string equality, so a flat descriptor + `emp[key]` lookup is valid for them and only for them. The four
 * deferred ones are not like that. `assignment.departmentId`, `assignment.positionId` and
 * `assignment.employmentType` live on the EFFECTIVE-DATED `assignment` table (valid_from / valid_to /
 * superseded_at), and `employment.gradeId` is a UUID against a master table. Resolving them means asking
 * "which assignment row was valid on a particular DATE", which a flat column read cannot express.
 *
 * So this is that resolver, built once here. It is deliberately shaped to be the pattern the deferred
 * leave criteria reuse: a descriptor list, an as-of fact read, and a pure matcher, with the DATE as an
 * explicit parameter rather than an implicit `current_date`.
 *
 * WHY AS-OF AND NOT "CURRENT". An employee who transferred out of Engineering last week must be judged on
 * the assignment they held on the day the question is asked, not on today's row — otherwise a request
 * submitted on Monday and approved on Friday could be eligible at submission and ineligible at approval,
 * for no reason the employee did anything about. Both gates pass the SAME date (the submission date), so
 * an approval never re-litigates eligibility against a later org chart. `asOf` is injected, never
 * defaulted to `new Date()` inside the query, so the suite can pin a boundary.
 *
 * NO DB IMPORT AT THE TYPE LEVEL: `matchesReplacementEligibility` is a pure function over already-read
 * facts, so the picker/summary surfaces can import the descriptor and the matcher without dragging in
 * server-only DB code. Only `resolveEligibilityFactsTx` touches a transaction.
 */
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { assignment, employment, type ReplacementRequestEligibility } from '../db/schema';

export type { ReplacementRequestEligibility };

/**
 * One eligibility criterion. `key` is BOTH the JSONB key and the FormData field name (identical by
 * construction, exactly as ORG_ASSIGNMENT_CRITERIA does it), so the form contract is `fd.getAll(key)` with
 * no per-field wiring. `source` records WHERE the fact comes from, which is the whole distinction this
 * module exists to make:
 *   - 'employment'  — a column on `employment`, true regardless of date;
 *   - 'assignment'  — a column on the effective-dated `assignment` row valid AS OF the question's date;
 *   - 'identity'    — the employment itself (the named-individual escape hatch).
 * `labelKey` is the i18n key under `admin.replacementLeave` for the picker's caption.
 */
export type ReplacementEligibilityCriterion = {
  key: keyof ReplacementRequestEligibility;
  source: 'employment' | 'assignment' | 'identity';
  labelKey: string;
};

/**
 * The eight dimensions the request names, in the order they read on screen.
 *
 * FOUR OF THESE ARE THE DEFERRED ONES. departmentIds / positionIds / employmentTypes come off the
 * effective-dated assignment row; gradeIds comes off employment.gradeId (a UUID, not a text value). The
 * other three org fields (divisions, employmentCategories) are the plain `employment` text columns
 * core/leave-org-criteria.ts already covers, kept here so one picker answers the whole question.
 */
export const REPLACEMENT_ELIGIBILITY_CRITERIA = [
  // COMPANY IS NEARLY A NO-OP HERE, and that is worth saying rather than leaving to be discovered. The
  // criteria live on `toil_policy`, which is already ONE ROW PER COMPANY, so an admin who selects this
  // policy's own company has restricted nothing, and one who selects a different company has excluded
  // everybody. It is offered because the request names company among the eight dimensions, and it is
  // evaluated honestly rather than silently ignored — a criterion the form accepts and the resolver
  // discards would be worse than one that behaves predictably. If the policy grain ever widens beyond a
  // company, this becomes load-bearing without any change here.
  { key: 'companyIds', source: 'employment', labelKey: 'critCompany' },
  { key: 'employmentTypes', source: 'assignment', labelKey: 'critEmploymentType' },
  { key: 'departmentIds', source: 'assignment', labelKey: 'critDepartment' },
  { key: 'divisions', source: 'employment', labelKey: 'critDivision' },
  { key: 'positionIds', source: 'assignment', labelKey: 'critPosition' },
  { key: 'gradeIds', source: 'employment', labelKey: 'critGrade' },
  { key: 'employmentCategories', source: 'employment', labelKey: 'critEmployeeCategory' },
  { key: 'employmentIds', source: 'identity', labelKey: 'critEmployee' },
] as const satisfies readonly ReplacementEligibilityCriterion[];

export type ReplacementEligibilityKey = (typeof REPLACEMENT_ELIGIBILITY_CRITERIA)[number]['key'];

/** The org criteria — every key EXCEPT the named-individual one, which resolves by a different rule. */
export const REPLACEMENT_ORG_CRITERIA = REPLACEMENT_ELIGIBILITY_CRITERIA.filter(
  (c) => c.key !== 'employmentIds',
);

/** The facts about one employee, read as of a date. `null` ⇒ the employee genuinely has no such value. */
export type ReplacementEligibilityFacts = {
  employmentId: string;
  companyId: string | null;
  /** From the assignment row valid as of the question's date — null when the employee had none then. */
  employmentType: string | null;
  departmentId: string | null;
  positionId: string | null;
  gradeId: string | null;
  division: string | null;
  employmentCategory: string | null;
};

/** Normalise a stored list. Mirrors `asList` in core/leave.ts — blanks and nulls are not restrictions. */
export function asEligibilityList(v: string[] | string | null | undefined): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x != null && String(x).trim() !== '');
}

/** Does this criteria object restrict anything at all? Empty/absent everywhere ⇒ everyone may submit. */
export function hasAnyReplacementRestriction(e: ReplacementRequestEligibility | null | undefined): boolean {
  if (!e) return false;
  return REPLACEMENT_ELIGIBILITY_CRITERIA.some((c) => asEligibilityList(e[c.key]).length > 0);
}

/** The fact on `facts` that criterion `key` is compared against. One place, so the matcher stays flat. */
function factFor(key: ReplacementEligibilityKey, facts: ReplacementEligibilityFacts): string | null {
  switch (key) {
    case 'companyIds':
      return facts.companyId;
    case 'employmentTypes':
      return facts.employmentType;
    case 'departmentIds':
      return facts.departmentId;
    case 'divisions':
      return facts.division;
    case 'positionIds':
      return facts.positionId;
    case 'gradeIds':
      return facts.gradeId;
    case 'employmentCategories':
      return facts.employmentCategory;
    case 'employmentIds':
      return facts.employmentId;
  }
}

/**
 * THE RESOLUTION RULE, stated once because the plan did not settle it and the two readings differ.
 *
 *   1. Nothing selected anywhere ⇒ EVERYONE may submit. (The house "empty means everyone" rule, and the
 *      only safe default for a switch that is off until an admin turns it on.)
 *   2. Otherwise, an employee qualifies if EITHER
 *        (a) they are NAMED individually — `employmentIds` contains their employment; OR
 *        (b) at least one ORG criterion is set AND they match ALL the set ones.
 *
 * Named individuals therefore WIDEN, they do not narrow. The alternative — AND-ing the individual picker
 * with the org criteria — makes "and also Aisha" silently exclude Aisha whenever she is not in the chosen
 * department, which is the opposite of what naming her means. It also makes the individual picker useless
 * on its own, since AND-ing it with seven empty criteria is the only case where it would do anything.
 *
 * Rule (b)'s "at least one org criterion is set" clause is what stops an individuals-only configuration
 * collapsing into "everyone": with all seven org lists empty, the "match ALL the set ones" test is
 * vacuously TRUE, so without that clause naming three people would admit the entire company.
 *
 * Within one criterion the values are OR'd (any match); across criteria they are AND'd — the same shape
 * `isLeaveEligible` uses, so an admin who has configured leave-type criteria already knows this rule.
 */
export function matchesReplacementEligibility(
  e: ReplacementRequestEligibility | null | undefined,
  facts: ReplacementEligibilityFacts,
): boolean {
  if (!hasAnyReplacementRestriction(e)) return true;
  const elig = e!;

  const named = asEligibilityList(elig.employmentIds);
  if (named.length > 0 && named.includes(facts.employmentId)) return true;

  let anyOrgCriterionSet = false;
  for (const c of REPLACEMENT_ORG_CRITERIA) {
    const allowed = asEligibilityList(elig[c.key]);
    if (allowed.length === 0) continue;
    anyOrgCriterionSet = true;
    // A null fact can never be in a non-empty allow-list, so an employee with no assignment as of the
    // date (or no grade) is correctly refused by a criterion that names one — never accidentally admitted.
    const fact = factFor(c.key, facts);
    if (fact == null || !allowed.includes(fact)) return false;
  }
  return anyOrgCriterionSet;
}

/**
 * Read one employee's eligibility facts AS OF a date, inside an open transaction.
 *
 * THE ASSIGNMENT JOIN IS THE WHOLE POINT. `assignment` is CLOSE+INSERT bitemporal: `superseded_at IS NULL`
 * selects the current RECORDING of a row, and `valid_from <= asOf AND (valid_to IS NULL OR valid_to >=
 * asOf)` selects the version that was in FORCE on the date asked about. Ordering by `valid_from DESC` and
 * taking one row makes overlapping open-ended rows resolve to the latest-starting one rather than an
 * arbitrary one — the same tie-break the rest of the codebase uses for dated rows.
 *
 * A LEFT JOIN, not an inner one: an employee whose assignment history does not cover `asOf` (hired later,
 * or a gap) must come back with NULL facts and be REFUSED by any criterion that names a department — not
 * vanish from the result set, which would be indistinguishable from "no such employee" at the call site.
 *
 * RLS applies: this runs on the caller's transaction, so an employee resolving their own eligibility sees
 * only their own row, and that is sufficient — the only employment id ever passed here is one the caller
 * already holds.
 */
export async function resolveEligibilityFactsTx(
  tx: Tx,
  employmentId: string,
  asOf: string,
): Promise<ReplacementEligibilityFacts | null> {
  const [row] = await tx
    .select({
      employmentId: employment.id,
      companyId: employment.companyId,
      gradeId: employment.gradeId,
      division: employment.orgDivision,
      employmentCategory: employment.employmentCategory,
      employmentType: assignment.employmentType,
      departmentId: assignment.departmentId,
      positionId: assignment.positionId,
    })
    .from(employment)
    .leftJoin(
      assignment,
      and(
        eq(assignment.employmentId, employment.id),
        isNull(assignment.supersededAt),
        lte(assignment.validFrom, asOf),
        or(isNull(assignment.validTo), sql`${assignment.validTo} >= ${asOf}`),
      ),
    )
    .where(eq(employment.id, employmentId))
    .orderBy(desc(assignment.validFrom))
    .limit(1);
  if (!row) return null;
  return {
    employmentId: row.employmentId,
    companyId: row.companyId ?? null,
    employmentType: row.employmentType ?? null,
    departmentId: row.departmentId ?? null,
    positionId: row.positionId ?? null,
    gradeId: row.gradeId ?? null,
    division: row.division ?? null,
    employmentCategory: row.employmentCategory ?? null,
  };
}

/** Resolve the facts and apply the rule in one call — the shape both gates (UI + service) use. */
export async function isReplacementRequestEligibleTx(
  tx: Tx,
  p: { employmentId: string; asOf: string; eligibility: ReplacementRequestEligibility | null | undefined },
): Promise<boolean> {
  // Short-circuit before the query: an unrestricted policy admits everyone and needs no facts at all.
  if (!hasAnyReplacementRestriction(p.eligibility)) return true;
  const facts = await resolveEligibilityFactsTx(tx, p.employmentId, p.asOf);
  if (!facts) return false;
  return matchesReplacementEligibility(p.eligibility, facts);
}

/**
 * Normalise a posted criteria object for storage: trim, de-duplicate, drop blanks, drop empty lists, and
 * collapse an entirely-empty object to NULL so "no restriction" has ONE representation in the column
 * rather than two ({} and NULL) that `hasAnyReplacementRestriction` would have to keep agreeing about.
 *
 * Values are NOT validated against their catalogues, matching `cleanOrgEligList`'s deliberate tolerance in
 * core/admin.ts: a department that is later archived must keep restricting the rule that names it, and
 * must survive a re-save of the form rather than being silently dropped on the way through.
 */
export function cleanReplacementEligibility(
  e: ReplacementRequestEligibility | null | undefined,
): ReplacementRequestEligibility | null {
  if (e == null) return null;
  const out: ReplacementRequestEligibility = {};
  for (const c of REPLACEMENT_ELIGIBILITY_CRITERIA) {
    const list = [...new Set(asEligibilityList(e[c.key]).map((v) => String(v).trim()))].filter((v) => v !== '');
    if (list.length > 0) out[c.key] = list;
  }
  return Object.keys(out).length === 0 ? null : out;
}
