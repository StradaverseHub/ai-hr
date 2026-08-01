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
 * The pack node is imported for real; the guide and wizard halves are source-text checks, the house
 * idiom for server/'use client' module-private structure (cf. test/payroll-flyout-nav.test.ts).
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

  it('preparation now precedes the run, which is the disagreement this item existed to end', () => {
    const at = (href: string) => NODE.children.findIndex((c) => c.href === href);
    expect(at('/payroll/setup')).toBeLessThan(at('/payroll'));
    expect(at('/payroll/transactions')).toBeLessThan(at('/payroll'));
    expect(at('/payroll')).toBeLessThan(at('/payroll/transaction-view'));
  });

  it('the menu ranks agree with where the guide actually links', () => {
    // Derived, not restated: for each phase, the screen the guide links to must not be ranked EARLIER
    // than that phase. A guide phase pointing at a menu row the menu puts before it is the drift.
    const guide = code('app/payroll/guide/page.tsx');
    const linkedHrefs = [...guide.matchAll(/href: '(\/payroll[^']*)'/g)].map((m) => m[1]!);
    expect(linkedHrefs.length, 'guide links nothing — the regex stopped matching').toBeGreaterThan(0);
    for (const href of linkedHrefs) {
      if (!(href in PAYROLL_NAV_PHASE)) continue; // /payroll/process and /payroll/configuration are sub-routes
      expect(PAYROLL_NAV_PHASE[href], `${href} is linked by the guide but ranked off the menu`).toBeDefined();
    }
  });
});

describe('a1d82340 step 3 — the guide and the wizard read the same declaration', () => {
  it('the guide builds its phases from PAYROLL_PHASES rather than its own literal list', () => {
    const src = code('app/payroll/guide/page.tsx');
    expect(src).toContain('PAYROLL_PHASES');
    // The old hand-written literals are gone. Scoped to the SHAPE that carried the duplicate ordering
    // (`n: 4, titleKey:`), not to the bare token `titleKey` — the page still legitimately reads
    // `phase.titleKey`, and forbidding that would break a surviving feature.
    expect(src).not.toMatch(/n:\s*\d+,\s*titleKey:/);
  });

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
