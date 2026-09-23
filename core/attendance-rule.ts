/**
 * 88e94371 · "Lateness, Early Out & Overtime Settings" — named-rule library service.
 *
 * A TENANT-WIDE library of reusable attendance CALCULATION rules (renamed/expanded from the single
 * Attendance Policy). Each rule bundles a Lateness section, an Early Out section, and an Overtime table
 * (attendance_rule_ot_row). A shift picks ONE rule; a shift with no rule resolves to the tenant's
 * un-deletable "Standard" (is_default) rule. See db/schema.ts (attendanceRule) for the scope note on which
 * fields are wired into the time engine vs. stored-for-future.
 *
 * 6da67ab7 (migration 0319) dropped the company axis: the rule is selected by the SHIFT, and the shift
 * library is already tenant-wide, so scoping rules per company only stopped a shared shift from offering
 * every company's rules. Nothing here takes a companyId any more.
 *
 * Substrate: every write appends a DomainEvent (attendance-rule.created / .updated / .deleted). Reads are
 * documented skips.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
// 07ebd04d (r331) — the group's WORKING WEEK. `weekPatternWorkingDayCount` is the ONE definition of
// "how many days does this week actually schedule" (core/week-pattern.ts, a leaf module with no imports
// precisely so this service can use it without a cycle through core/attendance.ts).
import { weekPatternWorkingDayCount } from './week-pattern';
import { todayInKualaLumpur } from '../lib/hr-date';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  ATTENDANCE_OT_ROUNDING_MODES,
  attendancePolicy,
  attendanceRule,
  attendanceRuleOtRow,
  shift,
  type AttendanceOtRatePattern,
  type AttendanceOtRoundingMode,
} from '../db/schema';

const timeToMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

// ── Resolved shapes consumed by the time engine (core/attendance.ts) ──────────────────────────────────
export type ResolvedOtRow = {
  fromMinutes: number;
  toMinutes: number; // ≤ fromMinutes ⇒ open-ended upper bound
  ratePattern: AttendanceOtRatePattern;
  rate: number;
  /** 7c834696 — the band's public-holiday multiplier; null ⇒ use `rate` (today's behaviour). */
  phRate: number | null;
  /** 7c834696 contested (0439) — 'none' | 'down' | 'up'. Replaced the boolean whose direction was floor. */
  roundingMode: AttendanceOtRoundingMode;
  roundToMinutes: number | null;
};
export type ResolvedAttendanceRule = {
  id: string;
  isDefault: boolean;
  lateGracePeriodMinutes: number;
  earlyGracePeriodMinutes: number;
  applyToEarlyOt: boolean;
  // 7c834696 stage 1 — the lateness / early-out DEDUCTION pairs. Stored since 0204 and dropped by this
  // resolver until now, which is precisely why nothing in the engine could ever act on them.
  lateAfterMinutes: number;
  lateDeductMinutes: number;
  includeGraceInLateness: boolean;
  earlyAfterMinutes: number;
  earlyDeductMinutes: number;
  includeGraceInEarlyOut: boolean;
  /** Per-rule opt-in; FALSE on every rule at release. See core/attendance-calc.ts deductionsApplyOn. */
  applyDeductions: boolean;
  /** Stamped by the service on switch-on; deductions never exist for a date before it. */
  deductionsEffectiveFrom: string | null;
  /** 07ebd04d (migration 0483) — THE SCHEDULE GROUP'S WORKING WEEK, the four-way row `shift` has carried
   *  since 0429. Handed to core/week-pattern.ts `weekPatternFor` beside the shift's own triple; a group
   *  whose Full ∪ Half is empty (which is every rule written before 0483, including the tenant's
   *  un-deletable Standard rule) deliberately does NOT win, so the shift keeps answering and nothing
   *  moves. Never read on its own — always through `weekPatternFor`. */
  week: { pattern: number[] | null; halfPattern: number[]; offPattern: number[] };
  otRows: ResolvedOtRow[];
};

/**
 * Round OT minutes per the matching band's rounding config and (optionally) fold in pre-shift "early" OT.
 * PURE + exported so the engine and the golden tests share one definition. Standard rules (no OT rows,
 * applyToEarlyOt=false) return the input unchanged, so today's OT stays byte-identical.
 *
 * 7c834696 CONTESTED (2026-08-13, migration 0439) — ROUNDING NOW HAS A DIRECTION THE OPERATOR CHOOSES:
 * 'none' | 'down' | 'up'. Until 0439 it was a boolean and this function only ever floored, so "round up"
 * was not a setting the reporter had failed to find — it did not exist. The migration maps the old
 * true → 'down' and false → 'none', which is the identity of what each already did, so NO stored band
 * changes its minutes on the day this ships. Everything below about FLOOR is unchanged and still the
 * reasoning behind 'down'; 'up' is the option that was refused as a GLOBAL default and is now offered as
 * a per-band choice, which is a different thing.
 *
 * RESOLVED BY 7c834696 rev 3 (2026-08-11) — ROUNDING IS DOWNWARD, and this is the ONE line in the item
 * that moves money. It was round-to-NEAREST, and nearest is unsound for a BANDED table because nothing
 * stopped the result exceeding either the band's own upper bound or the minutes actually worked:
 *
 *   Production rule "A02" (id 803be8ff…, created as A01 and renamed 2026-08-05) has a band from 60 to 119
 *   minutes with round-to 60. Under NEAREST, 90 through 119 minutes became 120 — past the band's own
 *   119-minute ceiling, and more overtime than the employee was at work for. Two real days were inflated:
 *   2026-08-05 Eee Lee Yong (100814) worked 90 minutes over, stored 120; NURUL ALIAH (100815) worked 100,
 *   stored 120. Nearest also created a cliff — 1h29 paid one hour, 1h30 paid two, 2h00 paid two — so an
 *   extra half hour earned nothing.
 *
 * FLOOR, not "nearest then clamp". The largest multiple of Round-To that does not exceed the overtime.
 * Clamping nearest to the raw figure would return 90 for Eee Lee Yong, which is a different rule and not
 * the one that was approved. Round-UP was refused for the opposite reason: it sends every 60–119 day to
 * 120 and makes the inflation universal.
 *
 * WHAT FLOOR COSTS, stated because it is the reason this needed an owner decision: in ANY band set to
 * 'down', an overtime SMALLER than the Round-To multiple floors to ZERO — applyOtRuleRows(40, …) against a
 * round-to-60 band was 60 under nearest and is 0 under floor. That is the request's own first example
 * ("0:01–0:59 with Round To 60 becomes 60") going the other way, and it is the price of never paying for
 * unworked time. No production rule is exposed to it: A02's 1–59 band does not round, and Standard's
 * rounding band starts at 60. The request's second example (121 at round-to 30 → 120; 150 stays 150) still
 * holds under floor. THAT COST IS EXACTLY WHY THERE ARE THREE MODES: 'none' avoids it outright by using
 * the exact minutes, and 'up' turns it into the opposite (40 against round-to-60 becomes 60). Neither is
 * imposed — the band says which it wants, and a band that says nothing is 'none'.
 *
 * SCOPE, CORRECTED BY 7c834696 STAGE 1: the per-band rate now DOES something — it decides which rate
 * COLUMN a day's overtime minutes land in (core/attendance-calc.ts splitOtMinutes, called by the engine
 * right after this). What is still true is that pay uses the tenant-global statutory multipliers
 * (1.5×/2×/3×) as the compliance cap; feeding custom band multipliers into the payroll kernel remains a
 * deferred follow-up. This function still owns ONLY rounding + early-OT inclusion, and it still decides
 * `ot_minutes` — the canonical total everything downstream reads.
 *
 * NOT CHANGED HERE, deliberately: the request's "overtime beyond the final band shall not be counted"
 * would cut `ot_minutes` DOWNWARD and retroactively for anyone with a bounded table. Minutes past the last
 * band keep that band's rate and are still counted in full. Truncation needs its own opt-in.
 */
