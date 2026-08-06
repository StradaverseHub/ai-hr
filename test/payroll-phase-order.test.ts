/**
 * a1d82340 STEP 3 — "settle on one order".
 *
 * The menu, the Workflow Guide and the Process wizard each carried an ordering of the payroll
 * process, and the three disagreed: the sidebar opened with the finished-runs workbench and ended
 * with the settings you must complete first; the guide ran master data → transactions → validation →
 * process → review → finalize; the wizard showed a five-stage rail with its own names and its own
 * count, so "Stage 2 of 5" and "Phase 3 of 6" named the same moment differently.
 *
 * packs/payroll/phases.ts is now the single declaration and all three read it. What is worth
 * guarding is not the literal order — that would just be the same drift risk written down twice —
 * but the AGREEMENT: that no surface can move without the others moving with it. So each assertion
 * below derives its expectation from a DIFFERENT surface than the one it checks.
 *
 * The pack node is imported for real; the wizard half is a source-text check, the house idiom for
 * 'use client' module-private structure (cf. test/payroll-flyout-nav.test.ts).
 *
 * efe1d230 — the Workflow Guide page is retired, so the third surface named above no longer exists and
 * the assertions that derived from its source now derive from the wizard. The declaration itself is
 * unchanged and still single: packs/payroll/phases.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { payrollPack } from '../packs/payroll';
import { PAYROLL_PHASES, PAYROLL_NAV_PHASE, payrollNavRank, payrollPhaseIndex } from '../packs/payroll/phases';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source text with comments stripped — a comment RECORDING this change must never satisfy a guard. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const NODE = payrollPack.navNodes!.find((n) => n.group === 'admin')!;

describe('a1d82340 step 3 — the sequence is declared once', () => {
  it('numbers the phases 1..6 with no gap, in declaration order', () => {
    expect(PAYROLL_PHASES.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6]);
    PAYROLL_PHASES.forEach((p, i) => expect(payrollPhaseIndex(p.key)).toBe(i));
  });

  it('every phase title/description key exists in all six catalogs', () => {
    // The phases reuse the guide's already-translated keys precisely so this change adds none. If a
    // future phase is added with a fresh key, this fails until all six catalogs carry it — tsc
    // cannot see a missing translation.
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const guide = JSON.parse(read(`messages/${loc}.json`)).payroll.guide as Record<string, string>;
      for (const p of PAYROLL_PHASES) {
        expect(guide[p.titleKey], `payroll.guide.${p.titleKey} missing from ${loc}.json`).toBeTruthy();
        expect(guide[p.descKey], `payroll.guide.${p.descKey} missing from ${loc}.json`).toBeTruthy();
      }
    }
  });
});

describe('a1d82340 step 3 — the menu is ordered by the sequence, not by hand', () => {
  it('the fly-out rows are in non-decreasing phase rank', () => {
    const ranks = NODE.children.map((c) => payrollNavRank(c.href));
    expect(ranks, `menu order ${NODE.children.map((c) => c.href).join(' → ')}`).toEqual(
      [...ranks].sort((a, b) => a - b),
    );
  });

  it('every menu row has a declared rank (none falls off the end by accident)', () => {
    for (const c of NODE.children) {
      expect(PAYROLL_NAV_PHASE[c.href], `${c.href} has no rank in PAYROLL_NAV_PHASE`).toBeTypeOf('number');
    }
  });

  it('preparation is not stranded behind the run, which is the disagreement this item existed to end', () => {
    const at = (href: string) => NODE.children.findIndex((c) => c.href === href);

    // WHAT CHANGED, AND WHY THIS IS AN UPDATE RATHER THAN A WEAKENING. a1d82340 asserted literally
    // `at('/payroll/setup') < at('/payroll')`. efe1d230's approved plan says "Payroll Process becomes
    // the landing page when you open the Payroll module", and the fly-out focuses its first child on
    // open, so `/payroll` had to take rank 0 and that literal could no longer hold.
    //
    // a1d82340's actual complaint was NOT "setup before the workbench" for its own sake — it was that
    // the menu "closed with the settings you have to complete before you can run anything at all".
    // That is what is asserted here now, and it is a strictly sharper statement than the one it
    // replaces: Settings must come before the REVIEW and OUTPUT screens, and must not be last.
    expect(at('/payroll/setup')).toBeLessThan(at('/payroll/transaction-view'));
    expect(at('/payroll/setup')).toBeLessThan(at('/payroll/reports'));
    expect(at('/payroll/setup')).toBeLessThan(at('/payroll/statutory-forms'));
    expect(at('/payroll/setup'), 'Settings is stranded at the end of the menu again').toBeLessThan(
      NODE.children.length - 1,
    );
    // Preparation still precedes review; the run still precedes what you do with its results.
    expect(at('/payroll/transactions')).toBeLessThan(at('/payroll/transaction-view'));
    expect(at('/payroll')).toBeLessThan(at('/payroll/transaction-view'));
    // efe1d230's own promise, pinned from the rank side as well as the row side
    // (test/payroll-flyout-nav.test.ts asserts the rendered first row).
    expect(at('/payroll')).toBe(0);
  });

  it('the menu ranks agree with where the WIZARD says each phase happens', () => {
    // Derived, not restated. Until efe1d230 this cross-check ran against the Workflow Guide's
    // phase→screen link map; that page is retired, so the surviving second surface is the Process
    // wizard, which declares a phase per step. Every phase a wizard step claims must be a real phase
    // AND the run row the wizard leads to must be ranked on the menu — a wizard step in a phase the
    // menu cannot reach is the drift this pair of files exists to catch.
    const wizard = code('app/payroll/process/wizard.tsx');
    const declared = [...wizard.matchAll(/phase:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]!);
    expect(declared.length, 'wizard declares no phase — the regex stopped matching').toBeGreaterThan(0);
    for (const key of declared) {
      expect(PAYROLL_PHASES.some((p) => p.key === key), `wizard step phase '${key}' is not a payroll phase`).toBe(true);
    }
    expect(PAYROLL_NAV_PHASE['/payroll'], 'the wizard’s destination is ranked off the menu').toBeTypeOf('number');
  });
});

describe('a1d82340 step 3 — the wizard reads the one declaration', () => {
  // efe1d230 — the guide half of this describe is gone with the page. The phase VOCABULARY it owned is
  // not: PAYROLL_PHASES still carries the `payroll.guide.phase{n}Title/Desc` keys (asserted above, in
  // all six catalogs) because the wizard rail renders them, so retiring the page must not take the
  // namespace with it. That is the trap this comment exists to name.

  it('the wizard rail is the six phases, not a five-stage rail of its own', () => {
    const src = code('app/payroll/process/wizard.tsx');
    expect(src).toContain('PAYROLL_PHASES');
    // The retired rail's own vocabulary must not come back. These are the exact i18n keys it used;
    // they were deleted from all six catalogs, so a re-introduction would render raw keys.
    for (const dead of ['stagePreparation', 'stageValidation', 'stageProcess', 'stageReview', 'stageFinalize', 'stageOf']) {
      expect(src, `wizard still references the retired ${dead}`).not.toContain(dead);
    }
  });

  it('the retired stage labels are gone from all six catalogs', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const process = JSON.parse(read(`messages/${loc}.json`)).payroll.process as Record<string, unknown>;
      for (const dead of ['stagePreparation', 'stageValidation', 'stageProcess', 'stageReview', 'stageFinalize', 'stageOf']) {
        expect(process[dead], `payroll.process.${dead} still in ${loc}.json`).toBeUndefined();
      }
      // …and the key the rail's counter moved to is present, in every locale.
      expect(process.stepOf, `payroll.process.stepOf missing from ${loc}.json`).toBeTruthy();
    }
  });

  it('every wizard step declares a phase that exists', () => {
    const src = code('app/payroll/process/wizard.tsx');
    const declared = [...src.matchAll(/phase:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]!);
    expect(declared.length, 'no wizard step declares a phase').toBeGreaterThan(0);
    for (const key of declared) {
      expect(PAYROLL_PHASES.some((p) => p.key === key), `wizard step phase '${key}' is not a payroll phase`).toBe(true);
    }
  });
});
