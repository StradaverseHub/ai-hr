/**
 * r287 (ff1c935f) — "WHO DOES THIS RUN COVER", when it is named PERSON BY PERSON: the one merge rule.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────────────────────────────
 * "Pick individually" now has TWO ways in and must produce ONE list out:
 *   · the PICKER — `MultiSelectPopover`, posting one hidden `employmentIds` input per chosen employment;
 *   · the PASTE box — `employmentIdsRaw`, a free-text block of employment ids separated by whitespace or
 *     commas. It is how a bulk run is set up today and deleting it would be an unrequested regression.
 *
 * The list is read in TWO places that must never disagree: the client's live preview (which asks the
 * server "who does this currently resolve to?") and `openLeaveYearAction` (which performs the run). If
 * those two parse the two fields differently, the screen confirms one population and the sweep grants to
 * another — and every test of either half passes. CLAUDE.md §8 names that class directly: "when a defect
 * lives in the contract between two files, pin it across both". So the parse lives here, once, and both
 * sides call it.
 *
 * DELIBERATELY DEPENDENCY-FREE — no React, no `next/*`, no db — for the same reason `lib/employee-search.ts`
 * is: a client island, a server action and a plain unit test all import it without a cycle and without
 * dragging anything into a bundle.
 *
 * ⚠️ IT VALIDATES NOTHING, AND THAT IS THE POINT. These ids are a RESTRICTION handed to
 * `resolveOrgCriteriaTargets`, which decides who actually qualifies under the session's own scope and the
 * run's as-at date. Filtering here to "ids that look right" would be a second, weaker authority sitting in
 * front of the real one — and it would silently drop a typo rather than letting it resolve to nobody.
 */

/** Split the paste box the way it has always been split: on any run of whitespace and/or commas. */
export function parsePastedEmploymentIds(raw: string | null | undefined): string[] {
  return String(raw ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

/**
 * The picked ids and the pasted ids as ONE list, de-duplicated, first occurrence wins.
 *
 * ORDER IS PICKED-THEN-PASTED and is not meaningful downstream: `resolveOrgCriteriaTargets` uses the list
 * as an `IN (…)` restriction, so the RESOLVED population is identical however the same ids are ordered.
 * A stable order is kept anyway so the live preview does not re-ask the server for a set it already has.
 *
 * DE-DUPLICATION IS WHY THIS IS A MERGE AND NOT A CONCATENATION: the same person picked in the popover and
 * also present in a pasted block must appear ONCE. (`core/leave-generation.ts` dedupes again on the way
 * in — a second, independent belt, not a reason to skip this one: the count this screen SHOWS is computed
 * from what is merged here.)
 */
export function mergeEmploymentSelection(
  picked: readonly string[],
  pastedRaw: string | null | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...picked.map(String).filter(Boolean), ...parsePastedEmploymentIds(pastedRaw)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * ── r288 (8521e160) — ONE EMPLOYMENT, AS A PICKER NEEDS IT ────────────────────────────────────────────
 *
 * Declared HERE rather than in any one screen because three screens now mount the same picker over the
 * same population — Generate Entitlement (r287), Leave Adjustments and Notice Board's individual-target
 * mode — and a fourth copy of this three-field row is a fourth thing to keep in step with `listEmployees`.
 * `components/leave/generate-form.tsx` re-exports it under the name r287 gave it so its importers are
 * undisturbed.
 *
 * THREE PLAIN FIELDS, NOTHING FORMATTED, AND THAT IS THE POINT. Every one of the three screens is a CLIENT
 * island mounted from a SERVER page. r123/r124 took tabs down in production by handing a client component a
 * server closure and `test/server-client-boundary.test.ts` pins that class, so the server page hands over
 * DATA and each form composes the sentences it shows on its own side of the boundary.
 *
 * `employeeCode` is nullable because the column is (`db/schema.ts` `employment.employee_code`): a tenant
 * that has not adopted Employee IDs must still be able to pick people by name, and a chip must read
 * "Nadia Rahim" rather than "Nadia Rahim · null".
 */
export type EmployeePickOption = { id: string; name: string; employeeCode: string | null };
