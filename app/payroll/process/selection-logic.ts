/**
 * Pure, DB-free logic shared by the Payroll Process wizard's client components and its tests. Kept in a
 * module with no server-only imports so it is safe to import from a `'use client'` component AND unit-test
 * directly (no DOM harness). Three rules live here:
 *   1. resumeHref — a DRAFT batch resumes into the wizard; a processed/closed batch keeps its direct
 *      read-only link.
 *   2. materializeToggle — deselecting a single row from the WHOLE-COMPANY DEFAULT (nothing touched, no
 *      filter active, every visible row shown checked) must yield "everyone visible except that one", not a
 *      singleton {id}. See the checkbox-bug fix in step-selection.tsx.
 *   3. wizardInitialStep — resume opens on Step 1 (Payroll Period & Company REVIEW, read-only identity),
 *      not straight on Employee Selection (feedback 4f00d8f0).
 */

/** The row-link / resume-link target for a batch by status. Draft ⇒ wizard resume; else ⇒ direct view. */
export function resumeHref(batchId: string, status: string): string {
  return status === 'draft' ? `/payroll/process?resume=${batchId}` : `/payroll/${batchId}`;
}

/**
 * The wizard's entry step (0-based). BOTH the fresh-run and the RESUME flow open on Step 1 (index 0):
 * feedback 4f00d8f0 requires that selecting a Draft payroll process "return the user to Step 1 (Payroll
 * Period & Company Selection) to review" — the resume flow previously jumped straight to Employee
 * Selection (index 1). In resume mode Step 1 renders the draft's fixed identity READ-ONLY (changing
 * period/company on an existing draft is a delete-and-recreate concern, not an in-place edit); the
 * parameter exists so this rule is unit-pinned for both cases against a regression back to `isResume ? 1 : 0`.
 */
export function wizardInitialStep(isResume: boolean): number {
  void isResume;
  return 0;
}

/**
 * Compute the next explicit selection set after toggling one row, correctly materialising the whole-company
 * default on the first touch.
 *
 * @param id            the employment id whose checkbox was toggled
 * @param selected      the current explicit selection set
 * @param visibleIds    the ids currently VISIBLE in the (possibly filtered) picker
 * @param filtersTouched  whether the selection has already been materialised (any prior toggle / seed)
 * @param anyFilterActive whether a filter currently narrows the preview
 *
 * When neither `filtersTouched` nor `anyFilterActive` holds, the picker renders every visible row CHECKED
 * even though `selected` is still empty (the whole-company default). Seeding from `visibleIds` FIRST, then
 * applying the toggle, is what turns "uncheck one" into "everyone except one" instead of a singleton.
 */
export function materializeToggle(
  id: string,
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
  filtersTouched: boolean,
  anyFilterActive: boolean,
): Set<string> {
  const next = filtersTouched || anyFilterActive ? new Set(selected) : new Set(visibleIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
