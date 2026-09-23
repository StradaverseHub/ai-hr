'use server';

import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  getAttendanceRule,
  updateAttendanceRule,
  type AttendanceRuleInput,
  type AttendanceRuleView,
  type OtRowInput,
} from '@/core/attendance-rule';
import { SCHEDULE_GROUPS, failScheduleGroup, okScheduleGroup } from '../../_redirects';

/**
 * e4471e3c (r287) — the Schedule screen's OWN writers, and the reason they are not the rule editor's.
 *
 * ══ THE PROBLEM THESE EXIST TO SOLVE ═══════════════════════════════════════════════════════════════
 * The reporter asked for the Schedule Group settings to be editable where they are already shown. The
 * obvious implementation — draw the fields and post them to `updateAttendanceRuleAction` — is a
 * data-loss bug, and a serious one:
 *
 * `ruleFields()` in app/admin/attendance-policy/rule-actions.ts builds a COMPLETE `AttendanceRuleInput`
 * out of the submission, and `updateAttendanceRule` writes every one of those columns and REPLACES the
 * overtime-band table wholesale. A form carrying only the two grace periods would therefore have saved:
 *
 *   · `name: ''`            — refused, or worse, accepted as a blank name;
 *   · `applyDeductions: false` — THE DEDUCTION SWITCH TURNED OFF, silently, from a section that does not
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
 * fields its own section renders. Anything the section does not show cannot be changed by posting to it —
 * not by omission, not by a crafted request body, not by a stale page. `applyDeductions` is taken from
 * the STORED ROW and is never read from the form at all (see below), and the overtime bands are rebuilt
 * from the stored rows with only the rounding columns overlaid, matched BY THE BAND'S "FROM" BOUNDARY
 * rather than by position or row id.
 *
 * The write itself goes through the SAME `updateAttendanceRule` the rule editor calls, so the stored row
 * and the `attendance-rule.updated` audit event are identical in shape to a save from that editor. This
 * is not a second service; it is a narrower caller of the one service.
 *
 * ══ THE ONE SETTING THAT DID NOT MOVE, AND WHY ═════════════════════════════════════════════════════
 * `apply_deductions` + `deductions_effective_from` (7c834696 stage 1, migration 0394) stay on the
 * Schedule Group's own General section (rules/rule-form.tsx). The effective-from date is STAMPED BY THE
 * SERVICE the moment the switch flips and can never be typed, and a DB CHECK from 0394 makes
 * "deductions on with no start date" unrepresentable — together, that is what stops a deduction reaching
 * a payroll month that is already closed. A second form over that switch is a second way to get the date
 * wrong. The Attendance section shows the switch read-only with a link to the section that owns it.
 * docs/audits/665de026-schedule-save-classification.md §3 b6 records why that makes the rule editor a
 * RECORD-LIFECYCLE form rather than a field edit, and why no screen-wide Save/Discard was built here.
 *
 * Carrying the stored value forward is safe and idempotent: `updateAttendanceRule` reads the rule's
 * current switch state before writing and `resolveDeductionStart` keeps an already-on rule's existing
 * date, so re-saving through these actions cannot move a start date forward either.
 *
 * ══ 665de026 (r331) — WHERE A SAVE RETURNS TO, AND THE THIRD ACTION ════════════════════════════════
 * Until this round every save here redirected to `/admin/attendance/schedule?tab=<tab>&group=<id>` — a
 * tabbed screen that carried every Schedule Group at once. The reporter contested that shape; Schedule is
 * list + detail now and a save STAYS ON THE RECORD, on the section it was made from, with a confirmation
 * (`okScheduleGroup` / `failScheduleGroup` in app/admin/_redirects.ts — okCompany's contract, r329).
 *
 * `saveScheduleGroupWeekAction` is new and is the only genuinely new writer in the item: 07ebd04d
 * (r331, migration 0483) gave `attendance_rule` a working week and nothing on any screen read or wrote
 * it. See its own header for the two CHECK constraints it must never be able to violate.
 */

