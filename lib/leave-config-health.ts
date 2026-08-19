/**
 * r209 — WHY A LEAVE TYPE CANNOT PRODUCE A BALANCE, AS A VALUE INSTEAD OF AS A SILENCE.
 *
 * THE FACT THIS FILE EXISTS FOR, measured on production 2026-08-19: the tenant had exactly ONE
 * `entitlement_eligibility_rule`. It pointed at the PERMANENT Medical table and its `valid_to` was
 * **2026-08-13**. From the 14th, no employee resolved to any entitlement template on any leave type, and
 * NOTHING ON ANY SCREEN SAID SO. Six correct Medical tables, five of which had never had a rule at all,
 * sat there unreachable. Separately, `accrual_method` is NULL on four of the six Special Leave types —
 * `leave_type.accrual_unconfigured` has recorded that since 2026-08-04 and, until r209,
 * **no surface read that column**. That is the whole defect: every cause was already recorded, and every
 * one of them was invisible.
 *
 * So this module answers, per leave type, the question the Leave Type screen could not:
 *
 *     is an earning method set? · how many entitlement tables are in force? ·
 *     does any eligibility rule actually point at each of them? · has a rule expired or is one about to? ·
 *     is there a Job Grade that belongs to no table? · is a table's Maximum Balance zeroing it?
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────────────────────
 * It writes nothing and it configures nothing. The editor exists and the customer configures through it;
 * the deliverable here is that the missing configuration is VISIBLE. In particular a Maximum Balance of 0
 * is REPORTED and never reinterpreted — `bandMaxBalance` (core/leave-compute.ts) treats any finite number
 * >= 0 as a real cap and that is deliberate. What was missing is anybody being told.
 *
 * ── THE ONE PIECE OF RESOLUTION LOGIC IT HAS TO MIRROR, AND WHY ────────────────────────────────────
 * `buildTemplateEntitlementResolver` carries the r193 fault-3 gate: a leave type with EXACTLY ONE table in
 * force and NO eligibility rule in force applies that table to everyone, because there is nothing to choose
 * between. A health check that did not know this would report every single-table type as broken — the
 * commonest healthy shape in the product (Hospitalization Leave is exactly it) — and its warnings would be
 * ignored within a day. `soleTableApplies` below is that gate, spelled out, and the tests pin the pair.
 *
 * PURE, DB-free, framework-free: the Entitlement Tables block (a SERVER component) and the health card on
 * the Entitlements page both derive from this, so "this type is blocked" cannot come to mean two things on
 * two halves of the same screen. Substrate: pure derivation, no DomainEvent. // substrate: read-only, no event
 */

/** How many days before an eligibility rule's end date it starts being called out. */
export const RULE_EXPIRY_WARNING_DAYS = 60;

/** The minimum an entitlement table must carry to be judged. `EntitlementTemplateRow` satisfies it. */
export type HealthTemplate = {
  lineageId: string;
  leaveTypeId: string;
  name: string;
  validFrom: string;
  validTo: string | null;
  serviceBands: { days: number; maxBalanceDays?: number | null }[];
};

/** The minimum an eligibility rule must carry. `EligibilityRuleRow` satisfies it (criteria narrowed). */
export type HealthRule = {
  lineageId: string;
  name: string;
  templateLineageId: string;
  validFrom: string;
  validTo: string | null;
  criteria: { gradeIds?: string[] } & Record<string, unknown>;
};

/** One leave type's own configuration, as the leave-type list already holds it. */
export type HealthLeaveType = {
  id: string;
  name: string;
  /** `leave_type.accrual_method` — null ⇒ nothing is granted, however complete the day tables are. */
  accrualMethod: string | null;
  /** `leave_type.accrual_unconfigured` — the marker stamped when the method was left unset (bc36c768).
   *  Populated since 2026-08-04 on this tenant and, until r209, read by nothing. */
  accrualUnconfigured: boolean;
  archived: boolean;
};

/**
 * A named reason a leave type cannot (or may not) produce the balance somebody expects.
 *
 * BLOCKING ones make the figure 0.00 for everybody today. WARNING ones are true of PART of the population
 * or of the near future — a table nobody can reach, a rule about to lapse, a grade that falls through. The
 * split is what stops the card being a wall of amber that nobody reads.
 */
