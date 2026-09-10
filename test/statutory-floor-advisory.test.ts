/**
 * THE STATUTORY MINIMUM IS ADVISORY, NOT AN OVERRIDE (r88, feedback fa3f4ccb).
 *
 * Until this change the entitlement composition was `max(statutoryFloor, configured)`. A configured figure
 * below the Employment Act minimum was silently replaced by the minimum, and nothing on screen said so.
 * The reporter asked for that override to be removed twice, and approved it in writing on the stated
 * record that the people maintaining this are trained HR practitioners and that responsibility for staying
 * lawful now sits with whoever configures the entitlement.
 *
 * This file is the ratchet for that decision, in both directions:
 *   1. WHAT CHANGED — a configured figure below a REAL Malaysian statutory band resolves to the configured
 *      figure, end to end, and raises the below-minimum warning flag. Asserted against ANNUAL at 0 years
 *      of service (EA 1955 s.60E ⇒ 8 days), not a fixture floor of 0, or the test would pass whatever the
 *      composition did.
 *   2. WHAT DID NOT — the EA-1955 right to APPLY for annual/sick leave, and the updateLeaveType guard that
 *      stops a lawful-entitlement code being misconfigured, are DIFFERENT protections. Neither was asked
 *      about, and both are pinned here so a later reader cannot mistake this change for a wider one.
 *
 * ⚠️ 6e9a126e RELEASE THREE — WHAT THIS FILE LOST, AND WHY THAT IS NOT A WEAKENING.
 * The composition it ratchets used to be `entitledDays(floor, template, scheme, policy)`. Two of those
 * four layers are dropped tables, so the engine-side assertions move to `composeEntitlement`, which is the
 * single composition hook every engine now calls — same question, one layer instead of three, and the
 * below-minimum flag asserted in exactly the same directions.
 * The PREVIEW half is retired outright rather than repointed: `previewEntitlement` and
 * `components/leave-rule-preview.tsx` are both deleted by this release (the checker read ACTIVE
 * leave_policy rows, so against the template layer it would have answered "—" to every question while
 * still looking live), and `admin.leave.previewBelowFloorWarning` is gone from all six locales with it.
 * A test asserting a deleted component reads a deleted key cannot fail honestly. The surviving prose
 * guard — that no screen still CLAIMS the minimum overrides the configured figure — is kept, because that
 * claim is what the reporter actually asked to be removed and `admin.leave.typesHelp` still renders.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { openLeaveYear } from '../core/leave';
import { belowStatutoryFloor, composeEntitlement, type ServiceBand } from '../core/leave-compute';
import { entitlement as myEntitlement } from '../localization/my/leave';
import {
  adminCtx,
  closeAll,
  ledgerBalance,
  migrateTestDb,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

// The REAL statutory band this file measures against: EA 1955 s.60E, annual leave, under 2 years' service.
const MY_ANNUAL_FLOOR_0Y = myEntitlement('ANNUAL', 0);

describe('fa3f4ccb · the pack still reports a real statutory band (the yardstick this file uses)', () => {
  it('MY ANNUAL at 0 years is a non-zero figure, so a below-minimum test cannot pass vacuously', () => {
    expect(MY_ANNUAL_FLOOR_0Y).toBeGreaterThan(0);
    expect(MY_ANNUAL_FLOOR_0Y).toBe(8);
  });
});

describe('fa3f4ccb · the composition: configured wins, the minimum only flags', () => {
  /** A flat band, the shape `seedEntitlement`'s `annualDays` shorthand stores and the resolver returns. */
  const band = (days: number): ServiceBand => ({ fromYears: 0, toYears: null, days });

  it('composeEntitlement resolves to the configured band, whatever the floor says', () => {
    // RELEASE THREE: was `entitledDays(floor, template, scheme, policy)`. The scheme and policy slots went
    // with their tables; the question is unchanged and is now asked of the one composition every engine
    // calls.
    expect(composeEntitlement({ floorDays: 8, templateBand: band(12), rules: undefined }).days).toBe(12);
    expect(composeEntitlement({ floorDays: 8, templateBand: band(15), rules: undefined }).days).toBe(15);
    // The case the whole item is about: a configured 5 under an 8-day minimum stays 5.
    expect(composeEntitlement({ floorDays: 8, templateBand: band(5), rules: undefined }).days).toBe(5);
    // …and the floor did not come back when the layer changed: a below-minimum TEMPLATE is granted as
    // configured, which is the assertion the retired scheme/policy variants were each restating.
    expect(composeEntitlement({ floorDays: 16, templateBand: band(5), rules: undefined }).days).toBe(5);
  });

  it('composeEntitlement raises belowStatutoryFloor exactly when the RESOLVED figure is under the minimum', () => {
    expect(composeEntitlement({ floorDays: 8, templateBand: band(5), rules: undefined }).belowStatutoryFloor).toBe(true);
    // Equal is not below.
    expect(composeEntitlement({ floorDays: 8, templateBand: band(8), rules: undefined }).belowStatutoryFloor).toBe(false);
    // Above the minimum ⇒ no warning, however far above.
    expect(composeEntitlement({ floorDays: 8, templateBand: band(15), rules: undefined }).belowStatutoryFloor).toBe(false);
    // The flag judges the WINNER, and there is now exactly one winner to judge — the resolved band, never
    // the raw figure of some layer that lost.
    expect(composeEntitlement({ floorDays: 16, templateBand: band(15), rules: undefined }).belowStatutoryFloor).toBe(true);
  });

  it('belowStatutoryFloor is inert where no statutory pack applies (every non-MY company today)', () => {
    // Those jurisdictions already ran with no floor. This change makes MY behave like them, so a null /
    // non-finite floor must never raise the flag — not even against a configured 0.
    expect(belowStatutoryFloor(null, 0)).toBe(false);
    expect(belowStatutoryFloor(undefined, 0)).toBe(false);
    expect(belowStatutoryFloor(Number.NaN, 0)).toBe(false);
  });
});