/** Where a save returns to when the rule it names is gone. Built here, never taken from the request body. */
const SCHEDULE = SCHEDULE_GROUPS;

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
    // ⚠️ FROM THE STORED ROW, NEVER FROM `fd`. See the header. Neither of the two tab actions reads a form
    // field called `applyDeductions`, so no submission to either of them can flip the deduction switch.
    applyDeductions: rule.applyDeductions,
    // ⚠️ THE WORKING WEEK IS DELIBERATELY ABSENT FROM THIS OBJECT AND MUST STAY ABSENT.
    // 07ebd04d: `AttendanceRuleInput`'s three week fields are OPTIONAL and `undefined` means "not
    // supplied", not "empty". `updateAttendanceRule` writes the three columns only when at least one of
    // them is present (`hasWeekInput`), so a base that never mentions the week leaves the stored week
    // untouched. Spreading `weeklyPattern: rule.weeklyPattern` in "for completeness" would be harmless
    // today and a wipe the moment someone passed a rule read with a narrower select — the service's own
    // guard is the one that must do this job. `saveScheduleGroupWeekAction` is the ONLY action here that
    // supplies them, and it supplies all three together.
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

/**
 * Load the rule this submission names, or refuse with a message rather than writing against nothing.
 *
 * 665de026 — the refusal lands on the LIST, not on a per-group page: the group is gone, so there is no
 * record page to stay on. That is the one case where being sent back to the list is the correct answer.
 */
async function loadRule(ruleId: string) {
  const s = await getSession();
  const rule = ruleId ? await getAttendanceRule(s, ruleId) : null;
  if (!rule) {
    redirect(
      `${SCHEDULE}?error=${encodeURIComponent('That Schedule Group no longer exists. Pick one from the list.')}`,
    );
  }
  return { s, rule };
}

/**
 * THE ATTENDANCE SECTION — the grace periods and the two "after X, record Y" pairs.
 *
 * Exactly the six figures the section already displayed, made editable. Nothing else on `attendance_rule`
 * moves here: the deduction switch stays on the General section (header), and the settings the approved
 * e5ff7189 / d91aee93 plans put in LATER stages are not on this section to edit.
 */
export async function saveScheduleGroupAttendanceAction(fd: FormData) {
  const ruleId = String(fd.get('ruleId') ?? '');
  const { s, rule } = await loadRule(ruleId);
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
    failScheduleGroup(e, ruleId, 'attendance');
  }
  const t = await getTranslations('admin.scheduleConfig');
  okScheduleGroup(ruleId, t('savedToast'), 'attendance');
}

/**
 * THE OVERTIME SECTION — the before-shift overtime switch and the per-band rounding.
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
 *    section, or the rule editor, or another window; the rounding edit would then be silently discarded,
 *    and the operator would see a 303 back to a screen still showing the old value.
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
 * General section with the deduction switch.
 */
export async function saveScheduleGroupOvertimeAction(fd: FormData) {
  const ruleId = String(fd.get('ruleId') ?? '');
  const { s, rule } = await loadRule(ruleId);
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
    failScheduleGroup(e, ruleId, 'overtime');
  }
  const t = await getTranslations('admin.scheduleConfig');
  okScheduleGroup(ruleId, t('savedToast'), 'overtime');
}

/**
 * ─── 665de026 · THE WORKING DAY / SCHEDULE PATTERN SECTION ───────────────────────────────────────────
 *
 * THE ONLY GENUINELY NEW WRITER IN THIS ITEM. 07ebd04d (r331, migration 0483) put `weekly_pattern`,
 * `half_pattern` and `off_pattern` onto `attendance_rule` and core/attendance-rule.ts has exposed and
 * validated them since — but until now NO SCREEN read or wrote the group's week. Every pattern control
 * in `app/` and `components/` edits the SHIFT's week (`components/shift-time-fields.tsx` →
 * `app/admin/attendance/shift-actions.ts`). The group says WHICH DAYS are worked; the shift says WHAT
 * HOURS. This is the group half.
 *
 * ══ THE FORM SHAPE IS THE FIRST CONSTRAINT, NOT A STYLE CHOICE ═════════════════════════════════════
 * Seven `<select name="dayKind_<1..7>">`, one per ISO weekday, each posting exactly one of
 * `full | half | off | rest` — the identical shape and the identical decode `shift-actions.ts` uses for
 * the shift, so the two halves of one idea are entered the same way.
 *
 * That shape makes the FIRST of migration 0483's two CHECK constraints unreachable:
 *
 *   · `attendance_rule_day_kinds_disjoint` — no weekday may appear in two of the three lists. A day
 *     posts ONE value, so it lands in at most one list. There is no submission, crafted or otherwise,
 *     that can put a day in two — a checkbox triple could, which is exactly why this is not one.
 *   · `attendance_rule_off_needs_working_day` — a group that declares Off days must declare at least one
 *     working day. This one IS reachable (set every day to Off, or Off and Rest). `normalizeWeekPattern`
 *     refuses it with a sentence an administrator can act on, BEFORE the statement reaches Postgres, so
 *     the operator never sees a constraint name. Both halves are tested.
 *
 * ══ THE MARKER, AGAIN, AND FOR A DIFFERENT REASON ══════════════════════════════════════════════════
 * A `<select>` is always submitted, so the seven day fields cannot go missing the way a checkbox can.
 * But `undefined` and `[]` mean DIFFERENT THINGS to `updateAttendanceRule`: supplying all three arrays
 * empty is how a week is deliberately CLEARED, and supplying none of them is how every other caller
 * leaves the week alone. A submission that reached this action carrying no `dayKind_*` at all would
 * therefore decode to three empty arrays and CLEAR the group's week — a wipe from a form that had said
 * nothing. `weekEditor=1` is compared as a VALUE and nothing is written without it.
 *
 * ══ NOTHING ELSE MOVES ═════════════════════════════════════════════════════════════════════════════
 * `carryForward` supplies every other column verbatim and deliberately omits the week, so this is the
 * one action in this file whose input mentions the three columns — and it mentions all three together,
 * which is the only way `hasWeekInput` is true without being half-true.
 */
