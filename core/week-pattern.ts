/**
 * 07ebd04d (r331) — WHICH DAYS ARE WORKED, as one leaf module with NO imports.
 *
 * `weekPatternWorkingDayCount` and `weekPatternFor` shipped in core/attendance.ts in r330 and are moved
 * here unchanged (core/attendance.ts re-exports both, so every existing import still resolves and the
 * attendance pack facade is untouched). The move exists for one reason: core/attendance-rule.ts — the
 * service that CREATES a Schedule Group — now has to enforce the write-side half of the same rule, and
 * core/attendance.ts already imports core/attendance-rule.ts. A leaf module is the way both sides share
 * ONE definition without a cycle; a second hand-written set union in the rule service is exactly what
 * r330 removed two of.
 *
 * `shiftDayKindFor` deliberately stays in core/attendance.ts: it needs `isoWeekday`, which the pack
 * drift ratchets quote by name as living there.
 */

/** b8aa3466 — the three arrays that decide WHICH DAYS are worked, carried as one value so the answer can
 *  be resolved once and handed to `shiftDayKindFor` rather than reassembled at every call site. */
export type WeekPattern = {
  pattern: number[] | null;
  halfPattern?: number[] | null;
  offPattern?: number[] | null;
};

/** b8aa3466 — how many WORKING weekdays a pattern declares, Full ∪ Half.
 *
 *  THE ONE DEFINITION. core/roster.ts and core/shift-arrangement.ts each guard "a backup shift with no
 *  working pattern makes every unrostered day a rest day" (see core/roster.ts assignEmployeeShift), and
 *  until 07ebd04d they answered it with two separately-written copies of the same set union. Off and Rest
 *  are deliberately NOT counted: neither is scheduled work. An all-half-days shift IS walkable and must
 *  not be rejected. */
export const weekPatternWorkingDayCount = (p: WeekPattern): number =>
  new Set([...(p.pattern ?? []), ...(p.halfPattern ?? [])]).size;

/** 07ebd04d — WHOSE WORKING WEEK IS THIS: the Schedule Group's, or the shift's?
 *
 *  The approved item moves `weekly_pattern` / `half_pattern` / `off_pattern` off `shift` and on to the
 *  Schedule Group (`attendance_rule`), because the group is what answers "which days are worked" while the
 *  shift answers "what hours are worked". This is the ONE place that decides which of the two a reader
 *  gets, so that every reader behaves identically before and after the data moves: pass the group's triple
 *  and the shift's, and use the result.
 *
 *  ⚠️ A GROUP WITH NO WORKING DAY DOES NOT WIN, AND THAT IS THE LOAD-BEARING PART. core/roster.ts
 *  assignEmployeeShift records why: a pattern that is NULL or empty "matches NOTHING, falls through to
 *  policyBranch('rest_day')", so an employee under it silently books every working day as a rest day and
 *  is paid rest-day overtime on ordinary work, with no error anywhere. A group row created without its
 *  patterns — the single most likely mistake in the migration that moves them — would do exactly that to
 *  everyone in the group at once. So the READ falls back to the shift, which is the value that is correct
 *  today, and `source` says which one answered so a report can show it rather than a caller guess.
 *
 *  That fallback is ALSO what keeps the tenant's un-deletable is_default ("Standard") rule harmless. It is
 *  the rule every shift with no `rule_id` resolves (core/attendance-rule.ts resolveRuleTx), migration 0483
 *  leaves its three arrays NULL on purpose, and so it can never impose a week on a shift that never
 *  joined a group.
 *
 *  The WRITE side is the other half: core/attendance-rule.ts normalizeInput refuses a group that declares
 *  a week it cannot walk, so the fallback here is never silently papering over a broken row. */
export const weekPatternFor = (
  group: WeekPattern | null | undefined,
  shift: WeekPattern,
): WeekPattern & { source: 'group' | 'shift' } =>
  group != null && weekPatternWorkingDayCount(group) > 0
    ? { pattern: group.pattern, halfPattern: group.halfPattern, offPattern: group.offPattern, source: 'group' }
    : { pattern: shift.pattern, halfPattern: shift.halfPattern, offPattern: shift.offPattern, source: 'shift' };