export function applyOtRuleRows(
  workdayOtMinutes: number,
  earlyOtMinutes: number,
  rule: ResolvedAttendanceRule | null,
): number {
  let ot = Math.max(0, workdayOtMinutes);
  if (rule?.applyToEarlyOt) ot += Math.max(0, earlyOtMinutes);
  if (!rule || rule.otRows.length === 0 || ot <= 0) return ot;
  const band = rule.otRows.find((r) => ot >= r.fromMinutes && (r.toMinutes <= r.fromMinutes || ot <= r.toMinutes));
  const step = band?.roundToMinutes ?? 0;
  // `step > 0` is still checked here and not only at the CHECK constraint: a row written before 0439's pair
  // constraint existed, or by anything other than the service, must not divide by zero in the pay path.
  if (band && step > 0) {
    // 'down' is FLOOR — see the note above: never more minutes than were worked, and never leaves the band.
    if (band.roundingMode === 'down') ot = Math.floor(ot / step) * step;
    // 'up' is CEIL, and it is the one mode that can hand out minutes nobody worked. That is the operator's
    // explicit choice per band, which is precisely why it is not, and never becomes, a default.
    else if (band.roundingMode === 'up') ot = Math.ceil(ot / step) * step;
    // 'none' falls through untouched — the exact minutes, nothing dropped.
  }
  return Math.max(0, ot);
}

const toResolved = (
  rule: typeof attendanceRule.$inferSelect,
  rows: (typeof attendanceRuleOtRow.$inferSelect)[],
): ResolvedAttendanceRule => ({
  id: rule.id,
  isDefault: rule.isDefault,
  lateGracePeriodMinutes: rule.lateGracePeriodMinutes,
  earlyGracePeriodMinutes: rule.earlyGracePeriodMinutes,
  applyToEarlyOt: rule.applyToEarlyOt,
  lateAfterMinutes: rule.lateAfterMinutes,
  lateDeductMinutes: rule.lateDeductMinutes,
  includeGraceInLateness: rule.includeGraceInLateness,
  earlyAfterMinutes: rule.earlyAfterMinutes,
  earlyDeductMinutes: rule.earlyDeductMinutes,
  includeGraceInEarlyOut: rule.includeGraceInEarlyOut,
  applyDeductions: rule.applyDeductions,
  deductionsEffectiveFrom: rule.deductionsEffectiveFrom ?? null,
  week: { pattern: rule.weeklyPattern, halfPattern: rule.halfPattern, offPattern: rule.offPattern },
  otRows: rows
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({
      fromMinutes: r.fromMinutes,
      toMinutes: r.toMinutes,
      ratePattern: r.ratePattern,
      rate: Number(r.rate),
      phRate: r.phRate == null ? null : Number(r.phRate),
      roundingMode: r.roundingMode,
      roundToMinutes: r.roundToMinutes,
    })),
});

/**
 * Resolve the attendance rule the time engine should apply for a shift: an explicit rule_id wins; otherwise
 * the tenant's `is_default` (Standard) rule. Returns null when neither exists (⇒ legacy behaviour,
 * byte-identical). Runs inside an existing engine transaction (Tx) — RLS already pins the tenant.
 */
export async function resolveRuleTx(
  tx: Tx,
  opts: { ruleId: string | null },
): Promise<ResolvedAttendanceRule | null> {
  let rule: typeof attendanceRule.$inferSelect | undefined;
  if (opts.ruleId) {
    [rule] = await tx.select().from(attendanceRule).where(eq(attendanceRule.id, opts.ruleId)).limit(1);
  } else {
    [rule] = await tx.select().from(attendanceRule).where(eq(attendanceRule.isDefault, true)).limit(1);
  }
  if (!rule) return null;
  const rows = await tx.select().from(attendanceRuleOtRow).where(eq(attendanceRuleOtRow.ruleId, rule.id));
  return toResolved(rule, rows);
}

// ── Read layer (UI) ───────────────────────────────────────────────────────────────────────────────────
export type AttendanceRuleView = typeof attendanceRule.$inferSelect & { otRows: (typeof attendanceRuleOtRow.$inferSelect)[] };

/** Every rule in the tenant (with its OT rows), Standard first then by name. Read-only — no event. */
export function listAttendanceRules(ctx: SessionContext): Promise<AttendanceRuleView[]> {
  return withTenant(ctx, async (tx) => {
    const rules = await tx
      .select()
      .from(attendanceRule)
      .orderBy(sql`${attendanceRule.isDefault} desc`, asc(attendanceRule.name));
    if (rules.length === 0) return [];
    const rows = await tx
      .select()
      .from(attendanceRuleOtRow)
      .where(inArray(attendanceRuleOtRow.ruleId, rules.map((r) => r.id)))
      .orderBy(asc(attendanceRuleOtRow.sortOrder));
    const byRule = new Map<string, (typeof attendanceRuleOtRow.$inferSelect)[]>();
    for (const row of rows) (byRule.get(row.ruleId) ?? byRule.set(row.ruleId, []).get(row.ruleId)!).push(row);
    return rules.map((r) => ({ ...r, otRows: byRule.get(r.id) ?? [] }));
  });
}

