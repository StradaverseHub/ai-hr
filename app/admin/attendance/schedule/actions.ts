'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  getAttendanceRule,
  updateAttendanceRule,
  type AttendanceRuleInput,
  type AttendanceRuleView,
  type OtRowInput,
} from '@/core/attendance-rule';

/**
 * e4471e3c (r287) — the Schedule screen's OWN writers, and the reason they are not the rule editor's.
 *
 * ══ THE PROBLEM THESE EXIST TO SOLVE ═══════════════════════════════════════════════════════════════
 * The reporter asked for the Schedule Group settings to be editable on the Attendance and Overtime tabs
 * of Attendance › Schedule, where they are already shown. The obvious implementation — draw the fields
 * and post them to `updateAttendanceRuleAction` — is a data-loss bug, and a serious one:
 *
 * `ruleFields()` in app/admin/attendance-policy/rule-actions.ts builds a COMPLETE `AttendanceRuleInput`
 * out of the submission, and `updateAttendanceRule` writes every one of those columns and REPLACES the
 * overtime-band table wholesale. A form carrying only the two grace periods would therefore have saved:
 *
 *   · `name: ''`            — refused, or worse, accepted as a blank name;
 *   · `applyDeductions: false` — THE DEDUCTION SWITCH TURNED OFF, silently, from a screen that does not
 *                            show it. That is the one setting this round was told to leave alone;
 *   · `otRows: []`          — every overtime band DELETED, because `parseOtRows('')` is `[]` and the
 *                            service deletes-then-inserts.
 *
 * A checkbox absent from a submission and a checkbox the administrator unticked are the same bytes, so
 * nothing in the action could have told the difference. That is the "making a read-only surface editable
 * adds a WRITER" risk, and it is why the layout was never the hard part of this item.
 *
 * ══ HOW THEY WORK: READ, OVERLAY THE SECTION'S OWN FIELDS, WRITE ═══════════════════════════════════
 * Each action re-reads the stored rule and carries EVERY column forward verbatim, then overlays only the
 * fields its own tab renders. Anything the tab does not show cannot be changed by posting to it — not by
 * omission, not by a crafted request body, not by a stale tab. `applyDeductions` is taken from the STORED
 * ROW and is never read from the form at all (see below), and the overtime bands are rebuilt from the
 * stored rows with only the rounding columns overlaid, matched BY ROW ID rather than by position.
 *
 * The write itself goes through the SAME `updateAttendanceRule` the rule editor calls, so the stored row
 * and the `attendance-rule.updated` audit event are identical in shape to a save from that editor. This
 * is not a second service; it is a narrower caller of the one service.
 *
 * ══ THE ONE SETTING THAT DID NOT MOVE, AND WHY ═════════════════════════════════════════════════════
 * `apply_deductions` + `deductions_effective_from` (7c834696 stage 1, migration 0394) stay on the
 * Schedule Group editor at /admin/attendance-policy/rules/[ruleId]. The effective-from date is STAMPED BY
 * THE SERVICE the moment the switch flips and can never be typed, and a DB CHECK from 0394 makes
 * "deductions on with no start date" unrepresentable — together, that is what stops a deduction reaching
 * a payroll month that is already closed. A second form over that switch is a second way to get the date
 * wrong. The reporter was told this in the plan they approved, and the Attendance tab shows the switch
 * read-only with a link to the editor that owns it.
 *
 * Carrying the stored value forward is safe and idempotent: `updateAttendanceRule` reads the rule's
 * current switch state before writing and `resolveDeductionStart` keeps an already-on rule's existing
 * date, so re-saving through these actions cannot move a start date forward either.
 */

/** Where a save returns to — the tab it was made on. Built here, never taken from the request body. */
const SCHEDULE = '/admin/attendance/schedule';
const back = (tab: 'attendance' | 'overtime', groupId: string, extra = '') =>
  `${SCHEDULE}?tab=${tab}&group=${encodeURIComponent(groupId)}${extra}`;

/**
 * A whole number of minutes from the form, falling back to the STORED value when the field is absent.
 *
 * Deliberately not `Number(fd.get(k) ?? 0) || 0` (the rule editor's `num`): here an absent field means
 * "this submission did not carry that control", and coercing it to 0 would let a partial post zero a
 * setting. A present-but-unparseable value is a refusal, not a silent 0 — an administrator who typed
 * nonsense into a grace period must be told, not have it saved as "no grace".
 */