/*
 * ── RETIRED BY 6e9a126e RELEASE THREE ────────────────────────────────────────────────────────────────
 * TWO BLOCKS ARE GONE FROM HERE, AND THIS NOTE IS THE RECORD OF WHAT COVERAGE WENT WITH THEM.
 *
 *  1. 'the admin preview cannot disagree with a real grant' — two cases proving `previewEntitlement`
 *     returned the same days and the same below-minimum flag as the engine, and that it carried the floor
 *     figure so the warning could quote it. `previewEntitlement` no longer exists.
 *  2. 'the preview component reads result.belowStatutoryFloor …' and 'every locale carries the warning
 *     string' — source-level guards over `components/leave-rule-preview.tsx` and
 *     `admin.leave.previewBelowFloorWarning`.
 *
 * WHY RETIRED AND NOT REPOINTED. The Preview Scenario checker is DELETED by this release, not moved: it
 * resolved ACTIVE `leave_policy` rows, so against the template layer it would have had nothing to resolve
 * and would have answered "—" to every question while still looking like a live checker
 * (app/admin/leave-config/types/page.tsx records the decision). The component file and the warning key are
 * gone from all six locales with it. There is no surface left that renders a below-minimum warning, so
 * there is nothing to point these at; asserting a deleted component reads a deleted key would be a test
 * that cannot fail honestly.
 *
 * WHAT IS DELIBERATELY KEPT: the ENGINE half of the same invariant, which is the half that decides
 * anyone's days, now asserted on `composeEntitlement` above. And the prose guard below — no screen may
 * still CLAIM the minimum overrides the configured figure — because that claim is what the reporter asked
 * to be removed and `admin.leave.typesHelp` still renders it to HR.
 *
 * WHAT IS GENUINELY LESS COVERED: nothing now stops a FUTURE below-minimum warning being recomputed in the
 * presentation layer instead of read from the engine flag. That guard needs a surface to guard, and this
 * release leaves none.
 */
