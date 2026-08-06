/**
 * THE ONE DECLARATION OF WHAT REFERENCES A LEAVE TYPE (items 1ae7f3ab + 4fdb69b2, built as one change).
 *
 * ## Why this file exists at all
 *
 * There were two hand-written lists of "what makes a leave type in use", and they had drifted:
 * `deleteLeaveType` counted FIVE tables, `listLeaveTypes`' `inUse` predicate counted THREE, and the
 * database actually carries TWELVE foreign keys to `leave_type`. So the panel offered Delete on a type
 * Postgres would refuse, and the admin got a raw 23503 instead of an explanation. That is exactly the
 * hazard `core/read.ts` documents for job grades, where the rule written down at the time was that the
 * button predicate and the delete guard must stay byte-identical.
 *
 * Fixing the arithmetic in both places would have reset the clock, not stopped it. **The duplication was
 * the defect**, so there is now ONE list and both sides are generated from it.
 *
 * ## The list was WRONG when this was planned, and that is the point
 *
 * Both approved plans and HANDOFF.md said ELEVEN tables. Enumerated from `information_schema` on
 * production 2026-08-05 there are **TWELVE**: `leave_generation_run_item` reached the schema with
 * `6e9a126e` release two, after the plans were written, and nobody's list caught up. A thirteenth will
 * appear the same way. That is why `test/leave-type-referrers.test.ts` reads the live foreign keys out of
 * the test database and fails if they are not exactly the set declared here — **a new table referencing
 * `leave_type` breaks the suite until someone comes here and decides what deleting should do about it.**
 * Do not "fix" that test by widening it; adding the row here IS the fix, and it takes ten seconds.
 *
 * ## The three dispositions, and why history is not cascaded
 *
 * The reporter asked for a cascade: "automatically remove all approval workflow references, balance
 * source mappings, entitlement mappings, and any other backend dependencies". They were asking about
 * CONFIGURATION. Nobody asked to erase leave people actually took, so:
 *
 * - `history` — REFUSES the delete. These rows are evidence: leave that was applied for, balance that
 *   moved, encashment that was paid, an audit trail, a generation run's output. Archive exists for types
 *   in this state and the panel offers it.
 * - `config`  — deleted WITH the type, inside one transaction. Policies, approval rules, entitlement
 *   tables, scheme mappings, shared-group membership: all of it is setup that only means anything while
 *   the type exists.
 * - `self`    — `leave_type.balance_source_type_id`, the self-reference and the easiest of the twelve to
 *   miss. It is NULLED on the OTHER type, never cascaded. Deleting Caregiver Leave because it happened to
 *   draw its balance from Special Leave would be catastrophic and is obviously not what was asked.
 *
 * `entitlement_eligibility_rule` is in the list WITHOUT a foreign key to `leave_type`: it reaches the type
 * through `template_lineage_id`, so the FK enumeration cannot see it, and deleting a template while its
 * rules survive would strand them. It is marked `viaTemplateLineage` and must be deleted FIRST, before the
 * templates it points at. The drift test knows to expect it as a declared extra rather than an FK.
 */

/** What deleting the leave type should do about rows in a referring table. */
export type LeaveTypeRefDisposition = 'history' | 'config' | 'self';

export type LeaveTypeRef = {
  /** Physical table name — matched against `information_schema` by the drift test. */
  table: string;
  /** The referring column. */
  column: string;
  disposition: LeaveTypeRefDisposition;
  /**
   * True when this table has NO foreign key to `leave_type` and is reached through the template lineage
   * instead. The drift test excludes these from the FK comparison; the cascade still has to handle them.
   */
  viaTemplateLineage?: true;
  /** Why it carries the disposition it does — read by whoever adds the thirteenth. */
  note: string;
};

/**
 * Every table that references a leave type. Enumerated from the live schema, not from memory.
 *
 * Order matters for `config`: rows are deleted in the order declared, so a child must precede its parent.
 * `entitlement_eligibility_rule` therefore comes before `entitlement_template`.
 */