function minutesOr(fd: FormData, key: string, current: number, label: string): number {
  const raw = fd.get(key);
  if (raw == null) return current;
  const n = Math.trunc(Number(String(raw).trim()));
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a non-negative whole number of minutes.`);
  }
  return n;
}

/** Every column of the stored rule, as the input shape the service takes. The BASE of every overlay. */
function carryForward(rule: AttendanceRuleView): AttendanceRuleInput {
  return {
    name: rule.name,
    description: rule.description,
    // The column is a plain text/enum on the row; the input type is the narrowed union. Normalised here
    // rather than cast, so an unexpected stored value becomes 'active' (the screen's own default) instead
    // of being forced through a lie about the type.
    status: rule.status === 'inactive' ? 'inactive' : 'active',
    lateGracePeriodMinutes: rule.lateGracePeriodMinutes,
    lateAfterMinutes: rule.lateAfterMinutes,
    lateDeductMinutes: rule.lateDeductMinutes,
    includeGraceInLateness: rule.includeGraceInLateness,
    earlyGracePeriodMinutes: rule.earlyGracePeriodMinutes,
    earlyAfterMinutes: rule.earlyAfterMinutes,
    earlyDeductMinutes: rule.earlyDeductMinutes,
    includeGraceInEarlyOut: rule.includeGraceInEarlyOut,
    applyToEarlyOt: rule.applyToEarlyOt,
    // ⚠️ FROM THE STORED ROW, NEVER FROM `fd`. See the header. Neither of these actions reads a form field
    // called `applyDeductions`, so no submission to either of them can flip the deduction switch.
    applyDeductions: rule.applyDeductions,
    otRows: rule.otRows.map(toOtInput),
  };
}

/** One stored overtime band, as the input shape — boundaries, pattern and RATES preserved exactly. */
function toOtInput(row: AttendanceRuleView['otRows'][number]): OtRowInput {
  return {
    fromMinutes: row.fromMinutes,
    toMinutes: row.toMinutes,
    ratePattern: row.ratePattern,
    rate: row.rate == null ? null : Number(row.rate),
    phRate: row.phRate == null ? null : Number(row.phRate),
    roundingMode: row.roundingMode,
    roundToMinutes: row.roundToMinutes,
  };
}

/** Load the rule this submission names, or refuse with a message rather than writing against nothing. */
async function loadRule(ruleId: string, tab: 'attendance' | 'overtime') {
  const s = await getSession();
  const rule = ruleId ? await getAttendanceRule(s, ruleId) : null;
  if (!rule) {
    redirect(
      `${SCHEDULE}?tab=${tab}&error=${encodeURIComponent('That Schedule Group no longer exists. Pick one from the list above.')}`,
    );
  }
  return { s, rule };
}

/**
 * THE ATTENDANCE TAB — the grace periods and the two "after X, record Y" pairs.
 *
 * Exactly the six figures the tab already displayed, made editable. Nothing else on `attendance_rule`
 * moves here: the deduction switch stays on the Schedule Group editor (header), and the settings the
 * approved e5ff7189 / d91aee93 plans put in LATER stages are not on this tab to edit.
 */
export async function saveScheduleGroupAttendanceAction(fd: FormData) {
  const ruleId = String(fd.get('ruleId') ?? '');
  const { s, rule } = await loadRule(ruleId, 'attendance');
  try {
    const base = carryForward(rule);
    await updateAttendanceRule(s, {
      ruleId,
      ...base,
      lateGracePeriodMinutes: minutesOr(fd, 'lateGracePeriodMinutes', base.lateGracePeriodMinutes, 'Late in grace'),
      earlyGracePeriodMinutes: minutesOr(fd, 'earlyGracePeriodMinutes', base.earlyGracePeriodMinutes, 'Early out grace'),
      lateAfterMinutes: minutesOr(fd, 'lateAfterMinutes', base.lateAfterMinutes, 'Late in — after'),
      lateDeductMinutes: minutesOr(fd, 'lateDeductMinutes', base.lateDeductMinutes, 'Late in — minutes recorded'),
      earlyAfterMinutes: minutesOr(fd, 'earlyAfterMinutes', base.earlyAfterMinutes, 'Early out — after'),
      earlyDeductMinutes: minutesOr(fd, 'earlyDeductMinutes', base.earlyDeductMinutes, 'Early out — minutes recorded'),
    });
  } catch (e) {
    redirect(back('attendance', ruleId, `&error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(SCHEDULE);
  redirect(back('attendance', ruleId));
}

