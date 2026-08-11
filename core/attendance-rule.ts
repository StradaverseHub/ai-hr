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
import { todayInKualaLumpur } from '../lib/hr-date';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { attendancePolicy, attendanceRule, attendanceRuleOtRow, shift, type AttendanceOtRatePattern } from '../db/schema';

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
  rounding: boolean;
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
  otRows: ResolvedOtRow[];
};

/**
 * Round OT minutes per the matching band's rounding config and (optionally) fold in pre-shift "early" OT.
 * PURE + exported so the engine and the golden tests share one definition. Standard rules (no OT rows,
 * applyToEarlyOt=false) return the input unchanged, so today's OT stays byte-identical.
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
 * WHAT FLOOR COSTS, stated because it is the reason this needed an owner decision: in ANY band with
 * rounding on, an overtime SMALLER than the Round-To multiple now floors to ZERO — applyOtRuleRows(40, …)
 * against a round-to-60 band was 60 and is now 0. That is the request's own first example ("0:01–0:59 with
 * Round To 60 becomes 60") going the other way, and it is the price of never paying for unworked time. No
 * production rule is exposed to it: A02's 1–59 band has rounding OFF, and Standard's rounding band starts
 * at 60. The request's second example (121 at round-to 30 → 120; 150 stays 150) still holds under floor.
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
  if (band?.rounding && band.roundToMinutes != null && band.roundToMinutes > 0) {
    // FLOOR — see the note above. Never returns more minutes than were worked, and never leaves the band.
    ot = Math.floor(ot / band.roundToMinutes) * band.roundToMinutes;
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
  otRows: rows
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({
      fromMinutes: r.fromMinutes,
      toMinutes: r.toMinutes,
      ratePattern: r.ratePattern,
      rate: Number(r.rate),
      phRate: r.phRate == null ? null : Number(r.phRate),
      rounding: r.rounding,
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
export class AttendanceRuleInUseError extends Error {
  constructor() {
    super('This rule is assigned to one or more shifts. Reassign those shifts before deleting it.');
    this.name = 'AttendanceRuleInUseError';
  }
}

export type OtRowInput = {
  fromMinutes: number;
  toMinutes: number;
  ratePattern: AttendanceOtRatePattern;
  rate: number;
  /** 7c834696 — optional public-holiday multiplier for this band; null ⇒ the band uses `rate`. */
  phRate?: number | null;
  rounding: boolean;
  roundToMinutes: number | null;
};
export type AttendanceRuleInput = {
  name: string;
  description?: string | null;
  status?: 'active' | 'inactive';
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
    const rate = Number(r.rate);
    // Zero is a legitimate multiplier — "record the hours but do not pay them" (request §7). It always was
    // accepted here; what was missing was a way to CHOOSE it, which the editor now offers.
    if (!Number.isFinite(rate) || rate < 0) throw new Error('OT rate must be a non-negative number.');
    const phRaw = r.phRate;
    const phRate = phRaw == null || phRaw === ('' as unknown as number) ? null : Number(phRaw);
    if (phRate != null && (!Number.isFinite(phRate) || phRate < 0)) {
      throw new Error('Public-holiday OT rate must be a non-negative number.');
    }
    const rounding = !!r.rounding;
    const roundToMinutes = rounding ? nonNeg(r.roundToMinutes ?? 0, 'Round-to') : null;
    if (rounding && (!roundToMinutes || roundToMinutes <= 0)) throw new Error('Choose a positive “Round to” value when rounding is on.');
    return {
      fromMinutes,
      toMinutes,
      ratePattern,
      rate: rate.toFixed(2),
      phRate: phRate == null ? null : phRate.toFixed(2),
      rounding,
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
  return {
    name,
    description: p.description?.trim() || null,
    status,
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
    const [inUse] = await tx.select({ id: shift.id }).from(shift).where(eq(shift.ruleId, p.ruleId)).limit(1);
    if (inUse) throw new AttendanceRuleInUseError();
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