/**
 * 870b79e2 (r277) — THE SCHEDULE GROUP'S "SHIFTS ALLOWED" LIST, read and written from the group's side.
 *
 * The reporter asked for a "Shifts allowed" field on the group. The link they are describing already
 * exists — it is `shift.rule_id` — but it can only be set one shift at a time from the shift's own form,
 * which is why they read it as missing: nothing on the group's screen said which shifts belonged to it.
 *
 * ⚠️ NO JUNCTION TABLE AND NO NEW COLUMN, AND THAT IS A DESIGN DECISION, NOT A SHORTCUT. A shift points at
 * exactly ONE rule. That cardinality is what makes rule resolution single-valued: core/attendance.ts
 * ruleFor asks a shift for "its" rule and must get one answer. A many-to-many here would make two lateness
 * rules applicable to the same person on the same day with nothing in the system able to choose — which is
 * the case the approved plan asks the reporter to reject the design over if they ever need it.
 *
 * DETACHING IS NOT DELETING. A shift removed from a group has its rule_id set to NULL, which means it
 * resolves the tenant's Standard rule — the same thing a shift that was never given a rule does. It is
 * never left pointing at a rule it is not listed under.
 *
 * ⚠️ KNOWN AND ACCEPTED: this does NOT retroactively re-examine employees. Removing a shift from a group
 * that one of the group's members is already rostered onto leaves that roster row alone. The refusal is on
 * ASSIGNMENT (core/roster.ts assertShiftsAllowedForEmploymentsTx) and attendance already recorded is never
 * re-derived, exactly as changing a backup shift has always behaved. Building the reverse check would mean
 * a rule screen that can refuse a legitimate reorganisation because of one rostered day, and no plan asks
 * for it. Disclosed rather than hidden.
 */
export function setRuleShifts(
  ctx: SessionContext,
  p: { ruleId: string; shiftIds: readonly string[] },
): Promise<{ attached: number; detached: number }> {
  return withTenant(ctx, async (tx) => {
    const [rule] = await tx.select({ id: attendanceRule.id }).from(attendanceRule).where(eq(attendanceRule.id, p.ruleId)).limit(1);
    if (!rule) throw new Error('Rule not found');
    // Only shifts that actually exist in this tenant can be attached; RLS scopes the read, so a posted id
    // from another tenant simply is not in this list and is dropped rather than written.
    const all = await tx.select({ id: shift.id, ruleId: shift.ruleId }).from(shift);
    const known = new Set(all.map((r) => r.id));
    const wanted = new Set([...p.shiftIds].filter((id) => known.has(id)));
    const current = new Set(all.filter((r) => r.ruleId === p.ruleId).map((r) => r.id));
    const toAttach = [...wanted].filter((id) => !current.has(id));
    const toDetach = [...current].filter((id) => !wanted.has(id));
    if (toAttach.length === 0 && toDetach.length === 0) return { attached: 0, detached: 0 };
    if (toAttach.length > 0) {
      await tx.update(shift).set({ ruleId: p.ruleId }).where(inArray(shift.id, toAttach));
    }
    if (toDetach.length > 0) {
      await tx.update(shift).set({ ruleId: null }).where(inArray(shift.id, toDetach));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-rule',
      aggregateId: p.ruleId,
      eventType: 'attendance-rule.shifts-assigned',
      actor: actorOf(ctx),
      payload: { attached: toAttach, detached: toDetach },
    });
    return { attached: toAttach.length, detached: toDetach.length };
  });
}

/** One rule by id (with OT rows), or null. Read-only — no event. */
export function getAttendanceRule(ctx: SessionContext, ruleId: string): Promise<AttendanceRuleView | null> {
  return withTenant(ctx, async (tx) => {
    const [rule] = await tx.select().from(attendanceRule).where(eq(attendanceRule.id, ruleId)).limit(1);
    if (!rule) return null;
    const otRows = await tx
      .select()
      .from(attendanceRuleOtRow)
      .where(eq(attendanceRuleOtRow.ruleId, ruleId))
      .orderBy(asc(attendanceRuleOtRow.sortOrder));
    return { ...rule, otRows };
  });
}

/**
 * Ensure the TENANT has its un-deletable "Standard" (is_default) rule, seeding one if missing (idempotent via
 * the partial unique index). The rule-library page calls this once so the shift picker's "Standard" fallback
 * always resolves — the runtime complement of migration 0203's one-off conversion (covers tenants created
 * after it and tenants that never had an attendance_policy row). Appends an event ONLY when it creates the row.
 *
 * 6da67ab7: the seed's late grace still comes from an attendance_policy (late_after − work_start, migration
 * 0203's formula) so a runtime-created Standard preserves today's late threshold. With the library now
 * tenant-wide the source policy is the tenant's OLDEST — deterministic, and on the single-company tenants this
 * path actually fires for it is the same row as before.
 */
export function ensureStandardRule(ctx: SessionContext): Promise<{ id: string; created: boolean }> {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: attendanceRule.id })
      .from(attendanceRule)
      .where(eq(attendanceRule.isDefault, true))
      .limit(1);
    if (existing) return { id: existing.id, created: false };
    const [pol] = await tx
      .select({ lateAfter: attendancePolicy.lateAfter, workStart: attendancePolicy.workStart })
      .from(attendancePolicy)
      .orderBy(asc(attendancePolicy.createdAt))
      .limit(1);
    const lateGrace = pol ? Math.max(0, timeToMin(pol.lateAfter) - timeToMin(pol.workStart)) : 0;
    const [row] = await tx
      .insert(attendanceRule)
      .values({
        tenantId: ctx.tenantId,
        name: 'Standard',
        description: 'Default attendance calculation rule.',
        isDefault: true,
        status: 'active',
        lateGracePeriodMinutes: lateGrace,
      })
      .onConflictDoNothing()
      .returning({ id: attendanceRule.id });
    // Lost the race (another request seeded it) — re-read.
    if (!row) {
      const [again] = await tx
        .select({ id: attendanceRule.id })
        .from(attendanceRule)
        .where(eq(attendanceRule.isDefault, true))
        .limit(1);
      return { id: again!.id, created: false };
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-rule',
      aggregateId: row.id,
      eventType: 'attendance-rule.created',
      actor: actorOf(ctx),
      payload: { name: 'Standard', isDefault: true, seeded: true },
    });
    return { id: row.id, created: true };
  });
}

