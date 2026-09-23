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

/** aec53564 (r331) — ONE WEEKDAY of a week pattern, resolved to its kind.
 *
 *  `shiftDayKindFor` (core/attendance.ts) is this function with `isoWeekday(date)` in front of it, and it
 *  now calls this rather than repeating the four tests: the date→weekday step is what needed `isoWeekday`,
 *  not the pattern lookup, so only the step that needs it stays there. The Shift form's day row needs the
 *  lookup WITHOUT a date — it is editing a weekly template, not a calendar — and a client island cannot
 *  import core/attendance.ts at all, so before this the form carried its own copy (`kindOf` in
 *  app/admin/attendance/shift-form.tsx). That copy is gone.
 *
 *  Rest stays the COMPLEMENT — a weekday in none of the three arrays — which is exactly what "not ticked"
 *  has always meant. The arrays are pairwise disjoint (core/roster.ts, core/attendance-rule.ts, and a DB
 *  CHECK since 0429/0483), so the order of these tests cannot change an answer. */
export type WeekDayKind = 'full' | 'half' | 'rest' | 'off';
export const weekDayKindFor = (p: WeekPattern, isoDay: number): WeekDayKind => {
  if (p.pattern?.includes(isoDay)) return 'full';
  if (p.halfPattern?.includes(isoDay)) return 'half';
  if (p.offPattern?.includes(isoDay)) return 'off';
  return 'rest';
};

/** aec53564 — the INVERSE: seven chosen kinds back into the three arrays that are stored.
 *
 *  Rest has no array, exactly as an unticked checkbox had none. Full-empty ⇒ null rather than `[]`,
 *  because "no pattern at all" and "a week with no full day in it" are the same row today and
 *  core/roster.ts normalizeShiftInput already collapses them that way — a second spelling here would
 *  make the form and the service disagree about a shift that is all half-days. */
export const weekFromDayKinds = (kinds: Record<number, WeekDayKind>): WeekPattern => {
  const of = (want: WeekDayKind) =>
    [1, 2, 3, 4, 5, 6, 7].filter((d) => (kinds[d] ?? 'rest') === want);
  const full = of('full');
  return { pattern: full.length > 0 ? full : null, halfPattern: of('half'), offPattern: of('off') };
};

/** aec53564 — WHICH Schedule Group answers for a shift, chosen out of a list that is already loaded.
 *
 *  THE SAME CHAIN core/attendance-rule.ts `resolveRuleTx` walks — an explicit `rule_id` wins, otherwise the
 *  tenant's un-deletable `is_default` ("Standard") rule, otherwise nothing — expressed over an in-memory
 *  list because the two callers that need it cannot open a transaction: the Shift form's client island (a
 *  browser has no database) and the shift action, which has already read the rules to validate the posted
 *  id. It lives HERE, beside `weekPatternFor`, so the screen that greys a control and the action that
 *  refuses the matching write cannot pick different groups and disagree about the same POST.
 *
 *  ⚠️ THIS IS NOT A SECOND ANSWER TO "DOES THIS GROUP SET A WEEK". That question has exactly one answer —
 *  `weekPatternFor` — and this function only says WHOSE triple to hand it. */
export const weekPatternGroupFor = <G extends { id: string; isDefault: boolean }>(
  groups: readonly G[],
  ruleId: string | null | undefined,
): G | null => {
  const id = (ruleId ?? '').trim();
  return (id ? groups.find((g) => g.id === id) : groups.find((g) => g.isDefault)) ?? null;
};
