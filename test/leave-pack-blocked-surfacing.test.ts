/**
 * ADR-0077 slice 6 — a leave sweep that cannot compute an employee REPORTS it.
 *
 * Four loops in core/leave.ts used to say `if (!pack) continue`. createCompany's own comment names the
 * consequence: "LEAVE fails SILENT — the engines `continue` past a packless employee and the holiday
 * resolver yields an empty calendar, so the employee accrues nothing and nobody is told."
 *
 * The skip is correct and stays — statutory entitlement cannot be computed without a jurisdiction, and
 * inventing one would be worse. What changed is that it is no longer invisible.
 *
 * WHY THIS LANDS BEFORE THE NON-STATUTORY TIER: today every company is MY and the pack always resolves,
 * so the branch is unreachable. Slice 6's tier makes packless companies a legitimate, deliberate state.
 * Shipping that first would manufacture zero-accrual employees nobody could see.
 *
 * SOURCE-LEVEL, deliberately. The condition cannot be reached through the service layer —
 * `createCompany` calls `requirePackFor` and refuses a packless country outright — so a behavioural
 * test would have to fabricate a company the product refuses to create, and would then be asserting
 * against a state the rest of the system does not believe in. What is worth pinning is that no loop
 * silently drops an employment again.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'core/leave.ts'), 'utf8');

describe('no leave sweep skips an employment silently', () => {
  // The exact shape that was there before: a bare continue on an unresolvable pack.
  it('has no `if (!pack) continue` left', () => {
    expect(SRC).not.toMatch(/if \(!pack\) continue;/);
  });

  it('every unresolvable-pack branch records the employment and the reason', () => {
    // 6e9a126e RELEASE THREE — WAS FOUR, IS NOW THREE. reprojectEntitlementForPolicy reprojected
    // entitlement when a leave_policy row changed; 0410 drops that table, so the sweep went with it.
    // The surviving three are openLeaveYear, accrueEarnedLeave and reprojectA2cEntitlement.
    const branches = SRC.match(/if \(!pack\) \{/g) ?? [];
    expect(branches.length, 'the three accrual/reproject sweeps').toBe(3);
    const pushes = SRC.match(/reason: 'country_pack_inactive'/g) ?? [];
    // One push per branch, plus the type declaration's own literal.
    expect(pushes.length).toBeGreaterThanOrEqual(branches.length);
  });

  it('surfaces the blocked list on every sweep that can produce one', () => {
    // CORRECTED (93249794): these pinned the EXACT return literal, so adding a field to a sweep's
    // result broke a guard whose subject — "packBlocked reaches the caller" — was never in question.
    // openLeaveYear grew `rows` (the per-employee verdicts the dry run needs) and this failed while
    // packBlocked was still right there in the same return. Same mistake two guards made in r138:
    // asserting an implementation where they meant an invariant. Now each sweep's return must CARRY
    // packBlocked; what else rides along is that sweep's business.
    expect(SRC).toMatch(/return \{ granted, skipped, forfeits, packBlocked[^}]*\};/);
    expect(SRC).toMatch(/return \{ granted, forfeits, breakdown, packBlocked[^}]*\};/);
    // 6e9a126e RELEASE THREE — WAS 2, IS NOW 1. Both sweeps of this shape were reproject-style;
    // reprojectEntitlementForPolicy is gone with leave_policy, leaving reprojectA2cEntitlement.
    //
    // I first tried to DERIVE this from the count of reproject* functions so it could not go stale —
    // and got it wrong: reprojectEntitlementForEmployment and reprojectEntitlementForLeaveTypeCohort
    // exist but sweep no packs, so the derived number was 3 against a real 1. The literal is the honest
    // statement here; the invariant this file cares about ("packBlocked reaches the caller") is already
    // pinned per-sweep by the two toMatch assertions above, which do not depend on any count.
    expect((SRC.match(/return \{ affected, totalDelta, packBlocked[^}]*\};/g) ?? []).length).toBe(1);
  });

  // An early "nothing to do" return must still carry the field, or callers have to defend against
  // undefined and the honest empty list becomes a special case.
  it('early returns carry an empty blocked list rather than omitting it', () => {
    expect(SRC).toContain('const none = { affected: 0, totalDelta: 0, packBlocked: [] as PackBlockedEmployment[] };');
    // r285 (cf9dcb98) — THE EARNED-ACCRUAL SWEEP NOW FUNNELS EVERY EMPTY EXIT THROUGH ONE HELPER, and that
    // is strictly stronger than the one-line literal this used to grep for. Previously each `return` had to
    // remember `packBlocked: []` on its own; now none of them can omit it, because none of them constructs
    // the result — `emptyResult` does, and its own comment says a new exit "cannot ship without deciding
    // what it says". So assert the funnel and its field rather than a spelling that adding a field breaks.
    const e = SRC.indexOf('const emptyResult = async (');
    expect(e, 'the earned-accrual sweep still funnels every empty return through one helper').toBeGreaterThan(0);
    expect(SRC.slice(e, e + 600), 'that helper still carries an empty blocked list').toContain('packBlocked: [],');
  });

  // reprojectEntitlementForEmployment has no such loop; giving it the field would imply a check it
  // does not make.
  it('does not add the field to the sweep that has no pack loop', () => {
    const i = SRC.indexOf('export async function reprojectEntitlementForEmployment');
    expect(i).toBeGreaterThan(0);
    const body = SRC.slice(i, i + 2000);
    expect(body).toContain('const none = { affected: 0, totalDelta: 0 };');
  });
});