// ── Write layer ──────────────────────────────────────────────────────────────────────────────────────
export class StandardRuleUndeletableError extends Error {
  constructor() {
    super('The Standard rule cannot be deleted.');
    this.name = 'StandardRuleUndeletableError';
  }
}
/**
 * ad52212d ROUND 2 — the refusal NAMES what is using the pattern.
 *
 * It used to say "assigned to one or more shifts", which is the house shape (cf. deleteGradeGroup's "used
 * by one or more leave approval rules") but leaves the administrator to open every shift in the library to
 * find out which. The shifts are already read to decide the refusal, so naming them costs one column and
 * turns the message into the instruction it was pretending to be.
 *
 * At most three are listed with "+N more" after them: an overtime pattern assigned to twenty shifts would
 * otherwise produce an error banner longer than the table it interrupts. The no-argument form is kept and
 * still produces the original sentence, so any caller constructing this without a list is unchanged.
 */
export class AttendanceRuleInUseError extends Error {
  constructor(shiftNames: readonly string[] = []) {
    const shown = shiftNames.slice(0, 3);
    const rest = shiftNames.length - shown.length;
    super(
      shown.length === 0
        ? 'This rule is assigned to one or more shifts. Reassign those shifts before deleting it.'
        : `This overtime pattern is used by ${shown.join(', ')}${rest > 0 ? ` and ${rest} more shift${rest === 1 ? '' : 's'}` : ''}. Reassign ${shiftNames.length === 1 ? 'that shift' : 'those shifts'} before deleting it.`,
    );
    this.name = 'AttendanceRuleInUseError';
  }
}

export type OtRowInput = {
  fromMinutes: number;
  toMinutes: number;
  ratePattern: AttendanceOtRatePattern;
  /** 7c834696 contested — NULLABLE on purpose. A new band no longer arrives pre-filled with 1.5, so
   *  "nothing has been typed here yet" is a state the form can now be in, and it must reach this layer as
   *  itself rather than as a 0 the reader invented. Saving with it unset is refused, not defaulted. */
  rate: number | null;
  /** 7c834696 — optional public-holiday multiplier for this band; null ⇒ the band uses `rate`. */
  phRate?: number | null;
  /** 7c834696 contested (0439) — 'none' | 'down' | 'up'; replaced the boolean that always meant floor. */
  roundingMode: AttendanceOtRoundingMode;
  roundToMinutes: number | null;
};
export type AttendanceRuleInput = {
  name: string;
  description?: string | null;
  status?: 'active' | 'inactive';
  /** 07ebd04d (migration 0483) — THE SCHEDULE GROUP'S WORKING WEEK: Full days, Half days, Off days, as
   *  ISO weekdays (1=Mon … 7=Sun). Rest is the complement, exactly as on `shift`.
   *
   *  ⚠️ `undefined` MEANS "NOT SUPPLIED", NOT "EMPTY", and the difference is a group's whole schedule.
   *  Every existing caller — the Schedule Group form in app/admin/attendance-policy/rules — posts none
   *  of these three, and an update that read `undefined` as `[]` would wipe the working week off a group
   *  the migration had just given one to, silently making every day a rest day for everybody in it.
   *  `updateAttendanceRule` therefore writes these columns only when at least one of the three is
   *  present; supplying all three as empty arrays is how a week is deliberately cleared. */
  weeklyPattern?: number[] | null;
  halfPattern?: number[] | null;
  offPattern?: number[] | null;
  lateGracePeriodMinutes: number;
  lateAfterMinutes: number;
  lateDeductMinutes: number;
  includeGraceInLateness: boolean;
  earlyGracePeriodMinutes: number;
  earlyAfterMinutes: number;
  earlyDeductMinutes: number;
  includeGraceInEarlyOut: boolean;
  applyToEarlyOt: boolean;
  /** 7c834696 — turn the lateness / early-out deductions ON for this rule. The EFFECTIVE-FROM date is not
   *  an input: the service stamps it to today so a deduction can never reach a closed period. */
  applyDeductions?: boolean;
  otRows: OtRowInput[];
};

/**
 * 07ebd04d — THE WRITE-SIDE HALF OF `weekPatternFor`, and the reason it exists.
 *
 * core/week-pattern.ts `weekPatternFor` resolves a group's week ahead of a shift's, but refuses to let a
 * group with NO working day win — because a pattern that matches nothing falls through to
 * policyBranch('rest_day') and would book every working day as a rest day, paying rest-day overtime on
 * ordinary work with no error anywhere (core/roster.ts assignEmployeeShift records the same trap for a
 * backup shift). That read-side fallback keeps a broken group harmless, which is exactly why the broken
 * group must be refused HERE: otherwise the fallback quietly papers over it forever and nobody learns
 * that the week they typed is not the week being used.
 *
 * Three rules, and they are the three `shift` has carried since migration 0429 (core/roster.ts
 * normalizeShiftInput + the 0429 CHECK), now stated for the group as well:
 *   1. every entry is an ISO weekday 1–7, deduplicated and sorted (so two saves of the same week are the
 *      same row, and a report cannot print the same group two different ways);
 *   2. the three lists are PAIRWISE DISJOINT — they are a partition of the week, and a Saturday in two of
 *      them has no answer;
 *   3. a group that declares ANY of the three must declare at least one WORKING day (Full ∪ Half — see
 *      weekPatternWorkingDayCount; an all-half week is walkable and must not be rejected).
 *
 * ALL THREE EMPTY IS LEGAL AND IS NOT A SCHEDULE GROUP'S WEEK: it means "this rule states no working
 * week", which is what every rule written before 0483 holds and what the tenant's un-deletable
 * is_default "Standard" rule must keep holding — it is the rule every shift with no `rule_id` resolves,
 * so a week on it would be imposed on every ungrouped shift in the tenant. Refusing the empty case would
 * make that rule uneditable and would be the more dangerous guard.
 */