/**
 * THE OVERTIME TAB — the before-shift overtime switch and the per-band rounding.
 *
 * ⚠️ TWO TRAPS, BOTH OF WHICH THIS REPO HAS ALREADY BEEN BITTEN BY ON THIS EXACT TABLE.
 *
 * 1. THE SWITCH RIDES A MARKER, READ AS A VALUE. A browser omits an unchecked checkbox entirely, so
 *    "the administrator turned it off" and "this submission did not carry the control" are the same
 *    bytes. Without the marker, the switch could never be turned off — or, read the other way, a
 *    submission from another form would turn it off. The marker is a hidden field compared to '1',
 *    never tested for presence: that is the correction 7c834696 had to make to `bool` in
 *    ../../attendance-policy/rule-actions.ts, on this same setting.
 *
 * 2. THE BANDS ARE MATCHED BY THEIR "FROM" BOUNDARY — NOT BY POSITION, AND NOT BY ROW ID.
 *
 *    Position is obviously wrong: a band added or removed between render and submit would shift a
 *    rounding setting onto the wrong hours of overtime. But the ROW ID is wrong too, and it took a live
 *    save to see it. `updateAttendanceRule` replaces the band table WHOLESALE — delete, then insert —
 *    so every `attendance_rule_ot_row.id` CHANGES on every save of the rule, from any screen. An
 *    id-keyed form therefore stops matching anything the moment the rule is saved from the Attendance
 *    tab, or the rule editor, or another window; the rounding edit would then be silently discarded, and
 *    the operator would see a 303 back to a screen still showing the old value.
 *
 *    `fromMinutes` is the band's identity in this table: the ladder validation
 *    (core/attendance-rule.ts validateOtLadder) requires a continuous, non-overlapping sequence, so no
 *    two bands of one rule can share a "From". It survives the delete-and-reinsert, and when a boundary
 *    genuinely HAS moved the stale key matches nothing and that band keeps its stored rounding — which
 *    is the correct outcome for an edit made against a table that has since changed shape.
 *    "Pin invariants, not positions" (CLAUDE.md §8) — the boundary is the invariant; the id is not.
 *
 * The band boundaries, the rate pattern and both rates are carried forward verbatim and are NOT editable
 * here. They are the overtime ladder — money, and a continuous-ladder validation — and they stay on the
 * Schedule Group editor with the deduction switch.
 */
export async function saveScheduleGroupOvertimeAction(fd: FormData) {
  const ruleId = String(fd.get('ruleId') ?? '');
  const { s, rule } = await loadRule(ruleId, 'overtime');
  try {
    const base = carryForward(rule);
    // Trap 1 — the marker, as a VALUE.
    const carriedEarlyOt = fd.get('earlyOtEditor') === '1';
    const applyToEarlyOt = carriedEarlyOt ? fd.get('applyToEarlyOt') === 'on' : base.applyToEarlyOt;
    // Trap 2 — overlay rounding onto the STORED bands, matched by the band's "From" boundary.
    const otRows = rule.otRows.map((row) => {
      const stored = toOtInput(row);
      const modeRaw = fd.get(`roundingMode_${row.fromMinutes}`);
      if (modeRaw == null) return stored; // this submission said nothing about this band
      const roundingMode =
        modeRaw === 'down' || modeRaw === 'up' ? (modeRaw as 'down' | 'up') : ('none' as const);
      const stepRaw = fd.get(`roundToMinutes_${row.fromMinutes}`);
      const step =
        roundingMode === 'none'
          ? null
          : stepRaw == null || String(stepRaw).trim() === ''
            ? stored.roundToMinutes
            : Math.trunc(Number(stepRaw)) || null;
      if (roundingMode !== 'none' && step != null && step < 0) {
        throw new Error('Round to must be a non-negative whole number of minutes.');
      }
      return { ...stored, roundingMode, roundToMinutes: step };
    });
    await updateAttendanceRule(s, { ruleId, ...base, applyToEarlyOt, otRows });
  } catch (e) {
    redirect(back('overtime', ruleId, `&error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(SCHEDULE);
  redirect(back('overtime', ruleId));
}
