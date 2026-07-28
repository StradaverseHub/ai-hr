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
  rounding: boolean;
  roundToMinutes: number | null;
};
export type ResolvedAttendanceRule = {
  id: string;
  isDefault: boolean;
  lateGracePeriodMinutes: number;
  earlyGracePeriodMinutes: number;
  applyToEarlyOt: boolean;
  otRows: ResolvedOtRow[];
};

/**
 * Round OT minutes per the matching band's rounding config and (optionally) fold in pre-shift "early" OT.
 * PURE + exported so the engine and the golden tests share one definition. Standard rules (no OT rows,
 * applyToEarlyOt=false) return the input unchanged, so today's OT stays byte-identical.
 *
 * NOTE (88e94371 GAP): the per-band `rate`/`ratePattern` describe how OT PAY is shaped, but pay still uses
 * the tenant-global statutory multipliers (1.5×/2×/3×) as the compliance cap — feeding custom band
 * multipliers into the payroll kernel is a deferred follow-up. This function applies only the rounding +
 * early-OT-inclusion behaviour, which is what the engine can honour today.
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
    ot = Math.round(ot / band.roundToMinutes) * band.roundToMinutes;
  }
  return Math.max(0, ot);
}

const toResolved = (
  rule: { id: string; isDefault: boolean; lateGracePeriodMinutes: number; earlyGracePeriodMinutes: number; applyToEarlyOt: boolean },
  rows: (typeof attendanceRuleOtRow.$inferSelect)[],
): ResolvedAttendanceRule => ({
  id: rule.id,
  isDefault: rule.isDefault,
  lateGracePeriodMinutes: rule.lateGracePeriodMinutes,
  earlyGracePeriodMinutes: rule.earlyGracePeriodMinutes,
  applyToEarlyOt: rule.applyToEarlyOt,
  otRows: rows
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({
      fromMinutes: r.fromMinutes,
      toMinutes: r.toMinutes,
      ratePattern: r.ratePattern,
      rate: Number(r.rate),
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
  otRows: OtRowInput[];
};

const nonNeg = (v: number, label: string): number => {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative whole number of minutes.`);
  return n;
};

function normalizeInput(p: AttendanceRuleInput) {
  const name = p.name.trim();
  if (!name) throw new Error('Rule name is required.');
  const status = p.status === 'inactive' ? 'inactive' : 'active';
  const otRows = (p.otRows ?? []).map((r, i) => {
    const fromMinutes = nonNeg(r.fromMinutes, 'OT “From”');
    const toMinutes = nonNeg(r.toMinutes, 'OT “To”');
    const ratePattern: AttendanceOtRatePattern = r.ratePattern === 'variable' ? 'variable' : 'flat';
    const rate = Number(r.rate);
    if (!Number.isFinite(rate) || rate < 0) throw new Error('OT rate must be a non-negative number.');
    const rounding = !!r.rounding;
    const roundToMinutes = rounding ? nonNeg(r.roundToMinutes ?? 0, 'Round-to') : null;
    if (rounding && (!roundToMinutes || roundToMinutes <= 0)) throw new Error('Choose a positive “Round to” value when rounding is on.');
    return { fromMinutes, toMinutes, ratePattern, rate: rate.toFixed(2), rounding, roundToMinutes, sortOrder: i };
  });
  return {
    name,
    description: p.description?.trim() || null,
    status,
    lateGracePeriodMinutes: nonNeg(p.lateGracePeriodMinutes, 'Lateness grace period'),
    lateAfterMinutes: nonNeg(p.lateAfterMinutes, 'Lateness “after”'),
    lateDeductMinutes: nonNeg(p.lateDeductMinutes, 'Lateness deduction'),
    includeGraceInLateness: !!p.includeGraceInLateness,
    earlyGracePeriodMinutes: nonNeg(p.earlyGracePeriodMinutes, 'Early-out grace period'),
    earlyAfterMinutes: nonNeg(p.earlyAfterMinutes, 'Early-out “after”'),
    earlyDeductMinutes: nonNeg(p.earlyDeductMinutes, 'Early-out deduction'),
    includeGraceInEarlyOut: !!p.includeGraceInEarlyOut,
    applyToEarlyOt: !!p.applyToEarlyOt,
    otRows,
  };
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
      payload: { name: n.name, status: n.status, otRowCount: n.otRows.length, applyToEarlyOt: n.applyToEarlyOt },
    });
    return { id: ruleId };
  });
}

/** Update a rule (name/description/status editable on Standard too) + replace its OT rows. Appends
 *  attendance-rule.updated. is_default is never changed here (Standard stays Standard). */
export function updateAttendanceRule(ctx: SessionContext, p: { ruleId: string } & AttendanceRuleInput): Promise<{ id: string }> {
  const n = normalizeInput(p);
  return withTenant(ctx, async (tx) => {
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
      payload: { name: n.name, status: n.status, otRowCount: n.otRows.length, applyToEarlyOt: n.applyToEarlyOt },
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