const DAY_KINDS = ['full', 'half', 'off', 'rest'] as const;
type DayKind = (typeof DAY_KINDS)[number];
/** The compact echo of what was typed, one character per ISO weekday: F | H | O | R. */
const KIND_CHAR: Record<DayKind, string> = { full: 'F', half: 'H', off: 'O', rest: 'R' };

/**
 * What the operator typed, as ONE already-encoded `&` parameter for `failScheduleGroup`.
 *
 * "Nothing you entered is lost" (the a485afa1 rev 2 contract on the schedule-assignment detail page).
 * The only refusal this form can raise is "you declared Off days and no working day", and it is fixed by
 * changing ONE dropdown — re-rendering the other six from the STORED row would silently undo six edits
 * the operator had already made. Seven characters from a four-letter alphabet: the page validates the
 * shape and drops anything else, so it can never widen what the form accepts.
 */
function weekParam(kinds: readonly DayKind[]): string {
  return `&typedWeek=${kinds.map((k) => KIND_CHAR[k]).join('')}`;
}

export async function saveScheduleGroupWeekAction(fd: FormData) {
  const ruleId = String(fd.get('ruleId') ?? '');
  const { s, rule } = await loadRule(ruleId);
  // The marker, as a VALUE — see the header. Without it, three empty arrays would be indistinguishable
  // from "clear this group's week", and a submission that said nothing would wipe it.
  if (fd.get('weekEditor') !== '1') {
    failScheduleGroup(
      new Error('That form did not carry the working-week controls, so nothing was changed.'),
      ruleId,
      'workingDay',
    );
  }
  const kinds: DayKind[] = [];
  for (let d = 1; d <= 7; d++) {
    const raw = String(fd.get(`dayKind_${d}`) ?? '');
    // An unrecognised value falls to 'rest', which is what "in none of the three lists" already means —
    // this is a <select>, not free text, so the fallback is a shape check rather than a business rule.
    kinds.push((DAY_KINDS as readonly string[]).includes(raw) ? (raw as DayKind) : 'rest');
  }
  const weeklyPattern: number[] = [];
  const halfPattern: number[] = [];
  const offPattern: number[] = [];
  kinds.forEach((kind, i) => {
    const d = i + 1;
    if (kind === 'full') weeklyPattern.push(d);
    else if (kind === 'half') halfPattern.push(d);
    else if (kind === 'off') offPattern.push(d);
  });
  try {
    // All three together. `normalizeWeekPattern` raises the readable refusal for a declared-but-unwalkable
    // week before Postgres ever sees the UPDATE; the disjointness CHECK cannot fire at all (header).
    await updateAttendanceRule(s, { ruleId, ...carryForward(rule), weeklyPattern, halfPattern, offPattern });
  } catch (e) {
    failScheduleGroup(e, ruleId, 'workingDay', weekParam(kinds));
  }
  const t = await getTranslations('admin.scheduleConfig');
  okScheduleGroup(ruleId, t('savedToast'), 'workingDay');
}
