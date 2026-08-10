/**
 * The entitlement-recalc reason labels — the guard for a defect that was LIVE ON PRODUCTION.
 *
 * WHAT HAPPENED. `leave_entitlement_recalc_audit.reason` is free text written by whatever triggered the
 * recalc, so the Personnel profile renders it through a COMPUTED key, `recalcReason.${reason}`. Computed
 * keys are invisible to test/i18n-coverage.ts check C, which only matches literal t('a.b') calls — the
 * hole is documented in that file's own header.
 *
 * The page had a fallback, and it never fired:
 *
 *     const key = 'recalcReason.' + reason;      // RELATIVE
 *     const label = t(key);                      // next-intl returns the FULLY-QUALIFIED path on a miss
 *     return label === key ? reason : label;     // so this comparison could never be true
 *
 * Measured on production 2026-08-10, AFTER a deploy that did not cause it: 50 of 72 audit rows rendered a
 * key path at the user — leave_type_rules 29, year_cycle_override 11, movement_recorded 9,
 * movement_applied 1. The service journal was throwing MISSING_MESSAGE for each one.
 *
 * TWO THINGS FIX IT AND BOTH ARE PINNED HERE.
 *   1. The five reasons the current code emits now have labels in all six catalogues.
 *   2. The page uses `t.has` (the house idiom — app/admin/scheduled-actions/page.tsx does the same), so an
 *      UNLABELLED reason degrades to the raw word instead of a key path. This is the part that matters:
 *      reasons get added by new code paths faster than labels do, and (2) is what makes that survivable.
 *
 * WHY THIS FILE DOES NOT ASSERT "every emitted reason has a label". Six catalogued reasons
 * (scheme_entitlement_changed and friends) appear NOWHERE in the current source — they are legacy values
 * still sitting in old rows. A static enumeration of emitters is therefore provably incomplete, and a
 * guard built on an incomplete list would give false confidence. The fallback is the real protection; the
 * label list below is the known-good set, not a claim of completeness.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/** Comments are stripped before any source assertion: this file's own explanation quotes the broken
 *  expression, and a guard that reads comments would match it — the documented trap. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const page = stripComments(read('app/admin/personnel/[employmentId]/page.tsx'));

const block = (loc: string) =>
  JSON.parse(read(`messages/${loc}.json`)).people.detail.recalcReason as Record<string, string>;

/** The reasons the CURRENT code emits (recomputeEntitlement third args + trigger: literals). */
const EMITTED_TODAY = [
  'company_changed',
  'employment_info_changed',
  'leave_type_rules',
  'movement_applied',
  'movement_recorded',
  'year_cycle_override',
] as const;

describe('entitlement recalc reasons — the computed key that painted a key path on screen', () => {
  it('the page resolves the computed key with t.has, so an unknown reason cannot render as a path', () => {
    expect(page).toMatch(/t\.has\(`recalcReason\.\$\{reason\}`\)/);
    // The broken shape must not come back: comparing the translated value against the RELATIVE key.
    expect(page).not.toMatch(/label === key/);
  });

  it('every reason the current code emits has a label in ALL six catalogues', () => {
    for (const loc of LOCALES) {
      const b = block(loc);
      for (const reason of EMITTED_TODAY) {
        expect(b[reason], `${loc}.people.detail.recalcReason.${reason}`).toBeTruthy();
        // A label equal to its own key is the failure this whole file exists to prevent.
        expect(b[reason]).not.toContain('recalcReason.');
      }
    }
  });

  it('the six catalogues carry the SAME reason keys — no locale silently short', () => {
    const en = Object.keys(block('en')).sort();
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      expect(Object.keys(block(loc)).sort(), `${loc} vs en`).toEqual(en);
    }
  });

  it('the legacy labels are retained — old audit rows still carry them', () => {
    // Deliberately NOT emitted by current code. Removing them would blank the reason column on history
    // that predates the rename, which is exactly the sort of tidy-up that looks safe and is not.
    for (const legacy of ['grade_changed', 'employment_changed', 'scheme_entitlement_changed']) {
      expect(block('en')[legacy], legacy).toBeTruthy();
    }
  });
});