describe('fa3f4ccb · no surface still claims the minimum overrides the configured figure', () => {
  it('no surface still claims the minimum overrides the configured figure', () => {
    // A labelKey is not the label: these two strings asserted the removed behaviour as fact, in prose, on
    // the screens this item changes. Pinned by MEANING (the claim), not by wording.
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`/messages/${loc}.json`));
      const leave = m.admin.leave as Record<string, string | undefined>;
      expect(leave.typesHelp, `${loc} typesHelp`).not.toMatch(/max\(/i);
      // 4b0e76ae DELETED leaveYearHelp along with the whole Leave Year Configuration block. A string that
      // no longer exists cannot assert the removed behaviour, which satisfies this case more strongly than
      // a reworded one would — so absence passes. The check still runs if the key ever comes back, because
      // the redesigned Leave Year module is expected to reintroduce copy in this namespace and it must not
      // reintroduce the claim with it.
      if (leave.leaveYearHelp !== undefined) {
        expect(leave.leaveYearHelp, `${loc} leaveYearHelp`).not.toMatch(/max\(/i);
      }
    }
    // English is the source text, so the claim itself can be checked there.
    const en = JSON.parse(read('/messages/en.json')).admin.leave as Record<string, string>;
    expect(en.typesHelp).not.toMatch(/never applied/i);
    expect(en.typesHelp).not.toMatch(/<strong>greater<\/strong>/i);
  });
});

describe('fa3f4ccb · OUT OF SCOPE — the statutory protections that were NOT removed', () => {
  const leaveSrc = read('/core/leave.ts');
  const adminSrc = read('/core/admin.ts');

  it('the EA-1955 right to APPLY for annual and sick leave is untouched', () => {
    // A different protection from the entitlement floor: it stops HR configuring a lawful leave type so
    // that employees cannot submit a request at all. The reporter did not ask about it.
    expect(leaveSrc).toContain(
      "export const STATUTORY_APPLY_CODES = ['ANNUAL', 'SICK', 'HOSPITALIZATION', 'MATERNITY', 'PATERNITY'] as const;",
    );
    expect(leaveSrc).toContain('throw new LeaveApplyNotAllowedError(lt?.name);');
  });

  it('the updateLeaveType guard on lawful entitlements still stands — and now actually applies', () => {
    // REWRITTEN (r138, 65f466e2). This used to pin the literal source
    //   `(STATUTORY_APPLY_CODES as readonly string[]).includes(before.code)`.
    // The INTENT was "fa3f4ccb must not have REMOVED this protection", and that intent is intact — but
    // the assertion pinned an IMPLEMENTATION that was silently doing nothing on real tenants. Production
    // codes its statutory types MTL/PTL, not MATERNITY/PATERNITY, so `includes(before.code)` was false for
    // exactly the types the Employment Act names, and the guard protected nothing. 65f466e2 repointed it
    // at the role marker.
    //
    // So this is NOT a weakened guard: the protection is asserted to still exist, and additionally to be
    // reached through the role-aware test rather than the code-only one that could not fire.
    expect(adminSrc).toMatch(/isStatutoryApplyType\(before\)/);
    expect(adminSrc).toContain(
      'is a statutory leave entitlement — employees must be able to apply for it.',
    );
    // And the helper must keep consulting the seeded codes, so an UNCLASSIFIED tenant — one whose rows
    // migration 0387 could not match exactly — keeps precisely the protection it has today.
    expect(read('/core/leave.ts')).toMatch(
      /STATUTORY_APPLY_CODES as readonly string\[\]\)\.includes\(\(lt\.code \?\? ''\)\.toUpperCase\(\)\)/,
    );
  });
});

// ── Integration: the whole stack, against a real Malaysian statutory band ─────────────────────────────
let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

const hire = (hiredOn: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Floor', primaryEmail: `floor_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

describe('fa3f4ccb · end to end: a below-minimum entitlement reaches the ledger', () => {
  it('the hire grant credits the configured 5 days, not the 8-day statutory minimum', async () => {
    // 6e9a126e release three: was createLeavePolicy(5 days). The figure is the point and it is unchanged.
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 5,
      validFrom: '2020-01-01',
    });
    const emp = await hire('2026-01-01'); // 1-Jan hire ⇒ no pro-ration ⇒ the grant IS the entitlement
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(5);
    expect(5).toBeLessThan(MY_ANNUAL_FLOOR_0Y); // …and it really is below the statutory band
  });

  it('the year-open sweep grants the configured 5 days too (one composition, not two)', async () => {
    // 6e9a126e release three: was createLeavePolicy(5 days). The figure is the point and it is unchanged.
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 5,
      validFrom: '2020-01-01',
    });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(5);
  });
});