const isoWeekdayList = (v: number[] | null | undefined, label: string): number[] => {
  const out = new Set<number>();
  for (const raw of v ?? []) {
    const d = Math.trunc(Number(raw));
    if (!Number.isFinite(d) || d < 1 || d > 7) {
      throw new Error(`${label} must be weekdays 1–7 (1 = Monday … 7 = Sunday).`);
    }
    out.add(d);
  }
  return [...out].sort((a, b) => a - b);
};

export function normalizeWeekPattern(p: {
  weeklyPattern?: number[] | null;
  halfPattern?: number[] | null;
  offPattern?: number[] | null;
}): { weeklyPattern: number[] | null; halfPattern: number[]; offPattern: number[] } {
  const full = isoWeekdayList(p.weeklyPattern, 'Working days');
  const half = isoWeekdayList(p.halfPattern, 'Half-day weekdays');
  const off = isoWeekdayList(p.offPattern, 'Off-day weekdays');
  const clash = (a: number[], b: number[]) => a.find((d) => b.includes(d));
  for (const [a, b, msg] of [
    [full, half, 'a full working day and a half day'],
    [full, off, 'a full working day and an off day'],
    [half, off, 'a half day and an off day'],
  ] as const) {
    const d = clash(a, b);
    if (d != null) {
      throw new Error(`Weekday ${d} cannot be both ${msg}. Each day of the week belongs to exactly one list.`);
    }
  }
  const declared = full.length > 0 || half.length > 0 || off.length > 0;
  if (declared && weekPatternWorkingDayCount({ pattern: full, halfPattern: half }) === 0) {
    throw new Error(
      'This Schedule Group states a working week with no working day in it, so everybody in it would be treated as resting every day of the week. Tick at least one full or half working day, or leave the whole week blank to let each shift keep its own.',
    );
  }
  // NULL rather than [] whenever no FULL day is declared: `shift.weekly_pattern` is nullable and the two
  // mean the same thing to `shiftDayKindFor`, so an all-half week must store NULL exactly as an all-half
  // SHIFT does. `declared` is used only to decide whether the week was stated at all, not what is stored.
  void declared;
  return { weeklyPattern: full.length > 0 ? full : null, halfPattern: half, offPattern: off };
}

