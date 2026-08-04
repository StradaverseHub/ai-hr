/**
 * "WHO DOES THIS APPLY TO" — ONE resolver, for every caller that needs a set of employments.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────────────────────────────
 * The set resolver was written for bulk leave adjustments (491c499f) and lived inside
 * `core/leave-adjustment.ts` as `resolveAdjustmentTargets`. The Notice Board (6e122302) needs exactly the
 * same question answered — company / department / employment type plus the eight Organisation-Assignment
 * axes, resolved AS AT a date — and copying it would have produced two implementations of the single most
 * consequential predicate in the product: who a bulk action reaches. Feedback item 6e9a126e exists because
 * of duplicate-maintenance defects of precisely this shape, and the approved plan for the Notice Board says
 * so in as many words: "Generalise the criteria resolver out of the leave-adjustment module rather than
 * copying it".
 *
 * So the BODY moved here, unchanged, and `core/leave-adjustment.ts` keeps `resolveAdjustmentTargets` /
 * `countAdjustmentTargets` as thin delegates. That is deliberate rather than lazy: the adjustment module's
 * existing callers, its error text and `test/leave-adjustment-batch.test.ts` are untouched, so the leave
 * behaviour is provably byte-identical while the notice path gets the same engine rather than a cousin.
 *
 * ── THE SEMANTICS, RESTATED (they are load-bearing and were copied from `isLeaveEligible`) ─────────────
 *   • OR within a field  — `companyIds: [A, B]` matches an employment in A or in B.
 *   • AND across fields  — company AND department AND grade… every named axis must match.
 *   • An EMPTY field means NO RESTRICTION on that axis.
 *
 * ⚠️ THEREFORE AN EMPTY CRITERIA OBJECT MATCHES EVERY ACTIVE EMPLOYMENT. That is genuinely what "no
 * restrictions" means, and it is also how somebody sends a notice to the entire group by accident. The
 * resolver does NOT second-guess an explicit request — every caller is responsible for showing the resolved
 * count and making the user confirm it. `countOrgCriteriaTargets` is that count.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────────────────────────────────
 * Gender and marital status live on `person`, not `employment`, and are read through the leave-eligibility
 * JSONB rather than as selection criteria. They stay out: selecting a bulk action's audience by a protected
 * characteristic is a decision that must be asked for explicitly, not inherited by accident from a builder
 * that happens to expose the field. (Carried over verbatim from the adjustment module's note.)
 */
