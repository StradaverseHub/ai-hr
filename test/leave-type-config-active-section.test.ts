/**
 * Leave-type config: active-step indicator on the workspace step bar (feedback 27136ea6, restructured by
 * c979aa8b — the five 123c1e76 accordion cards became the steps of a horizontal step flow, shortened and
 * reordered by b8fcae73 to General / Condition / Entitlement / Custom, ONE section visible at a time).
 *
 * The 27136ea6 requirement — HR can tell at a glance which section they are editing — now lives on the step
 * bar: the CURRENT step's pill carries the accent wash (bg-accent), a semibold label and aria-current="step";
 * inactive steps stay muted. Unlike the accordion era, exactly ONE step is active at a time (the
 * step-switcher invariant), and only that step's section renders.
 *
 * Static source guard (the repo convention for this DOM-runner-less component; see
 * leave-type-config-categories.test.ts / leave-type-edit-layout.test.ts). A static test CANNOT prove the
 * accent pill actually renders highlighted, nor that switching steps swaps the visible section — those are
 * assigned to browser verification and that assignment is not optional.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');

const STEP_KEYS = ['general', 'ess', 'entitlement', 'custom'] as const;

describe('27136ea6 · c979aa8b · the active step is visually distinguished on the step bar', () => {
  it('each step button derives highlight + aria-current from ITS OWN activeStep comparison', () => {
    // The bar renders from one map over STEP_KEYS, so a single comparison drives every pill — pin the
    // comparison and both consumers (semantic aria-current="step" + the styling call).
    expect(panelSrc).toContain('const stepActive = activeStep === key');
    expect(panelSrc).toMatch(/aria-current=\{stepActive \? 'step' : undefined\}/);
    expect(panelSrc).toContain('className={stepBtn(stepActive)}');
  });

  it('the active branch carries the accent highlight and the bolder label', () => {
    const defStart = panelSrc.indexOf('const stepBtn');
    expect(defStart).toBeGreaterThan(-1);
    const def = panelSrc.slice(defStart, panelSrc.indexOf('return (', defStart));
    // Kept deliberately loose (substring, not exact literals): bg-accent still matches if a designer later
    // tunes to bg-accent/60 (the half-active treatment nav-collapsible-group.tsx already uses).
    expect(def).toContain('bg-accent');
    expect(def).toContain('font-semibold');
  });

  it('exactly one section renders at a time — each step gates its own card', () => {
    for (const key of STEP_KEYS) {
      expect(
        panelSrc.includes(`{activeStep === '${key}' && (`),
        `section for '${key}' gated by activeStep`,
      ).toBe(true);
    }
    // The accordion's per-card open flags are gone — activeStep is the only visibility mechanism.
    expect(panelSrc.includes('openCards')).toBe(false);
  });
});