const nonNeg = (v: number, label: string): number => {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative whole number of minutes.`);
  return n;
};

/**
 * 7c834696 stage 1 — the OT band table must describe a CONTINUOUS ladder, as the request specifies: no
 * overlaps, no gaps, every next "From" exactly one minute past the previous "To". Until now nothing checked
 * it, so a table with a hole in it saved silently and the hole only showed up as overtime landing in a
 * column nobody expected. The message names the two rows at fault (1-based, as the editor numbers them),
 * because "invalid OT bands" on a six-row table is not an actionable error.
 *
 * An open-ended band (To ≤ From) is still legal, but only as the LAST row — a table cannot continue past a
 * band with no upper bound. This is validated on SAVE only: a rule stored before this release that breaks
 * the rule keeps calculating (splitOtMinutes copes with it), and is refused the next time someone edits it.
 */
function validateOtLadder(rows: { fromMinutes: number; toMinutes: number }[]): void {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const openEnded = r.toMinutes <= r.fromMinutes;
    if (openEnded && i !== rows.length - 1) {
      throw new Error(
        `Overtime row ${i + 1} has no upper limit, so no row can follow it. Give row ${i + 1} a “To” value or move it to the end.`,
      );
    }
    if (i === 0) continue;
    const prev = rows[i - 1];
    if (r.fromMinutes !== prev.toMinutes + 1) {
      const kind = r.fromMinutes <= prev.toMinutes ? 'overlaps' : 'leaves a gap after';
      throw new Error(
        `Overtime row ${i + 1} ${kind} row ${i}: row ${i} ends at ${prev.toMinutes} minutes, so row ${i + 1} must start at ${prev.toMinutes + 1} minutes (it starts at ${r.fromMinutes}).`,
      );
    }
  }
}

function normalizeInput(p: AttendanceRuleInput) {
  const name = p.name.trim();
  if (!name) throw new Error('Rule name is required.');
  const status = p.status === 'inactive' ? 'inactive' : 'active';
  const otRows = (p.otRows ?? []).map((r, i) => {
    const fromMinutes = nonNeg(r.fromMinutes, 'OT “From”');
    const toMinutes = nonNeg(r.toMinutes, 'OT “To”');
    const ratePattern: AttendanceOtRatePattern = r.ratePattern === 'variable' ? 'variable' : 'flat';
    // 7c834696 contested — the rate is REQUIRED and is no longer defaulted anywhere. The reporter's third
    // point was that a new band arrived showing 1.5 as though the system had decided the band was
    // time-and-a-half; the editor stopped seeding it, and the honest completion of that is to refuse an
    // empty one here rather than to silently substitute 1.5 (the column default) or 0 (what `Number('')`
    // would give). Both substitutions are the same defect the reporter raised, just quieter.
    if (r.rate == null || (r.rate as unknown) === '') {
      throw new Error(`Overtime row ${i + 1} has no rate. Enter the rate this band uses.`);
    }
    const rate = Number(r.rate);
    // Zero is a legitimate multiplier — "record the hours but do not pay them" (request §7). It always was
    // accepted here; what was missing was a way to CHOOSE it, which the editor now offers.
    if (!Number.isFinite(rate) || rate < 0) throw new Error('OT rate must be a non-negative number.');
    const phRaw = r.phRate;
    const phRate = phRaw == null || phRaw === ('' as unknown as number) ? null : Number(phRaw);
    if (phRate != null && (!Number.isFinite(phRate) || phRate < 0)) {
      throw new Error('Public-holiday OT rate must be a non-negative number.');
    }
    // 7c834696 contested — an unrecognised mode falls back to 'none', the only value that cannot change
    // what a band pays. Never to 'down': guessing a DIRECTION from a value we did not recognise is how a
    // typo would start rounding somebody's overtime away.
    const roundingMode: AttendanceOtRoundingMode = ATTENDANCE_OT_ROUNDING_MODES.includes(
      r.roundingMode as AttendanceOtRoundingMode,
    )
      ? (r.roundingMode as AttendanceOtRoundingMode)
      : 'none';
    const roundToMinutes = roundingMode === 'none' ? null : nonNeg(r.roundToMinutes ?? 0, 'Round-to');
    // "Refuse 0" is the point, not a formality: 0 divides by zero in applyOtRuleRows, and the `> 0` guard
    // that stood in for this made 0 behave as 'none' by accident. Round To is a free minutes box now
    // (5, 10, anything the policy uses), so a typed 0 is reachable in a way the old 15/30/60 list never was.
    if (roundingMode !== 'none' && (!roundToMinutes || roundToMinutes <= 0)) {
      throw new Error(
        `Overtime row ${i + 1}: enter a “Round to” of at least 1 minute, or set rounding to “No rounding”.`,
      );
    }
    return {
      fromMinutes,
      toMinutes,
      ratePattern,
      rate: rate.toFixed(2),
      phRate: phRate == null ? null : phRate.toFixed(2),
      roundingMode,
      roundToMinutes,
      sortOrder: i,
    };
  });
  validateOtLadder(otRows);
  // The request's "X cannot exceed Y" on each (after X minutes → deduct Y minutes) pair. Enforced HERE and
  // not as a DB CHECK on purpose: rules saved since 0204 were never validated, so production may hold a row
  // that breaks it and a CHECK would abort the migration. An offending stored rule keeps working and is
  // refused the next time it is edited.
  const lateAfter = nonNeg(p.lateAfterMinutes, 'Lateness “after”');
  const lateDeduct = nonNeg(p.lateDeductMinutes, 'Lateness deduction');
  if (lateAfter > 0 && lateDeduct > 0 && lateAfter > lateDeduct) {
    throw new Error(
      `Lateness: “after ${lateAfter} minutes” cannot be larger than “deduct ${lateDeduct} minutes”. Raise the deduction or lower the interval.`,
    );
  }
  const earlyAfter = nonNeg(p.earlyAfterMinutes, 'Early-out “after”');
  const earlyDeduct = nonNeg(p.earlyDeductMinutes, 'Early-out deduction');
  if (earlyAfter > 0 && earlyDeduct > 0 && earlyAfter > earlyDeduct) {
    throw new Error(
      `Early out: “after ${earlyAfter} minutes” cannot be larger than “deduct ${earlyDeduct} minutes”. Raise the deduction or lower the interval.`,
    );
  }
  // 07ebd04d — the week is normalized and refused HERE, beside the OT ladder and the deduction pairs, so
  // that every writer of a Schedule Group goes through one validation. `hasWeekInput` is what keeps a
  // caller that never mentions the week from wiping it — see AttendanceRuleInput.
  const hasWeekInput = p.weeklyPattern !== undefined || p.halfPattern !== undefined || p.offPattern !== undefined;
  const week = normalizeWeekPattern(p);
  return {
    name,
    description: p.description?.trim() || null,
    status,
    hasWeekInput,
    week,
    lateGracePeriodMinutes: nonNeg(p.lateGracePeriodMinutes, 'Lateness grace period'),
    lateAfterMinutes: lateAfter,
    lateDeductMinutes: lateDeduct,
    includeGraceInLateness: !!p.includeGraceInLateness,
    earlyGracePeriodMinutes: nonNeg(p.earlyGracePeriodMinutes, 'Early-out grace period'),
    earlyAfterMinutes: earlyAfter,
    earlyDeductMinutes: earlyDeduct,
    includeGraceInEarlyOut: !!p.includeGraceInEarlyOut,
    applyToEarlyOt: !!p.applyToEarlyOt,
    applyDeductions: !!p.applyDeductions,
    otRows,
  };
}

/**
 * The forward-dating rule for the deduction switch, in one place so create and update cannot disagree.
 *
 * OFF ⇒ no start date at all (and the DB CHECK from 0394 makes the reverse — on with no date —
 * unrepresentable). ON ⇒ keep the date already stamped if the switch was already on, otherwise stamp
 * TODAY. The date is never taken from the caller, so there is no input through which a past date could be
 * supplied and no window in which the engine would deduct from a period that is already closed.
 */
function resolveDeductionStart(
  applyDeductions: boolean,
  existing: { applyDeductions: boolean; deductionsEffectiveFrom: string | null } | null,
): string | null {
  if (!applyDeductions) return null;
  if (existing?.applyDeductions && existing.deductionsEffectiveFrom) return existing.deductionsEffectiveFrom;
  return todayInKualaLumpur();
}

const isUniqueViolation = (e: unknown): boolean => {
  let cur = e as { code?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as { code?: string; cause?: unknown } | null | undefined;
  }
  return false;
};

/** Create a (non-default) rule + its OT rows. Appends attendance-rule.created. */
export function createAttendanceRule(ctx: SessionContext, p: AttendanceRuleInput): Promise<{ id: string }> {
  const n = normalizeInput(p);
  return withTenant(ctx, async (tx) => {
    let ruleId: string;
    try {
      const [row] = await tx
        .insert(attendanceRule)
        .values({
          tenantId: ctx.tenantId,
          name: n.name,
          description: n.description,
          isDefault: false, // only the seeded Standard is default
          status: n.status,
          lateGracePeriodMinutes: n.lateGracePeriodMinutes,
          lateAfterMinutes: n.lateAfterMinutes,
          lateDeductMinutes: n.lateDeductMinutes,
          includeGraceInLateness: n.includeGraceInLateness,
          earlyGracePeriodMinutes: n.earlyGracePeriodMinutes,
          earlyAfterMinutes: n.earlyAfterMinutes,
          earlyDeductMinutes: n.earlyDeductMinutes,
          includeGraceInEarlyOut: n.includeGraceInEarlyOut,
          applyToEarlyOt: n.applyToEarlyOt,
          applyDeductions: n.applyDeductions,
          deductionsEffectiveFrom: resolveDeductionStart(n.applyDeductions, null),
          // 07ebd04d — THE WORKING WEEK IS WRITTEN IN THE SAME STATEMENT THAT CREATES THE GROUP, never in
          // a follow-up UPDATE: a group row that exists for even one statement with no week is a group
          // that schedules nothing for everyone in it (see normalizeWeekPattern). Migration 0483 creates
          // the three split groups under exactly the same rule.
          weeklyPattern: n.week.weeklyPattern,
          halfPattern: n.week.halfPattern,
          offPattern: n.week.offPattern,
        })
        .returning({ id: attendanceRule.id });
      ruleId = row.id;
    } catch (e) {
      if (isUniqueViolation(e)) throw new Error(`A rule named “${n.name}” already exists.`);
      throw e;
    }
    if (n.otRows.length > 0) {
      await tx.insert(attendanceRuleOtRow).values(n.otRows.map((r) => ({ tenantId: ctx.tenantId, ruleId, ...r })));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-rule',
      aggregateId: ruleId,
      eventType: 'attendance-rule.created',
      actor: actorOf(ctx),
      payload: {
        name: n.name,
        status: n.status,
        otRowCount: n.otRows.length,
        applyToEarlyOt: n.applyToEarlyOt,
        // 7c834696 — the deduction switch is money-adjacent; its state and its forward start date belong
        // in the audit trail so "when did this rule start deducting" is answerable without archaeology.
        applyDeductions: n.applyDeductions,
      },
    });
    return { id: ruleId };
  });
}

/** Update a rule (name/description/status editable on Standard too) + replace its OT rows. Appends
 *  attendance-rule.updated. is_default is never changed here (Standard stays Standard). */
export function updateAttendanceRule(ctx: SessionContext, p: { ruleId: string } & AttendanceRuleInput): Promise<{ id: string }> {
  const n = normalizeInput(p);
  return withTenant(ctx, async (tx) => {
    // Read the CURRENT switch state before writing: an already-on rule keeps the date it was stamped with,
    // so re-saving a rule for an unrelated reason cannot silently move its deductions' start date forward.
    const [before] = await tx
      .select({
        applyDeductions: attendanceRule.applyDeductions,
        deductionsEffectiveFrom: attendanceRule.deductionsEffectiveFrom,
      })
      .from(attendanceRule)
      .where(eq(attendanceRule.id, p.ruleId))
      .limit(1);
    try {
      await tx
        .update(attendanceRule)
        .set({
          name: n.name,
          description: n.description,
          status: n.status,
          lateGracePeriodMinutes: n.lateGracePeriodMinutes,
          lateAfterMinutes: n.lateAfterMinutes,
          lateDeductMinutes: n.lateDeductMinutes,
          includeGraceInLateness: n.includeGraceInLateness,
          earlyGracePeriodMinutes: n.earlyGracePeriodMinutes,
          earlyAfterMinutes: n.earlyAfterMinutes,
          earlyDeductMinutes: n.earlyDeductMinutes,
          includeGraceInEarlyOut: n.includeGraceInEarlyOut,
          applyToEarlyOt: n.applyToEarlyOt,
          applyDeductions: n.applyDeductions,
          deductionsEffectiveFrom: resolveDeductionStart(n.applyDeductions, before ?? null),
          // 07ebd04d — ONLY when the caller actually said something about the week. The Schedule Group
          // form posts no day fields, and spreading a normalized-from-nothing week here would clear the
          // working week off every group the migration gave one to, the first time anyone renamed one.
          ...(n.hasWeekInput
            ? { weeklyPattern: n.week.weeklyPattern, halfPattern: n.week.halfPattern, offPattern: n.week.offPattern }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(attendanceRule.id, p.ruleId));
    } catch (e) {
      if (isUniqueViolation(e)) throw new Error(`A rule named “${n.name}” already exists.`);
      throw e;
    }
    // Replace the OT rows wholesale (small, admin-authored set).
    await tx.delete(attendanceRuleOtRow).where(eq(attendanceRuleOtRow.ruleId, p.ruleId));
    if (n.otRows.length > 0) {
      await tx.insert(attendanceRuleOtRow).values(n.otRows.map((r) => ({ tenantId: ctx.tenantId, ruleId: p.ruleId, ...r })));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-rule',
      aggregateId: p.ruleId,
      eventType: 'attendance-rule.updated',
      actor: actorOf(ctx),
      payload: {
        name: n.name,
        status: n.status,
        otRowCount: n.otRows.length,
        applyToEarlyOt: n.applyToEarlyOt,
        // 7c834696 — the deduction switch is money-adjacent; its state and its forward start date belong
        // in the audit trail so "when did this rule start deducting" is answerable without archaeology.
        applyDeductions: n.applyDeductions,
      },
    });
    return { id: p.ruleId };
  });
}

/**
 * ad52212d ROUND 2 — DUPLICATE an overtime pattern (the reporter's "Duplicate" action on the list).
 *
 * The whole point of the request is that a second pattern usually differs from an existing one by a rate or
 * a band boundary, not by all fourteen boxes. Modelled on core/roster.ts copyShift, which solved the same
 * problem for the shift library, and it shares that function's two decisions:
 *
 *  - NAMING probes until a free name is found, so duplicating twice gives "X (copy)" then "X (copy 2)"
 *    rather than a dead end on the second click. `attendance_rule_tenant_name_uq` is case-insensitive and
 *    tenant-wide and — unlike the shift indexes — is NOT partial, so every row counts as taken.
 *  - The copy lands ACTIVE even from an inactive source: you duplicate a pattern in order to use it.
 *
 * TWO THINGS DELIBERATELY DO NOT TRAVEL WITH THE COPY:
 *  - `isDefault`. There is exactly one Standard rule per tenant (a partial unique index enforces it), and
 *    duplicating Standard must produce an ordinary pattern, not a second undeletable one.
 *  - `deductionsEffectiveFrom`. Carrying the source's date would hand a brand-new pattern a start date in
 *    the past, i.e. deductions reaching a closed payroll period — the exact thing 7c834696 built
 *    resolveDeductionStart to make unrepresentable. The copy starts deducting today, if at all.
 *
 * Returns the NEW rule's id; the caller lands the operator on its edit form, which is where they change the
 * bands that made them duplicate in the first place.
 */
export function copyAttendanceRule(ctx: SessionContext, p: { ruleId: string }): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [src] = await tx.select().from(attendanceRule).where(eq(attendanceRule.id, p.ruleId)).limit(1);
    if (!src) throw new Error('Rule not found.');

    const taken = new Set(
      (await tx.select({ name: attendanceRule.name }).from(attendanceRule)).map((r) => r.name.trim().toLowerCase()),
    );
    const base = src.name.trim();
    let name = '';
    for (let n = 1; n <= 99; n++) {
      const candidate = n === 1 ? `${base} (copy)` : `${base} (copy ${n})`;
      if (taken.has(candidate.toLowerCase())) continue;
      name = candidate;
      break;
    }
    if (!name) throw new Error(`A rule named “${base} (copy)” already exists.`);

    let ruleId: string;
    try {
      const [row] = await tx
        .insert(attendanceRule)
        .values({
          tenantId: ctx.tenantId,
          name,
          description: src.description,
          isDefault: false,
          status: 'active',
          lateGracePeriodMinutes: src.lateGracePeriodMinutes,
          lateAfterMinutes: src.lateAfterMinutes,
          lateDeductMinutes: src.lateDeductMinutes,
          includeGraceInLateness: src.includeGraceInLateness,
          earlyGracePeriodMinutes: src.earlyGracePeriodMinutes,
          earlyAfterMinutes: src.earlyAfterMinutes,
          earlyDeductMinutes: src.earlyDeductMinutes,
          includeGraceInEarlyOut: src.includeGraceInEarlyOut,
          applyToEarlyOt: src.applyToEarlyOt,
          applyDeductions: src.applyDeductions,
          deductionsEffectiveFrom: resolveDeductionStart(src.applyDeductions, null),
          // 07ebd04d — the WORKING WEEK travels with the copy, like the OT bands below and for the same
          // reason: a duplicate of a Schedule Group that scheduled Mon–Sat but schedules nothing is not a
          // duplicate. In the same statement, never a follow-up UPDATE (see createAttendanceRule).
          weeklyPattern: src.weeklyPattern,
          halfPattern: src.halfPattern,
          offPattern: src.offPattern,
        })
        .returning({ id: attendanceRule.id });
      ruleId = row.id;
    } catch (e) {
      if (isUniqueViolation(e)) throw new Error(`A rule named “${name}” already exists.`);
      throw e;
    }

    // The OT bands ARE the pattern — a copy that lost them would be worse than no copy at all.
    const rows = await tx
      .select()
      .from(attendanceRuleOtRow)
      .where(eq(attendanceRuleOtRow.ruleId, p.ruleId))
      .orderBy(asc(attendanceRuleOtRow.sortOrder));
    if (rows.length > 0) {
      await tx.insert(attendanceRuleOtRow).values(
        rows.map((r) => ({
          tenantId: ctx.tenantId,
          ruleId,
          fromMinutes: r.fromMinutes,
          toMinutes: r.toMinutes,
          ratePattern: r.ratePattern,
          rate: r.rate,
          phRate: r.phRate,
          roundingMode: r.roundingMode,
          roundToMinutes: r.roundToMinutes,
          sortOrder: r.sortOrder,
        })),
      );
    }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-rule',
      aggregateId: ruleId,
      eventType: 'attendance-rule.copied',
      actor: actorOf(ctx),
      payload: { name, copiedFromRuleId: p.ruleId, otRowCount: rows.length, applyDeductions: src.applyDeductions },
    });
    return { id: ruleId };
  });
}

/**
 * ad52212d ROUND 2 — ACTIVATE / DEACTIVATE an overtime pattern from the list.
 *
 * The `status` column has existed since migration 0203 and was already editable, but only by opening the
 * pattern's edit form and saving the whole record back — which also re-validates and rewrites every band.
 * This is the one-field write the reporter asked for, and it is deliberately NOT routed through
 * updateAttendanceRule: a status flip must not be able to fail on an OT ladder that a rule saved before
 * 7c834696 stage 1 would now be refused for.
 *
 * Deactivating does NOT stop a rule calculating. Per db/schema.ts an inactive rule stays assigned and keeps
 * working; it is hidden from the new-shift picker. Nothing here changes that meaning — a flag that quietly
 * stopped shifts from being calculated would be a money change hidden in a menu item.
 */
export function setAttendanceRuleStatus(
  ctx: SessionContext,
  p: { ruleId: string; status: 'active' | 'inactive' },
): Promise<{ id: string }> {
  const status = p.status === 'inactive' ? 'inactive' : 'active';
  return withTenant(ctx, async (tx) => {
    const [rule] = await tx
      .select({ id: attendanceRule.id, name: attendanceRule.name })
      .from(attendanceRule)
      .where(eq(attendanceRule.id, p.ruleId))
      .limit(1);
    if (!rule) throw new Error('Rule not found.');
    await tx
      .update(attendanceRule)
      .set({ status, updatedAt: new Date() })
      .where(eq(attendanceRule.id, p.ruleId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-rule',
      aggregateId: p.ruleId,
      // The PAIR, not one `.status-changed`. lib/audit-format.ts actionOf() classifies on the last
      // dot-segment: `activated` → unarchived, `deactivated` → archived, and anything it does not know
      // falls through to `other`. A single `status-changed` would therefore be invisible to an
      // administrator filtering the Audit Trail for Activate/Deactivate — and domain_event is
      // append-only, so rows written under the wrong name stay wrong forever. Six of the seven status
      // flips in core/ already emit the pair (payroll-policy, employee-id-config,
      // leave-approval-template, profile-options, dashboard-card-config, payroll-cycle).
      eventType: status === 'active' ? 'attendance-rule.activated' : 'attendance-rule.deactivated',
      actor: actorOf(ctx),
      payload: { name: rule.name, status },
    });
    return { id: p.ruleId };
  });
}

/** Delete a rule. Refuses the Standard (is_default) rule and any rule still assigned to a shift. Appends
 *  attendance-rule.deleted. OT rows cascade via the FK. */
export function deleteAttendanceRule(ctx: SessionContext, p: { ruleId: string }): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [rule] = await tx
      .select({ id: attendanceRule.id, isDefault: attendanceRule.isDefault, name: attendanceRule.name })
      .from(attendanceRule)
      .where(eq(attendanceRule.id, p.ruleId))
      .limit(1);
    if (!rule) throw new Error('Rule not found.');
    if (rule.isDefault) throw new StandardRuleUndeletableError();
    // ad52212d round 2 — the NAMES, not just "is there one". Deliberately UNCAPPED: the message quotes
    // three and counts the rest, and it can only count the rest honestly if the query returned them. The
    // shift library is an admin-authored, tenant-wide template set (tens of rows), and this runs once on a
    // refused delete — the alternative, a `limit(4)`, would report "and 1 more" over any number of shifts.
    const inUse = await tx
      .select({ name: shift.name })
      .from(shift)
      .where(eq(shift.ruleId, p.ruleId))
      .orderBy(asc(shift.name));
    if (inUse.length > 0) throw new AttendanceRuleInUseError(inUse.map((r) => r.name));
    await tx.delete(attendanceRule).where(eq(attendanceRule.id, p.ruleId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-rule',
      aggregateId: p.ruleId,
      eventType: 'attendance-rule.deleted',
      actor: actorOf(ctx),
      payload: { name: rule.name },
    });
    return { id: p.ruleId };
  });
}