import { and, gte, inArray, isNull, or, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { withTenant, type SessionContext } from '../db/client';
import { assignment, employment } from '../db/schema';
import { ORG_ASSIGNMENT_CRITERIA, type OrgAssignmentCriterionKey } from './leave-org-criteria';

/**
 * The criteria vocabulary. Three typed axes (`company` / `department` / `employment type`) plus the eight
 * profile-option Organisation Assignment axes from `ORG_ASSIGNMENT_CRITERIA`, whose keys are ALSO the
 * `employment` column names — see core/leave-org-criteria.ts for why that identity holds.
 */
export type OrgCriteria = {
  companyIds?: string[];
  departmentIds?: string[];
  employmentTypes?: string[];
} & Partial<Record<OrgAssignmentCriterionKey, string[]>>;

const nonEmpty = (v: string[] | undefined): string[] => (Array.isArray(v) ? v.filter((x) => !!x) : []);

/** Every criteria field name, in posting order — the one list a form and an action agree on. */
export const ORG_CRITERIA_FIELDS: readonly string[] = [
  'companyIds',
  'departmentIds',
  'employmentTypes',
  ...ORG_ASSIGNMENT_CRITERIA.map((c) => c.key),
];

/**
 * Read a criteria object out of a posted form, given a `getAll`-shaped accessor.
 *
 * Pure and DB-free on purpose: it takes the accessor rather than a `FormData` so it can be unit-tested
 * without a request, and so both the Leave Adjustments action and the Notice Board action read the SAME
 * field names. Two hand-rolled readers is how the two screens' criteria quietly stop meaning the same
 * thing.
 */
export function orgCriteriaFromFields(getAll: (name: string) => string[]): OrgCriteria {
  const out: OrgCriteria = {};
  for (const field of ORG_CRITERIA_FIELDS) {
    const vals = nonEmpty(getAll(field));
    if (vals.length) (out as Record<string, string[]>)[field] = vals;
  }
  return out;
}

/** True when no axis is restricted — i.e. this criteria object means EVERYONE. Callers must warn on it. */
export function isUnrestrictedOrgCriteria(criteria: OrgCriteria | null | undefined): boolean {
  const c = criteria ?? {};
  return ORG_CRITERIA_FIELDS.every((f) => nonEmpty((c as Record<string, string[] | undefined>)[f]).length === 0);
}

/**
 * THE SET RESOLVER. Which employments match `criteria`, as at `asOf` (an ISO `YYYY-MM-DD` date)?
 *
 * Terminated employments are excluded as of `asOf`, and so are employments not yet hired by then: someone
 * who had already left, or had not yet started, is not a target.
 *
 * ⚠️ DEPARTMENT AND EMPLOYMENT TYPE ARE NOT ON `employment` — they live on `assignment`, which is
 * EFFECTIVE-DATED (validFrom / validTo, null = current). So they are matched against the assignment in force
 * ON `asOf`, not today's. An action backdated to before somebody transferred must select the people who were
 * in that department THEN; using the current row would quietly act on a different set of people from the one
 * the administrator described.
 *
 * Returns employment ids ordered by id, so a resolution is deterministic and two runs are comparable.
 */
export async function resolveOrgCriteriaTargets(
  tx: Tx,
  p: { criteria: OrgCriteria; asOf: string },
): Promise<string[]> {
  const c = p.criteria ?? {};
  const conds = [
    // Active as of the date — hired by then, and not already gone.
    sql`${employment.hiredOn} <= ${p.asOf}`,
    or(isNull(employment.terminatedOn), gte(employment.terminatedOn, p.asOf)),
  ];

  const companyIds = nonEmpty(c.companyIds);
  if (companyIds.length) conds.push(inArray(employment.companyId, companyIds));

  const departmentIds = nonEmpty(c.departmentIds);
  const employmentTypes = nonEmpty(c.employmentTypes);
  if (departmentIds.length || employmentTypes.length) {
    const asOfAssignment = [
      sql`${assignment.employmentId} = ${employment.id}`,
      sql`${assignment.validFrom} <= ${p.asOf}`,
      or(isNull(assignment.validTo), gte(assignment.validTo, p.asOf)),
    ];
    if (departmentIds.length) asOfAssignment.push(inArray(assignment.departmentId, departmentIds));
    if (employmentTypes.length) asOfAssignment.push(inArray(assignment.employmentType, employmentTypes as never[]));
    conds.push(sql`exists (select 1 from ${assignment} where ${and(...asOfAssignment)})`);
  }

  // The eight org-assignment axes are text columns on employment; the key IS the column name (see
  // core/leave-org-criteria.ts, which exists so clients and services agree on that without a DB import).
  for (const crit of ORG_ASSIGNMENT_CRITERIA) {
    const allowed = nonEmpty(c[crit.key]);
    if (allowed.length) conds.push(inArray(employment[crit.key], allowed));
  }

  const rows = await tx
    .select({ id: employment.id })
    .from(employment)
    .where(and(...conds))
    .orderBy(employment.id);
  return rows.map((r) => r.id);
}

/**
 * How many employments a set of criteria resolves to — the number a screen MUST show before it lets anyone
 * press the button. `resolveOrgCriteriaTargets` deliberately does not second-guess an empty criteria object,
 * so this is the thing that stops "no restrictions" becoming an accidental whole-organisation broadcast.
 */
export async function countOrgCriteriaTargets(
  ctx: SessionContext,
  p: { criteria: OrgCriteria; asOf: string },
): Promise<number> {
  return withTenant(ctx, async (tx) => (await resolveOrgCriteriaTargets(tx, p)).length);
}
