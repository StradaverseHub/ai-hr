/**
 * ee6b7c69 — WHICH ENTITLEMENT TABLES AND ELIGIBILITY RULES BELONG TO ONE LEAVE TYPE.
 *
 * The Entitlement Tables block has two mount points: the standalone screen, which shows every leave type
 * side by side, and each leave type's Entitlement step, which shows only its own. Both read the SAME
 * page-level load and slice it here — no second query, and no N+1 across the two dozen panels the
 * Entitlements page composes.
 *
 * ⚠️ AN ELIGIBILITY RULE CARRIES NO LEAVE TYPE. It names a template LINEAGE and nothing else, so "this
 * type's rules" can only be derived: a rule belongs to a type exactly when the lineage it points at does.
 * That is the whole reason this is a named function with its own tests rather than two inline `filter`s —
 * a rule filtered on a field it does not have would quietly resolve to an empty list, and an Entitlement
 * step showing "no eligibility rules" over rules that exist is worse than one showing all of them.
 *
 * ⚠️ THE LINEAGE SET IS BUILT FROM EVERY TEMPLATE VERSION, NOT THE RUNNING ONES. A table that has been
 * stopped from a date still owns its lineage and its rules, and those rules still have to be visible to
 * the step that owns them — the alternative is a rule that vanishes from every screen the moment its
 * template is retired, while still sitting in the database pointing at it.
 *
 * PURE. No database, no session, no translator: this is the one piece of the block that has behaviour
 * worth pinning, and it is testable without rendering a server component or standing up Postgres.
 */

/** The minimum a template must carry to be scoped — `EntitlementTemplateRow` satisfies it. */
export type ScopableTemplate = { lineageId: string; leaveTypeId: string };
/** The minimum a rule must carry — `EligibilityRuleRow` satisfies it. */
export type ScopableRule = { templateLineageId: string };

/**
 * @param leaveTypeId  undefined ⇒ the unfiltered standalone screen: everything, untouched.
 */
export function scopeEntitlementTables<T extends ScopableTemplate, R extends ScopableRule>(
  all: { templates: readonly T[]; rules: readonly R[] },
  leaveTypeId: string | undefined,
): { templates: T[]; rules: R[] } {
  if (leaveTypeId == null) return { templates: [...all.templates], rules: [...all.rules] };
  const templates = all.templates.filter((x) => x.leaveTypeId === leaveTypeId);
  const ownLineages = new Set(templates.map((x) => x.lineageId));
  return { templates, rules: all.rules.filter((r) => ownLineages.has(r.templateLineageId)) };
}
