import type { AttendanceRuleView } from '@/core/attendance-rule';
import type { RuleShiftChoice } from './rule-form';

/**
 * 870b79e2 (r277) — build the "Shifts allowed" rows for one Schedule Group's form.
 *
 * A PLAIN, NON-'use client' MODULE, and separate from the form on purpose: both the New and the Edit page
 * are Server Components that need this shaping, and duplicating it in two pages is how two screens start
 * disagreeing about which group a shift is in. Pure — no session, no query — so it is unit-testable
 * without a database (test/schedule-group-shift-choices.test.ts).
 *
 * `ruleId` is null on the New form: nothing is ticked, but each row still says which group it would be
 * taken FROM, because that is the fact an administrator needs before they tick it.
 */
export function ruleShiftChoices(
  shifts: readonly { id: string; name: string; code: string | null; ruleId: string | null }[],
  rules: readonly Pick<AttendanceRuleView, 'id' | 'name'>[],
  ruleId: string | null,
): RuleShiftChoice[] {
  const nameOf = new Map(rules.map((r) => [r.id, r.name]));
  return shifts.map((sh) => {
    const inThisGroup = ruleId != null && sh.ruleId === ruleId;
    return {
      id: sh.id,
      name: sh.name,
      code: sh.code,
      inThisGroup,
      // Only when it is somewhere ELSE. A shift already in this group needs no "now in …" note, and a
      // shift in no group at all gets the explicit "no group yet" label from the form rather than a blank.
      otherGroupName: !inThisGroup && sh.ruleId ? (nameOf.get(sh.ruleId) ?? null) : null,
    };
  });
}