export type LeaveConfigFinding =
  /** BLOCKING — no earning method, so generation grants 0.00 whatever the tables say (bc36c768). */
  | 'no_earning_method'
  /** BLOCKING — no entitlement table in force for this type at all. */
  | 'no_entitlement_table'
  /** BLOCKING — tables are in force and NO rule that could hand one out is, so the resolver returns nothing
   *  for everybody. THE PRODUCTION STATE from 2026-08-14: six Medical tables, one rule, expired. It also
   *  covers the shape where a rule IS in force but points only at a table that has been STOPPED: that rule
   *  matches nobody AND blocks the sole-table fallback (see `soleTableApplies`), so the type grants nothing
   *  either way. (One table and no rule at all is NOT this.) */
  | 'no_rule_in_force'
  /** WARNING — a table in force that no rule in force points at. Nobody can ever receive it. */
  | 'table_without_rule'
  /** WARNING — a rule lineage whose latest version has already ended. It matches nobody from that date. */
  | 'rule_expired'
  /** WARNING — a rule lineage that ends within `RULE_EXPIRY_WARNING_DAYS`. This is the notice that would
   *  have been given before 13 August rather than six days after it. */
  | 'rule_expiring'
  /** WARNING — a Job Grade no rule in force covers, so nobody on it resolves to a table for this type. */
  | 'grades_without_table'
  /** WARNING — a table in force whose Maximum Balance is 0 on a band that grants days, so every granted
   *  day is clamped away the moment it is granted. Reported, never reinterpreted. */
  | 'max_balance_zero';

const BLOCKING: ReadonlySet<LeaveConfigFinding> = new Set<LeaveConfigFinding>([
  'no_earning_method',
  'no_entitlement_table',
  'no_rule_in_force',
]);

export type LeaveConfigHealth = {
  leaveTypeId: string;
  leaveTypeName: string;
  /** Traffic light: `blocked` ⇒ 0.00 for everybody today; `warning` ⇒ 0.00 for some, or soon. */
  status: 'ready' | 'warning' | 'blocked';
  earningMethodSet: boolean;
  /** Entitlement tables IN FORCE at `today` (superseded and stopped versions excluded). */
  templateCount: number;
  /** Eligibility rules IN FORCE at `today` that can actually hand somebody a table — in force, AND pointing
   *  at a table version that is itself in force. A rule in force over a STOPPED table is not counted here
   *  (the resolver drops it, so it matches nobody); it still blocks `soleTableApplies`, exactly as it does
   *  in the engine. */
  ruleCount: number;
  /** r193 fault 3 — one table in force and NO rule in force anywhere on this leave type (whichever version
   *  of whichever of its tables that rule points at), so the table applies to everyone with no rule needed.
   *  The second half is the engine's `leaveTypeIdsWithEligibilityRulesAt` join, not `ruleCount`. */
  soleTableApplies: boolean;
  findings: LeaveConfigFinding[];
  /** Named so the screen can say WHICH, never just "some". */
  tablesWithoutRule: string[];
  expiredRules: { name: string; endedOn: string }[];
  expiringRules: { name: string; endsOn: string }[];
  gradesWithoutTable: string[];
  zeroMaxBalanceTables: string[];
};

/** In force at `on`: started on or before it, and not stopped on or before it. Half-open, exactly as
 *  `activeTemplatesAt` / `listEligibilityRules` date their SQL windows. */
const inForce = (v: { validFrom: string; validTo: string | null }, on: string): boolean =>
  v.validFrom <= on && (v.validTo == null || v.validTo > on);

/**
 * The CURRENT version of each lineage — the one whose dates describe the lineage's state today.
 *
 * ⚠️ NOT "the version in force". An edit closes the running version and inserts a successor; a RETIRE sets
 * `valid_to` on the running one and inserts nothing. So a retired lineage has NO version in force, and
 * filtering by force would make it disappear from the health check entirely rather than being reported as
 * expired — which is precisely how the production rule went unnoticed. Latest `validFrom` wins; a tie falls
 * back to input order, which both readers give as `validFrom` ascending.
 */
function latestPerLineage<T extends { lineageId: string; validFrom: string }>(rows: readonly T[]): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const prev = out.get(r.lineageId);
    if (!prev || r.validFrom >= prev.validFrom) out.set(r.lineageId, r);
  }
  return [...out.values()];
}

