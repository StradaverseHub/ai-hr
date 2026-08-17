/**
 * GRADE GROUPS ⇄ JOB GRADES, as pure set arithmetic — the one place the expansion is defined.
 *
 * ── WHY EXPANSION AND NOT A NEW AXIS ──────────────────────────────────────────────────────────────────
 * Employee Eligibility stores WHO a rule covers in `entitlement_eligibility_rule.criteria`, whose grade
 * axis is `gradeIds` — individual job grades. The approved plan adds a Grade Group picker to that screen
 * and stores the SAME axis: picking a group fills in its member grades. No `gradeGroupIds` axis is added
 * to the criteria vocabulary, and that is a decision with a reason, not a shortcut:
 *
 *   - core/org-criteria.ts's `ORG_CRITERIA_FIELDS` is the contract every criteria form, the resolver and
 *     the live audience count share. A name that is not on it renders, posts and narrows NOBODY, silently
 *     (that file's own header). Adding one means teaching the resolver, the approval-template translator,
 *     the specificity ranking and every consumer of the vocabulary at the same time.
 *   - core/leave-approval-template.ts already REFUSES to assign an approval template to a rule whose named
 *     grades cover only PART of a grade group, and its assignable axes are exactly
 *     {companyIds, employmentTypes, gradeIds}. A selection that is by construction whole groups satisfies
 *     both conditions — which is why picking groups fixes the "not assignable" badge the reporter hit,
 *     as a consequence of the storage choice rather than as separate work.
 *
 * ── THE TRADE-OFF, STATED RATHER THAN HIDDEN ──────────────────────────────────────────────────────────
 * Expansion SNAPSHOTS the membership. A rule saved as "GRADE 12-18 (CONTRACT)" stores that group's seven
 * grades; if an eighth grade joins the group later, the saved rule keeps covering seven. Nothing throws and
 * nothing on the rule says so. That is what `partiallyCoveredGradeGroups` is for: the drift is DERIVABLE
 * from the stored grades alone, so the eligibility screen can list the rules it has happened to instead of
 * letting them quietly disagree with the group they were built from. Held-back membership is the same shape
 * the approval-template translator already refuses on, so the two surfaces name the same rules.
 *
 * Pure, DB-free and dependency-free on purpose: a SERVER component (the rules table) and a CLIENT component
 * (the rule form) both need this arithmetic, and one definition is what stops "whole group" meaning two
 * different things on the two halves of the same screen.
 */

/** A grade group as both surfaces receive it: identity, the operator's own name, and its member grades. */
export type GradeGroupOption = { id: string; name: string; gradeIds: string[] };

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/** Every job grade held by any of `groupIds`, de-duplicated, in group-then-member order. */
export function memberGradeIds(groupIds: readonly string[], groups: readonly GradeGroupOption[]): string[] {
  const wanted = new Set(groupIds);
  return uniq(groups.filter((g) => wanted.has(g.id)).flatMap((g) => g.gradeIds));
}

/**
 * The groups `gradeIds` covers COMPLETELY — every member named, none left out.
 *
 * This is the derivation that lets the Grade Group picker re-open a saved rule without storing anything
 * extra: a group is ticked when the rule already names all of it. An EMPTY group is never "covered" — it
 * would otherwise be reported as selected on every rule in the tenant, including rules that narrow by no
 * grade at all.
 */
export function wholeGradeGroupIds(
  gradeIds: readonly string[],
  groups: readonly GradeGroupOption[],
): string[] {
  const named = new Set(gradeIds);
  return groups.filter((g) => g.gradeIds.length > 0 && g.gradeIds.every((id) => named.has(id))).map((g) => g.id);
}

/**
 * The groups `gradeIds` covers only PART of — some members named, some not.
 *
 * Two things produce this and both deserve to be visible: a rule whose grades were picked one at a time and
 * happen to straddle a group, and a rule built FROM a group that has since gained a member (the snapshot
 * trade-off in this file's header). Either way the rule cannot be assigned to an approval template, and
 * `core/leave-approval-template.ts` refuses it in those words.
 */
export function partiallyCoveredGradeGroups(
  gradeIds: readonly string[],
  groups: readonly GradeGroupOption[],
): GradeGroupOption[] {
  const named = new Set(gradeIds);
  return groups.filter(
    (g) => g.gradeIds.some((id) => named.has(id)) && g.gradeIds.some((id) => !named.has(id)),
  );
}

/**
 * The new grade selection after the operator changed which GROUPS are picked.
 *
 * Ticking a group ADDS its members; unticking one REMOVES its members — and nothing else. Grades that
 * belong to no group, or that a still-ticked group also holds, survive untouched, because "keep picking
 * individual grades available for the cases where a group is not the right shape" is in the approved plan
 * and a group control that wiped a hand-built selection would make that impossible.
 *
 * The removal is computed from the groups that were ticked BEFORE, so it can only ever take back grades
 * this control itself put in. That is what makes the two directions symmetrical: tick then untick returns
 * the selection to what it was.
 */
export function applyGradeGroupSelection(p: {
  gradeIds: readonly string[];
  previousGroupIds: readonly string[];
  nextGroupIds: readonly string[];
  groups: readonly GradeGroupOption[];
}): string[] {
  const next = new Set(p.nextGroupIds);
  const dropped = p.previousGroupIds.filter((id) => !next.has(id));
  const removed = new Set(memberGradeIds(dropped, p.groups));
  const added = memberGradeIds(p.nextGroupIds, p.groups);
  const addedSet = new Set(added);
  // A grade a dropped group held is only really dropped when no still-ticked group holds it too.
  const kept = p.gradeIds.filter((id) => !removed.has(id) || addedSet.has(id));
  return uniq([...kept, ...added]);
}
