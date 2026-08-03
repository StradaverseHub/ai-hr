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
 * The preview/engine agreement (`previewEntitlement` vs `entitledDays`) is the other invariant worth
 * ratcheting: the file they live in states that the admin preview may never disagree with a real grant,
 * which is the whole reason the preview restates the composition.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { createLeavePolicy } from '../core/admin';
import { openLeaveYear } from '../core/leave';
import { belowStatutoryFloor, entitledDays, previewEntitlement, type GradePolicyRow } from '../core/leave-compute';
import { entitlement as myEntitlement } from '../localization/my/leave';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, resetDb, seedBase, type Base } from './harness';

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
  it('entitledDays resolves to scheme ?? policy, whatever the floor says', () => {
    expect(entitledDays(8, null, 12).days).toBe(12);
    expect(entitledDays(8, 15, 12).days).toBe(15);
    // The case the whole item is about: a configured 5 under an 8-day minimum stays 5.
    expect(entitledDays(8, null, 5).days).toBe(5);
    expect(entitledDays(8, 5, 12).days).toBe(5);
  });

  it('entitledDays raises belowStatutoryFloor exactly when the RESOLVED figure is under the minimum', () => {
    expect(entitledDays(8, null, 5).belowStatutoryFloor).toBe(true);
    expect(entitledDays(8, null, 8).belowStatutoryFloor).toBe(false); // equal is not below
    expect(entitledDays(8, 15, 5).belowStatutoryFloor).toBe(false); // the SCHEME wins ⇒ judge the winner
    expect(entitledDays(8, 5, 15).belowStatutoryFloor).toBe(true); // …and likewise the other way round
  });

  it('belowStatutoryFloor is inert where no statutory pack applies (every non-MY company today)', () => {
    // Those jurisdictions already ran with no floor. This change makes MY behave like them, so a null /
    // non-finite floor must never raise the flag — not even against a configured 0.
    expect(belowStatutoryFloor(null, 0)).toBe(false);
    expect(belowStatutoryFloor(undefined, 0)).toBe(false);
    expect(belowStatutoryFloor(Number.NaN, 0)).toBe(false);
  });
});

describe('fa3f4ccb · the admin preview cannot disagree with a real grant', () => {
  const rows = (annualDays: number): GradePolicyRow[] => [{ gradeId: null, companyId: null, accrual: { annualDays } }];

  it('preview and engine return the SAME number for a below-minimum configuration', () => {
    const preview = previewEntitlement(rows(5), null, null, 0, MY_ANNUAL_FLOOR_0Y);
    const engine = entitledDays(MY_ANNUAL_FLOOR_0Y, null, 5);
    expect(preview.days).toBe(engine.days);
    expect(preview.belowStatutoryFloor).toBe(engine.belowStatutoryFloor);
    expect(preview.days).toBe(5);
    expect(preview.belowStatutoryFloor).toBe(true);
  });

  it('the preview still carries the minimum itself, so the warning can quote a figure', () => {
    const preview = previewEntitlement(rows(5), null, null, 0, MY_ANNUAL_FLOOR_0Y);
    expect(preview.floorDays).toBe(MY_ANNUAL_FLOOR_0Y);
    expect(preview.policyDays).toBe(5);
  });
});

describe('fa3f4ccb · the warning is rendered from the engine signal, never recomputed on screen', () => {
  const preview = read('/components/leave-rule-preview.tsx');

  it('the preview component reads result.belowStatutoryFloor and quotes result.floorDays', () => {
    // Recomputing the floor in the presentation layer is how the flagged figure and the quoted minimum
    // drift apart — the reason the flag lives in PreviewResult at all.
    expect(preview).toMatch(/result\.belowStatutoryFloor/);
    expect(preview).toMatch(/t\('previewBelowFloorWarning', \{ days: result\.floorDays/);
    // SCOPED to the construct this is about: the floor must never be an OPERAND of a max/min, nor be
    // compared against the days on screen. Two blunter versions of this guard were wrong — "no Math.max"
    // matches `Math.max(0, serviceYears)` (a form-input clamp), and "no line mentioning floor" matches the
    // line that merely PASSES floorDays into previewEntitlement, which is exactly what it should do.
    expect(preview).not.toMatch(/Math\.(max|min)\([^)]*floorDays/i);
    expect(preview).not.toMatch(/floorDays[^\n]*[<>]=?[^\n]*days/i);
    // The headline figure is printed as resolved, not adjusted here.
    expect(preview).toMatch(/t\('previewResultDays', \{ days: result\.days \}\)/);
  });

  it('every locale carries the warning string (tsc cannot see a missing translation key)', () => {
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`/messages/${loc}.json`));
      expect(m.admin.leave.previewBelowFloorWarning, `${loc} previewBelowFloorWarning`).toBeTruthy();
      expect(String(m.admin.leave.previewBelowFloorWarning)).toContain('{days}');
    }
  });

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

  it('the updateLeaveType guard on lawful-entitlement codes is untouched', () => {
    expect(adminSrc).toMatch(/STATUTORY_APPLY_CODES as readonly string\[\]\)\.includes\(before\.code\)/);
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
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 5,
      validFrom: '2020-01-01',
    });
    const emp = await hire('2026-01-01'); // 1-Jan hire ⇒ no pro-ration ⇒ the grant IS the entitlement
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(5);
    expect(5).toBeLessThan(MY_ANNUAL_FLOOR_0Y); // …and it really is below the statutory band
  });

  it('the year-open sweep grants the configured 5 days too (one composition, not two)', async () => {
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 5,
      validFrom: '2020-01-01',
    });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(5);
  });
});