export const LEAVE_TYPE_REFERRERS: readonly LeaveTypeRef[] = [
  // ── history: the delete is refused while any of these hold a row ────────────────────────────────────
  {
    table: 'leave_request',
    column: 'leave_type_id',
    disposition: 'history',
    note: 'Leave somebody applied for. Erasing it would erase the application, not a setting.',
  },
  {
    table: 'leave_ledger',
    column: 'leave_type_id',
    disposition: 'history',
    note: 'Every movement of a balance. This is the entitlement audit trail.',
  },
  {
    table: 'leave_encashment_snapshot',
    column: 'leave_type_id',
    disposition: 'history',
    note: 'Encashment that was PAID. Money that has left the building is not configuration.',
  },
  {
    table: 'leave_entitlement_recalc_audit',
    column: 'leave_type_id',
    disposition: 'history',
    note: 'Why a balance was recalculated, and by what. 71 rows on production — deleting them would remove the explanation for figures employees can still see.',
  },
  {
    table: 'leave_generation_run_item',
    column: 'leave_type_id',
    disposition: 'history',
    note: 'What a leave-generation run produced. THE TWELFTH TABLE — it arrived with 6e9a126e release two and every hand-written list missed it.',
  },
  {
    table: 'replacement_leave_request',
    column: 'leave_type_id',
    disposition: 'history',
    note: 'An employee-submitted replacement-leave claim. A request, not a setting.',
  },

  // ── config: deleted with the type, in this order ────────────────────────────────────────────────────
  {
    table: 'entitlement_eligibility_rule',
    column: 'template_lineage_id',
    disposition: 'config',
    viaTemplateLineage: true,
    note: 'Reached through the template lineage, NOT by a foreign key to leave_type. Must be deleted BEFORE entitlement_template or it is stranded.',
  },
  // 6e9a126e RELEASE THREE — `leave_policy` and `scheme_leave_entitlement` were REMOVED from this
  // list because migration 0405 drops the tables. This is not bookkeeping: core/admin.ts turns every
  // entry here into `delete from <table>` through sql.identifier, so a declaration naming a dropped
  // table makes deleteLeaveType throw `relation "leave_policy" does not exist` for EVERY leave type.
  // test/leave-type-referrers.test.ts compares this list against the LIVE foreign keys in BOTH
  // directions, which is what makes that impossible to forget rather than a silent lost guard.
  {
    table: 'entitlement_template',
    column: 'leave_type_id',
    disposition: 'config',
    note: 'The new entitlement layer (6e9a126e). Belongs to exactly one leave type.',
  },
  {
    table: 'leave_approval_policy',
    column: 'leave_type_id',
    disposition: 'config',
    note: 'Approval routing. This is what Special Leave had two of, and what made Delete fail at the last moment.',
  },
  {
    table: 'leave_shared_group_member',
    column: 'leave_type_id',
    disposition: 'config',
    note: 'Membership of a shared-balance group. Removing the type removes its membership, not the group.',
  },

  // ── self: nulled on the OTHER type, never cascaded ──────────────────────────────────────────────────
  {
    table: 'leave_type',
    column: 'balance_source_type_id',
    disposition: 'self',
    note: 'Another type draws its balance FROM this one (Caregiver Leave points at Special Leave on production). NULL it there; deleting that type instead would be catastrophic.',
  },
];

/** The referrers that REFUSE a delete. */
export const historyReferrers = (): LeaveTypeRef[] =>
  LEAVE_TYPE_REFERRERS.filter((r) => r.disposition === 'history');

/** The referrers cascaded with the type, in declaration order (children before parents). */
export const configReferrers = (): LeaveTypeRef[] =>
  LEAVE_TYPE_REFERRERS.filter((r) => r.disposition === 'config');

/**
 * The `inUse` predicate, as raw SQL, for a leave type identified by `idExpr`.
 *
 * ## What `inUse` MEANS changed with 4fdb69b2, deliberately
 *
 * It used to mean "anything at all points at this type". It now means "this type has HISTORY" — because
 * configuration no longer blocks a delete, it is cascaded. So the panel offers Delete exactly when the
 * delete will succeed, which is the whole point of both items. A type carrying only approval rules and
 * policies is now deletable and shows Delete; a type somebody has taken leave under shows Archive.
 *
 * `historyReferrers()` is the ONLY source of tables here. Both this and `deleteLeaveType`'s guard read it,
 * so they cannot disagree — which is the invariant `test/leave-type-referrers.test.ts` pins.
 *
 * `idExpr` is interpolated as a raw column reference (e.g. `leave_type.id`), never as user input.
 */
export function leaveTypeInUseSqlText(idExpr: string): string {
  return historyReferrers()
    .map((r, i) => `exists (select 1 from ${r.table} r${i} where r${i}.${r.column} = ${idExpr})`)
    .join('\n          or ');
}
