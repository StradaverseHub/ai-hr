/** Shared shift eligibility; deliberately independent of roster and attendance initialization. */
import { and,asc,eq,inArray,isNotNull,or } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { attendanceRule,employment,shift } from '../db/schema';

// ── The Schedule Group's allowed shifts (870b79e2, r277) ───────────────────────────────────────────

/**
 * 870b79e2 — "refuse an employee being put on a shift that is not in their group's allowed list, with a
 * clear message saying which shifts are allowed".
 *
 * THE ALLOWED LIST IS NOT A NEW TABLE. It is `shift.rule_id` read backwards: a shift points at exactly one
 * attendance_rule, so the set of shifts pointing at a rule IS that rule's allowed list. The employee's
 * group is `employment.attendance_rule_id` (migration 0464). Nothing new is stored to answer this
 * question, and the one-rule-per-shift cardinality that makes the answer single-valued is preserved —
 * which is also why rule resolution in core/attendance.ts can never have two answers.
 *
 * ⚠️ WHY THIS IS A SERVICE REFUSAL AND NOT A DB CHECK OR A FORM CHECK.
 *   · Not a CHECK: the rule spans two tables (employment.attendance_rule_id vs shift.rule_id), so it is
 *     not expressible as a column constraint at all, and a NOT VALID check still fires on every UPDATE
 *     (CLAUDE.md §6) — it would start rejecting writes from terminations and erasure sweeps.
 *   · Not a form check: there are FOUR writers of "which shift is this person on", and a check on one
 *     form would miss three — roster generation (assignShiftBulk, via generateRosterFromTemplate), the
 *     per-date roster brush (assignShift, via assignRosterRow), the dated arrangement ladder
 *     (core/shift-arrangement.ts assignEmployeeShiftDated) and the profile backup shift
 *     (assignEmployeeShift → employment.default_shift_id). Every one of them calls this.
 *   · copyRoster calls it too, and that is not belt-and-braces: it writes rows FORWARD in time from a
 *     source window, so a group assigned AFTER the source rows were created would otherwise be bypassed
 *     by the one path whose rows nobody re-examined.
 *
 * ⚠️ AN EMPTY GROUP REFUSES EVERYTHING, DELIBERATELY. A group with no shifts pointing at it permits no
 * shift, and the refusal says exactly that and where to fix it. The alternative — "empty means allow
 * anything" — is silently permissive on precisely the configuration mistake this guard exists to catch.
 *
 * Employments with NO group (all of them at release: the column ships NULL with no backfill) are not
 * constrained at all, so this function is a no-op on release day and every existing caller is unchanged.
 */
export class ShiftNotInScheduleGroupError extends Error {
  constructor(p: { groupName: string; shiftName: string | null; allowed: readonly string[] }) {
    const subject = p.shiftName ? `“${p.shiftName}”` : 'That shift';
    super(
      p.allowed.length === 0
        ? `${subject} cannot be assigned: the Schedule Group “${p.groupName}” does not allow any shift yet. Add shifts to that group on the Schedule Group screen first.`
        : `${subject} is not allowed by the Schedule Group “${p.groupName}”. That group allows: ${p.allowed.join(', ')}.`,
    );
    this.name = 'ShiftNotInScheduleGroupError';
  }
}

/**
 * Refuse every (employment, shift) pair whose employment belongs to a Schedule Group that does not allow
 * that shift. Batched so the bulk writers cost three queries rather than three per row, and so the
 * per-row writers share ONE definition of the rule with them.
 *
 * Runs inside the caller's transaction: RLS has already pinned the tenant, and the check must see the same
 * snapshot as the write it guards.
 *
 * Pairs with a null shiftId (a rest day) are skipped — a rest day puts nobody on a shift.
 */
/** 07ebd04d — one employment's SCHEDULE GROUP id (`employment.attendance_rule_id`), or null. Read on its
 *  own rather than folded into a caller's select because the two walkability guards live in different
 *  files and must ask the question the same way. */
export async function groupRuleIdTx(tx: Tx, employmentId: string): Promise<string | null> {
  const [row] = await tx
    .select({ ruleId: employment.attendanceRuleId })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  return row?.ruleId ?? null;
}

export async function assertShiftsAllowedForEmploymentsTx(
  tx: Tx,
  pairs: readonly { employmentId: string; shiftId: string | null }[],
): Promise<void> {
  const real = pairs.filter((p): p is { employmentId: string; shiftId: string } => !!p.shiftId);
  if (real.length === 0) return;
  const employmentIds = [...new Set(real.map((p) => p.employmentId))];

  // 1. Which of these employments are in a group at all? None ⇒ nothing to enforce, and this is the
  //    release-day path for every caller.
  const grouped = await tx
    .select({ employmentId: employment.id, ruleId: employment.attendanceRuleId })
    .from(employment)
    .where(and(inArray(employment.id, employmentIds), isNotNull(employment.attendanceRuleId)));
  const groupOf = new Map<string, string>();
  for (const row of grouped) if (row.ruleId) groupOf.set(row.employmentId, row.ruleId);
  if (groupOf.size === 0) return;

  const ruleIds = [...new Set(groupOf.values())];
  const attemptedShiftIds = [...new Set(real.filter((p) => groupOf.has(p.employmentId)).map((p) => p.shiftId))];

  // 2. Every shift that matters in one read: the ones these groups ALLOW (rule_id ∈ ruleIds) and the ones
  //    actually being assigned (so the refusal can name the shift by name rather than by uuid).
  //    ORDER BY name — the allowed list goes into an error message, and an unordered list from a query
  //    makes the same refusal read differently on two runs (CLAUDE.md §8, pin invariants not positions).
  const shifts = await tx
    .select({ id: shift.id, name: shift.name, ruleId: shift.ruleId })
    .from(shift)
    .where(or(inArray(shift.ruleId, ruleIds), inArray(shift.id, attemptedShiftIds)))
    .orderBy(asc(shift.name), asc(shift.id));
  const shiftName = new Map(shifts.map((r) => [r.id, r.name]));
  const allowedByRule = new Map<string, { ids: Set<string>; names: string[] }>(ruleIds.map((r) => [r, { ids: new Set<string>(), names: [] }]));
  for (const r of shifts) {
    if (!r.ruleId) continue;
    const bucket = allowedByRule.get(r.ruleId);
    if (!bucket) continue;
    bucket.ids.add(r.id);
    bucket.names.push(r.name);
  }

  // 3. The group NAMES, for the message. The reporter reads these refusals, not uuids.
  const ruleRows = await tx
    .select({ id: attendanceRule.id, name: attendanceRule.name })
    .from(attendanceRule)
    .where(inArray(attendanceRule.id, ruleIds));
  const ruleName = new Map(ruleRows.map((r) => [r.id, r.name]));

  for (const pair of real) {
    const ruleId = groupOf.get(pair.employmentId);
    if (!ruleId) continue;
    const bucket = allowedByRule.get(ruleId);
    if (bucket?.ids.has(pair.shiftId)) continue;
    throw new ShiftNotInScheduleGroupError({
      groupName: ruleName.get(ruleId) ?? 'this Schedule Group',
      shiftName: shiftName.get(pair.shiftId) ?? null,
      allowed: bucket?.names ?? [],
    });
  }
}

