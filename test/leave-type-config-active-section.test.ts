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
/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. `components/leave-type-panel.tsx` (3,367 lines)
 * was DELETED with the page that mounted it: the four steps and six sub-steps it carried are the FIVE
 * TABS of `/admin/leave-config/types` (IA §2), which is what this whole item was raised about. The panel
 * became three files, so what this guard scans is their concatenation — the property it pins is about the
 * leave TYPE screen, not about one filename, and pinning it to a file that no longer exists would have
 * taken the guard out rather than moved it.
 */
const LEAVE_TYPE_SCREEN = [
  'app/admin/leave-config/types/page.tsx',
  'app/admin/leave-config/types/leave-type-tabs.tsx',
  'app/admin/leave-config/types/leave-type-sub-forms.tsx',
];
const panelSrc = LEAVE_TYPE_SCREEN.map((f) => readFileSync(resolve(here, '..', f), 'utf8')).join('\n');

/**
 * ⚠️ a6fe37fc ROUND 5 — THE FOUR `STEP_KEYS` ARE GONE AND THESE ARE THEIR SUCCESSORS.
 *
 * `['general', 'ess', 'entitlement', 'custom']` were the four steps c979aa8b built and IA §1.2 names as
 * the arrangement the reporter complained about — sections grouped by how the code grew. The five tabs
 * below are grouped by what is being configured, in the order the decisions are made (IA §2). 27136ea6's
 * requirement is untouched by that and is what this file still guards: HR can tell AT A GLANCE which
 * section they are editing, and exactly one renders at a time.
 */
const TAB_KEYS = ['identity', 'eligibility', 'entitlement', 'application', 'approvers'] as const;

describe('27136ea6 · c979aa8b · a6fe37fc · the active tab is visually distinguished on the bar', () => {
  it('each tab button derives highlight + aria-current from ITS OWN activeTab comparison', () => {
    // The bar renders from one map over TAB_KEYS, so a single comparison drives every pill — pin the
    // comparison and both consumers (semantic aria-current="step" + the styling call).
    expect(panelSrc).toContain('const tabActive = activeTab === key');
    expect(panelSrc).toMatch(/aria-current=\{tabActive \? 'step' : undefined\}/);
    expect(panelSrc).toContain('className={tabBtn(tabActive)}');
  });

  it('the active branch carries the accent highlight and the bolder label', () => {
    const defStart = panelSrc.indexOf('const tabBtn');
    expect(defStart).toBeGreaterThan(-1);
    const def = panelSrc.slice(defStart, panelSrc.indexOf('};', defStart));
    // Kept deliberately loose (substring, not exact literals): bg-accent still matches if a designer later
    // tunes to bg-accent/60 (the half-active treatment nav-collapsible-group.tsx already uses).
    expect(def).toContain('bg-accent');
    expect(def).toContain('font-semibold');
  });

  it('exactly one section renders at a time — each tab gates its own card', () => {
    for (const key of TAB_KEYS) {
      expect(
        panelSrc.includes(`{activeTab === '${key}' && (`),
        `section for '${key}' gated by activeTab`,
      ).toBe(true);
    }
    // The accordion's per-card open flags are gone, and so is the step walk that replaced them —
    // activeTab is the only visibility mechanism now.
    expect(panelSrc.includes('openCards')).toBe(false);
    // No step-gated section survives. `parsed.activeStep` is READ — that is the hydration remap, which
    // reads a stale browser payload and sends it to the tab that replaced its step — but nothing on the
    // screen is rendered by comparing against it.
    expect(panelSrc.includes("{activeStep === '")).toBe(false);
  });
});
