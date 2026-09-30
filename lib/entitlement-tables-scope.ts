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

/**
 * 3a4efe9f (r369) — WHICH LEAVE TYPE IS IN VIEW: the host's, the operator's, or none.
 *
 * Two sources of scope now exist and they are not equals. `leaveTypeId` is a HOST DECISION — the leave
 * type screen's tab 3 is about one type and always was, and nothing an operator does on that tab can widen
 * it. `typeFilter` is a READER'S CHOICE, arriving as `?leaveType=<id>` on the Entitlement tables tab and
 * cleared from the same place. The host wins, because a filter inside a tab that is already about one leave
 * type could only ever contradict its own heading.
 *
 * ⚠️ WHY THIS IS A FUNCTION WITH TESTS AND NOT A `??` IN THE COMPONENT. The answer decides whether the
 * create form's reach warning can be worded at all. That warning is the only notice that adding a SECOND
 * table to a leave type ends the sole-table fallback — after which neither table resolves for anybody until
 * a rule or a default names one — and it is gated on exactly one leave type being in view. So "does the
 * filter produce a scope?" is a load-bearing question about who gets leave days, not a rendering detail,
 * and it is pinned here rather than asserted through a server component that cannot be mounted in vitest.
 *
 * ⚠️ AN UNKNOWN id RESOLVES TO NO SCOPE, NEVER TO AN EMPTY SCREEN. A bookmark naming a leave type that has
 * since been deleted would otherwise scope the mount to a type that cannot be found, which is the r270 edge
 * case that rendered an empty "No active leave types" card and dropped the Leave type column at the same
 * time. Falling back to every-type is the reading a stale link deserves. The empty string — what the
 * filter's own "All leave types" option posts — resolves the same way.
 *
 * @param known  every leave type the page loaded, archived ones included: an archived type still owns the
 *               tables it owned, so filtering to one has to keep working.
 */
export function resolveViewLeaveTypeId(args: {
  leaveTypeId?: string;
  typeFilter?: string;
  known: readonly { id: string }[];
}): string | undefined {
  if (args.leaveTypeId != null) return args.leaveTypeId;
  if (!args.typeFilter) return undefined;
  return args.known.some((x) => x.id === args.typeFilter) ? args.typeFilter : undefined;
}