/** `yyyy-mm-dd` + n days, in UTC — the same calendar arithmetic the rest of the leave code does on ISO
 *  dates. Kept local: this file must not import a date library to answer "is it within 60 days". */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * One leave type's health, as at `today`.
 *
 * @param p.templates every version of every table for THIS leave type (the block already loads all of them).
 * @param p.rules     every version of every rule pointing at one of those tables.
 * @param p.grades    the ACTIVE job-grade catalogue — the population "a grade belongs to no table" is about.
 */
export function leaveTypeConfigHealth(p: {
  leaveType: HealthLeaveType;
  templates: readonly HealthTemplate[];
  rules: readonly HealthRule[];
  grades: readonly { id: string; name: string }[];
  today: string;
  expiryWarningDays?: number;
}): LeaveConfigHealth {
  const { leaveType, today } = p;
  const warnWindowEnd = addDaysIso(today, p.expiryWarningDays ?? RULE_EXPIRY_WARNING_DAYS);

  const liveTemplates = p.templates.filter((t) => inForce(t, today));
  const liveTemplateLineages = new Set(liveTemplates.map((t) => t.lineageId));
  // A rule pointing at a lineage with no version in force can MATCH NOBODY — the resolver drops it for
  // exactly that reason ("a rule whose table had not been written yet, or had been closed"). So these are
  // the rules that can actually hand a table to somebody, and they are what `ruleCount`, `tablesWithoutRule`
  // and `gradesWithoutTable` are measured on. They are NOT what the sole-table gate is measured on — see
  // `rulesInForce` immediately below, and do not collapse the two.
  const liveRules = p.rules.filter((r) => inForce(r, today) && liveTemplateLineages.has(r.templateLineageId));

  // This type's OWN lineages, every version — the join `leaveTypeIdsWithEligibilityRulesAt` makes.
  const ownLineages = new Set(p.templates.map((t) => t.lineageId));
  /**
   * ⚠️ THE SOLE-TABLE GATE IS MEASURED ON A WIDER SET THAN `liveRules`, AND GETTING THIS WRONG SHIPPED A
   * GREEN LIGHT OVER A LEAVE TYPE THE ENGINE GRANTED TO NOBODY.
   *
   * The resolver's safety condition is `leaveTypeIdsWithEligibilityRulesAt` (core/entitlement-template.ts),
   * and that query joins rule → leave type through EVERY VERSION of the template lineage, in force or not,
   * deliberately: "a rule pointing at a lineage whose current version is closed is still HR having stated
   * an opinion, and the sole-table fallback must stay out of its way". So a rule in force pointing at a
   * STOPPED table blocks the fallback in the engine.
   *
   * Measured on `liveRules` instead — which drops exactly that rule — this file reported `soleTableApplies`
   * and called such a type READY, while `leaveEntitlementBreakdown` returned `no_eligibility_match` for
   * every employee; the same flag also suppressed the per-table "No eligibility rule points here" marker,
   * so both new signals went quiet at once. It is reached by ordinary use: stop an entitlement table
   * without also stopping the rule that points at it (which is why the retire confirmation names the rule
   * count in the first place).
   */
  const rulesInForce = p.rules.filter((r) => inForce(r, today) && ownLineages.has(r.templateLineageId));

  // r193 fault 3, mirrored. Both conditions, and the second is the safety one: a type with ONE table and a
  // rule that narrows it has deliberately excluded everybody else, and "there is only one table so give it
  // to everyone" would silently reverse that.
  const soleTableApplies = liveTemplates.length === 1 && rulesInForce.length === 0;

  const pointedAt = new Set(liveRules.map((r) => r.templateLineageId));
  const tablesWithoutRule = soleTableApplies
    ? []
    : liveTemplates.filter((t) => !pointedAt.has(t.lineageId)).map((t) => t.name);

  // Rule lineages, judged on their CURRENT version — see `latestPerLineage`. Scoped to this type by the
  // lineage they point at, using EVERY template version (`ownLineages`, above): a rule whose table was
  // stopped still belongs to the type that owned it, and hiding it would hide the expiry that matters most.
  const ruleHeads = latestPerLineage(p.rules.filter((r) => ownLineages.has(r.templateLineageId)));
  const expiredRules = ruleHeads
    .filter((r) => r.validTo != null && r.validTo <= today)
    .map((r) => ({ name: r.name, endedOn: r.validTo! }));
  const expiringRules = ruleHeads
    .filter((r) => r.validTo != null && r.validTo > today && r.validTo <= warnWindowEnd)
    .map((r) => ({ name: r.name, endsOn: r.validTo! }));

  // WHICH GRADES FALL THROUGH. A rule with an EMPTY `gradeIds` does not narrow by grade at all, which in
  // `core/org-criteria.ts` means it covers every grade — so one such rule in force answers the question for
  // the whole catalogue. Only when EVERY live rule names grades can a grade be left out, and then it is the
  // ones outside the union. Same for the sole-table case: that table reaches everyone.
  let gradesWithoutTable: string[] = [];
  if (!soleTableApplies && liveRules.length > 0) {
    const narrowsByGrade = liveRules.every((r) => (r.criteria.gradeIds ?? []).length > 0);
    if (narrowsByGrade) {
      const covered = new Set(liveRules.flatMap((r) => r.criteria.gradeIds ?? []));
      gradesWithoutTable = p.grades.filter((g) => !covered.has(g.id)).map((g) => g.name);
    }
  }

  // A cap of 0 sitting over a band that grants days. Both halves matter: a band of 0 days under a cap of 0
  // grants nothing anyway and is a statement about the day table, not about the cap.
  const zeroMaxBalanceTables = liveTemplates
    .filter((t) => t.serviceBands.some((b) => b.maxBalanceDays === 0 && b.days > 0))
    .map((t) => t.name);

  const earningMethodSet = leaveType.accrualMethod != null && !leaveType.accrualUnconfigured;

  const findings: LeaveConfigFinding[] = [];
  if (!earningMethodSet) findings.push('no_earning_method');
  if (liveTemplates.length === 0) findings.push('no_entitlement_table');
  else if (liveRules.length === 0 && !soleTableApplies) findings.push('no_rule_in_force');
  if (tablesWithoutRule.length > 0) findings.push('table_without_rule');
  if (expiredRules.length > 0) findings.push('rule_expired');
  if (expiringRules.length > 0) findings.push('rule_expiring');
  if (gradesWithoutTable.length > 0) findings.push('grades_without_table');
  if (zeroMaxBalanceTables.length > 0) findings.push('max_balance_zero');

  return {
    leaveTypeId: leaveType.id,
    leaveTypeName: leaveType.name,
    status: findings.some((f) => BLOCKING.has(f)) ? 'blocked' : findings.length > 0 ? 'warning' : 'ready',
    earningMethodSet,
    templateCount: liveTemplates.length,
    ruleCount: liveRules.length,
    soleTableApplies,
    findings,
    tablesWithoutRule,
    expiredRules,
    expiringRules,
    gradesWithoutTable,
    zeroMaxBalanceTables,
  };
}

