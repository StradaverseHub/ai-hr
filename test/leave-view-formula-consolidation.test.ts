/**
 * Consolidate Leave View Configuration with Entitlement Formula Management (feedback 2bc2f2a3).
 *
 * The standalone "Leave Entitlement Formula Management" section (79011509) is MERGED into the Employee Leave
 * View Configuration (65dec703 / grouped by 11876072): one sub-form, one Save — tick an item and its
 * Description / Formula fields appear inline beside it; the submit posts BOTH tri-state markers (`essView=1`
 * + `formula=1`) so selections land on ess_view_config and explanations on formula_explanations (same two
 * storage targets as before — no content migration). The explanation key set is WIDENED from the 7 legacy
 * calc-breakdown component keys to LEAVE_EXPLANATION_KEYS (legacy 7 ∪ every ess-view key), with the legacy
 * keys reading/writing identically so existing content survives verbatim.
 *
 * Employee side: the per-row info icon extends from the §7 calculation rows to ANY row whose field key has an
 * explanation, and the click-to-expand block becomes a hover tooltip (hover/focus reveals, tap toggles,
 * Escape dismisses) with Description and Formula on separate lines.
 *
 * DB-free guard suite (repo convention for UI-only files): unit tests over the widened core key set +
 * normalise/resolve round-trip, and source/i18n drift guards over the merged admin sub-form and the employee
 * tooltip.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LEAVE_EXPLANATION_KEYS,
  LEAVE_FORMULA_COMPONENT_KEYS,
  isLeaveExplanationKey,
  normalizeLeaveFormulaConfig,
  resolveLeaveFormula,
  type LeaveFormulaConfig,
} from '../core/leave-formula';
import { ESS_VIEW_COMPONENT_KEYS } from '../core/ess-view';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('2bc2f2a3 · widened explanation key set (legacy 7 ∪ ess-view keys)', () => {
  it('LEAVE_EXPLANATION_KEYS = the 7 legacy component keys first, then the ess-view keys, deduplicated', () => {
    // Legacy keys keep their exact order at the head (they drive the calc-breakdown editor block order).
    expect(LEAVE_EXPLANATION_KEYS.slice(0, LEAVE_FORMULA_COMPONENT_KEYS.length)).toEqual([
      ...LEAVE_FORMULA_COMPONENT_KEYS,
    ]);
    // Union coverage: every legacy key AND every ess-view key is accepted.
    for (const k of LEAVE_FORMULA_COMPONENT_KEYS) expect(LEAVE_EXPLANATION_KEYS).toContain(k);
    for (const k of ESS_VIEW_COMPONENT_KEYS) expect(LEAVE_EXPLANATION_KEYS).toContain(k);
    // carryForwardExpiry / forfeited live in BOTH source lists but stay ONE key each (no duplicates).
    expect(new Set(LEAVE_EXPLANATION_KEYS).size).toBe(LEAVE_EXPLANATION_KEYS.length);
    expect(LEAVE_EXPLANATION_KEYS.length).toBe(
      new Set([...LEAVE_FORMULA_COMPONENT_KEYS, ...ESS_VIEW_COMPONENT_KEYS]).size,
    );
  });

  it('isLeaveExplanationKey accepts legacy + ess-view keys, rejects unknowns', () => {
    expect(isLeaveExplanationKey('currentYearEntitlement')).toBe(true); // legacy
    expect(isLeaveExplanationKey('ytdEntitled')).toBe(true); // ess-view (2bc2f2a3 widening)
    expect(isLeaveExplanationKey('adjustment')).toBe(true); // ess-view (2bc2f2a3 widening)
    expect(isLeaveExplanationKey('balance')).toBe(false); // never-gated summary row — not annotatable
    expect(isLeaveExplanationKey('notAKey')).toBe(false);
  });

  it('normalizeLeaveFormulaConfig accepts an ess-view key and still rejects an unknown key', () => {
    const out = normalizeLeaveFormulaConfig({
      ytdEntitled: { description: '  granted so far  ', formula: 'monthly accrual × months', result: '' },
    });
    expect(out).toEqual({ ytdEntitled: { description: 'granted so far', formula: 'monthly accrual × months' } });
    expect(() => normalizeLeaveFormulaConfig({ notAKey: { description: 'x' } } as LeaveFormulaConfig)).toThrow(
      /Unknown leave-formula component key/,
    );
  });

  it('the 7 legacy keys round-trip identically (existing stored content survives verbatim)', () => {
    const legacy: LeaveFormulaConfig = {
      currentYearEntitlement: { description: 'annual grant', formula: 'policy days', result: '12' },
      carriedForward: { formula: 'unused prior-year balance, capped' },
    };
    const normalized = normalizeLeaveFormulaConfig(legacy);
    expect(normalized).toEqual(legacy);
    const resolved = resolveLeaveFormula(normalized as Record<string, { description?: string }>);
    expect(resolved.currentYearEntitlement).toEqual(legacy.currentYearEntitlement);
    expect(resolved.carriedForward).toEqual(legacy.carriedForward);
    // Untouched legacy keys resolve to null (no explanation), exactly as before the widening.
    expect(resolved.monthlyAccrued).toBeNull();
    expect(resolved.totalAvailable).toBeNull();
  });

  it('resolveLeaveFormula resolves EVERY widened key (missing ⇒ null; ess-view entries surface)', () => {
    const resolved = resolveLeaveFormula({ taken: { description: 'leave already used' } });
    expect(Object.keys(resolved).sort()).toEqual([...LEAVE_EXPLANATION_KEYS].sort());
    expect(resolved.taken).toEqual({ description: 'leave already used' });
    expect(resolved.available).toBeNull();
  });
});

describe('2bc2f2a3 · admin: ONE merged sub-form (standalone formula section gone)', () => {
  const panelSrc = read('/components/leave-type-panel.tsx');

  it('the standalone Leave Entitlement Formula Management section is removed from the panel', () => {
    expect(panelSrc.includes("t('formula.sectionTitle')")).toBe(false);
    expect(panelSrc.includes("t('formula.help')")).toBe(false);
  });

  it('one form posts BOTH tri-state markers — essView selections + formula explanations save together', () => {
    // Exactly one occurrence of each marker, and both inside the SAME <form> block.
    expect(panelSrc.match(/name="essView"/g)).toHaveLength(1);
    expect(panelSrc.match(/name="formula"/g)).toHaveLength(1);
    const formStart = panelSrc.lastIndexOf('<form', panelSrc.indexOf('name="essView"'));
    const formEnd = panelSrc.indexOf('</form>', formStart);
    const form = panelSrc.slice(formStart, formEnd);
    expect(form.includes('name="essView"')).toBe(true);
    expect(form.includes('name="formula"')).toBe(true);
    // The per-key contracts are unchanged: checkbox per ess key, three explanation fields per item.
    expect(form.includes('essView_${key}')).toBe(true);
  });

  it('ticking an item reveals its inline Description / Formula / Result editor (hidden, not unmounted, when unticked)', () => {
    // Client-island reveal state: the checkbox is controlled...
    expect(panelSrc).toMatch(/checked=\{on\}/);
    expect(panelSrc).toMatch(/onChange=\{\(\) => toggle\(key\)\}/);
    // ...and the editor is concealed with the `hidden` attribute so its inputs STILL POST — an untick+save
    // round-trip never wipes the stored explanation.
    expect(panelSrc).toMatch(/hidden=\{!on\}/);
    // The inline editor posts the 79011509 FormData contract names.
    expect(panelSrc.includes('formula_${fieldKey}_description')).toBe(true);
    expect(panelSrc.includes('formula_${fieldKey}_formula')).toBe(true);
    expect(panelSrc.includes('formula_${fieldKey}_result')).toBe(true);
  });

  it('the Entitlement Calculation Breakdown checkbox reveals the SEVEN legacy per-component editors', () => {
    expect(panelSrc.includes("key === 'entitlementCalcBreakdown'")).toBe(true);
    // The calc block iterates the legacy component keys, so 79011509 content stays editable per row.
    const viewConfigBody = panelSrc.slice(panelSrc.indexOf('function ViewConfigSection'));
    expect(viewConfigBody.includes('LEAVE_FORMULA_COMPONENT_KEYS.map')).toBe(true);
    expect(viewConfigBody.includes('formula.component.${componentKey}')).toBe(true);
  });

  it('the action builds the explanation map over the WIDENED key list', () => {
    const actionsSrc = read('/app/admin/actions.ts');
    expect(actionsSrc.includes('LEAVE_EXPLANATION_KEYS.map')).toBe(true);
    // The old narrow build over the legacy-only list is gone.
    expect(actionsSrc.includes('LEAVE_FORMULA_COMPONENT_KEYS.map')).toBe(false);
  });
});

describe('2bc2f2a3 · employee: hover tooltip on ANY explained row (not only calc rows)', () => {
  const panel = read('/components/leave/LeaveDetailsPanel.tsx');

  it('the calcBreakdown-only gate on explanations is gone — lookup is by field key for every section', () => {
    expect(panel.includes("section.key === 'calcBreakdown'")).toBe(false);
    expect(panel.includes('data.formulaExplanations?.[f.key]')).toBe(true);
  });

  it('click-to-expand became a hover tooltip: hover/focus reveal, tap toggles, Escape dismisses', () => {
    expect(panel).toMatch(/role="tooltip"/);
    expect(panel).toMatch(/onMouseEnter/);
    expect(panel).toMatch(/onMouseLeave/);
    expect(panel).toMatch(/onFocus/);
    expect(panel).toMatch(/onBlur/);
    // Touch: a tap toggles (pins) the tooltip open/closed.
    expect(panel).toMatch(/onClick=\{\(\) => toggleRow\(rowKey\)\}/);
    // Keyboard: Escape dismisses hover + pin.
    expect(panel).toMatch(/e\.key === 'Escape'/);
    // The old inline expanded-block styling driver is gone (the content floats as a positioned tooltip).
    expect(panel.includes('expandedRows')).toBe(false);
  });

  it('Description and Formula render on separate lines (own <p> each), Result preserved (it was rendered)', () => {
    for (const label of ['explanationDescription', 'explanationFormula', 'explanationResult']) {
      expect(panel.includes(`t('${label}')`)).toBe(true);
    }
    // Each labelled line is its own paragraph inside the tooltip.
    const tipStart = panel.indexOf('role="tooltip"');
    const tip = panel.slice(tipStart, panel.indexOf('</div>', panel.indexOf("t('explanationResult')")));
    expect((tip.match(/<p>/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('a11y smoke: the trigger is a focusable button, named, with aria-expanded + aria-describedby wiring', () => {
    expect(panel).toMatch(/aria-expanded=\{isOpen\}/);
    expect(panel).toMatch(/aria-describedby=\{isOpen \? tooltipId : undefined\}/);
    expect(panel).toMatch(/aria-label=\{isOpen \? t\('explanationHide'\) : t\('explanationShow'\)\}/);
    // A real <button type="button"> (keyboard-focusable by default) carries the icon.
    expect(panel.includes('type="button"')).toBe(true);
  });

  it('the static §1 tooltip yields to an HR explanation (one icon per row)', () => {
    expect(panel.includes('f.tooltipKey && !hasExpl')).toBe(true);
  });
});

describe('2bc2f2a3 · i18n: inline + hover labels in all 6 locales; standalone-section strings retired', () => {
  for (const loc of LOCALES) {
    const msgs = JSON.parse(read(`/messages/${loc}.json`));
    it(`${loc}: keeps the reused field labels + the 7 component names; retires sectionTitle/help/configured`, () => {
      const formula = msgs.admin.leave.formula as Record<string, unknown>;
      for (const key of ['descriptionLabel', 'formulaLabel', 'resultLabel']) {
        expect(typeof formula[key], `${loc}.admin.leave.formula.${key}`).toBe('string');
      }
      const components = formula.component as Record<string, string>;
      for (const key of LEAVE_FORMULA_COMPONENT_KEYS) {
        expect(typeof components[key], `${loc}.admin.leave.formula.component.${key}`).toBe('string');
      }
      // The standalone section's own strings are retired with it.
      for (const key of ['sectionTitle', 'help', 'configured']) {
        expect(formula[key], `${loc}.admin.leave.formula.${key} retired`).toBeUndefined();
      }
    });

    it(`${loc}: keeps the employee hover labels and the merged essView help`, () => {
      const breakdown = msgs.leave.breakdown as Record<string, unknown>;
      for (const key of ['explanationDescription', 'explanationFormula', 'explanationResult', 'explanationShow', 'explanationHide']) {
        expect(typeof breakdown[key], `${loc}.leave.breakdown.${key}`).toBe('string');
      }
      const essView = msgs.admin.leave.essView as Record<string, unknown>;
      expect(typeof essView.sectionTitle).toBe('string');
      expect(typeof essView.help).toBe('string');
      expect((essView.help as string).length).toBeGreaterThan(0);
    });
  }
});