/** True for the findings that make the figure 0.00 for EVERYBODY today, as opposed to for some. */
export function isBlockingFinding(f: LeaveConfigFinding): boolean {
  return BLOCKING.has(f);
}

/**
 * Every ACTIVE leave type's health in one pass, blocked first then warning then ready, each group by name.
 *
 * ARCHIVED TYPES ARE EXCLUDED, deliberately: an archived type configures nothing and grants nothing, so
 * listing it as "blocked" would be a permanent red row nobody can clear — the class of furniture that stops
 * a health card being read at all.
 */
export function leaveConfigHealthAll(p: {
  leaveTypes: readonly HealthLeaveType[];
  templates: readonly HealthTemplate[];
  rules: readonly HealthRule[];
  grades: readonly { id: string; name: string }[];
  today: string;
  expiryWarningDays?: number;
}): LeaveConfigHealth[] {
  const byType = new Map<string, HealthTemplate[]>();
  for (const t of p.templates) {
    const arr = byType.get(t.leaveTypeId);
    if (arr) arr.push(t);
    else byType.set(t.leaveTypeId, [t]);
  }
  const rank = { blocked: 0, warning: 1, ready: 2 } as const;
  return p.leaveTypes
    .filter((lt) => !lt.archived)
    .map((lt) => {
      const templates = byType.get(lt.id) ?? [];
      const lineages = new Set(templates.map((t) => t.lineageId));
      return leaveTypeConfigHealth({
        leaveType: lt,
        templates,
        rules: p.rules.filter((r) => lineages.has(r.templateLineageId)),
        grades: p.grades,
        today: p.today,
        expiryWarningDays: p.expiryWarningDays,
      });
    })
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] ||
        a.leaveTypeName.localeCompare(b.leaveTypeName, undefined, { sensitivity: 'base' }),
    );
}
