/**
 * Employee Leave View Configuration — the consolidated view+explanation editor.
 *
 * 2bc2f2a3 merged the standalone "Leave Entitlement Formula Management" section (79011509) into the Employee
 * Leave View Configuration (65dec703): one sub-form, one Save — tick an item and its Description / Formula
 * fields appear inline beside it; the submit posts BOTH tri-state markers (`essView=1` + `formula=1`) so
 * selections land on ess_view_config and explanations on formula_explanations.
 *
 * ed17a4f9 then SYNCHRONISED it with the redesigned Leave Balance Summary (1f6fd6d8) and added smart content
 * reuse. Three changes, each pinned below:
 *   • the key set is now EXACTLY the ess-view key set — the nine summary items — instead of the old union of
 *     seven legacy calc-breakdown keys and the ess-view keys. One list, no annotatable item without a row.
 *   • the third "Result / Date (optional)" field is removed from the entry, the form and the tooltip.
 *   • wording is written once: a leave type with no configuration of its own is PRE-FILLED from the first
 *     leave type that has one, per item, without overwriting anything and without writing until Save.
 *
 * DB-free guard suite (repo convention for UI-only files): unit tests over the core key set, the
 * normalise/resolve round-trip and the template helpers, plus source/i18n drift guards.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LEAVE_EXPLANATION_KEYS,
  LEAVE_FORMULA_FIELDS,
  applyLeaveFormulaTemplate,
  isLeaveExplanationKey,
  leaveFormulaTemplateFrom,
  normalizeLeaveFormulaConfig,
  resolveLeaveFormula,
  type LeaveFormulaConfig,
} from '../core/leave-formula';
import { ESS_VIEW_COMPONENT_KEYS } from '../core/ess-view';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('ed17a4f9 · the explanation key set IS the Leave Summary item set', () => {
  it('LEAVE_EXPLANATION_KEYS === ESS_VIEW_COMPONENT_KEYS, same order', () => {
    // This identity is the item: before it, HR could write an explanation for a row employees no longer saw,
    // and the configuration screen listed items the summary did not render. One list closes both directions.
    expect([...LEAVE_EXPLANATION_KEYS]).toEqual([...ESS_VIEW_COMPONENT_KEYS]);
  });

  it('the seven legacy calc-breakdown keys are no longer accepted', () => {
    // Their section was removed from the employee panel by 1f6fd6d8, so annotating them explains nothing.
    for (const legacy of [
      'currentYearEntitlement',
      'monthlyAccrued',
      'carriedForward',
      'carryForwardRemaining',
      'carryForwardExpiry',
      'totalAvailable',
    ]) {
      expect(isLeaveExplanationKey(legacy), `${legacy} should be retired`).toBe(false);
    }
    // `forfeited` was in BOTH lists and survives — it is still a summary row (Brought Forward Forfeited).
    expect(isLeaveExplanationKey('forfeited')).toBe(true);
  });

  it('isLeaveExplanationKey accepts every summary item and rejects unknowns', () => {
    for (const k of ESS_VIEW_COMPONENT_KEYS) expect(isLeaveExplanationKey(k)).toBe(true);
    expect(isLeaveExplanationKey('balance')).toBe(false);
    expect(isLeaveExplanationKey('notAKey')).toBe(false);
  });

  it('an entry carries Description and Formula Explanation only — the Result field is gone', () => {
    expect([...LEAVE_FORMULA_FIELDS]).toEqual(['description', 'formula']);
  });

  it('normalizeLeaveFormulaConfig trims, drops blanks, and rejects an unknown key', () => {
    const out = normalizeLeaveFormulaConfig({
      ytdEntitled: { description: '  granted so far  ', formula: 'monthly accrual × months' },
    });
    expect(out).toEqual({ ytdEntitled: { description: 'granted so far', formula: 'monthly accrual × months' } });
    expect(() => normalizeLeaveFormulaConfig({ notAKey: { description: 'x' } } as LeaveFormulaConfig)).toThrow(
      /Unknown leave-formula component key/,
    );
    // An all-blank map clears the column rather than storing empty entries.
    expect(normalizeLeaveFormulaConfig({ taken: { description: '   ' } })).toBeNull();
  });

  it('resolveLeaveFormula resolves EVERY item (missing ⇒ null) and IGNORES retired stored keys', () => {
    // A tenant that wrote explanations under the legacy keys must still read cleanly — reads never throw on
    // legacy data. The retired content is simply no longer offered, and is not silently moved onto a
    // different row (reassigning wording HR wrote about one figure to another figure would be worse).
    const resolved = resolveLeaveFormula({
      taken: { description: 'leave already used' },
      currentYearEntitlement: { description: 'legacy content that predates the redesign' },
    });
    expect(Object.keys(resolved).sort()).toEqual([...LEAVE_EXPLANATION_KEYS].sort());
    expect(resolved.taken).toEqual({ description: 'leave already used' });
    expect(resolved.available).toBeNull();
    expect((resolved as Record<string, unknown>).currentYearEntitlement).toBeUndefined();
  });

  it('a stored `result` no longer makes an entry count as an explanation', () => {
    // The field is removed; an entry that ONLY ever had a Result resolves to null, so the employee's info
    // icon disappears rather than opening an empty tooltip.
    expect(resolveLeaveFormula({ taken: { result: '5 days' } as never }).taken).toBeNull();
    expect(resolveLeaveFormula({ taken: { description: 'x', result: '5' } as never }).taken).not.toBeNull();
  });
});

describe('ed17a4f9 §4 · smart content reuse: write the wording once', () => {
  const A = { description: 'What you have been granted so far', formula: 'accrual to date' };
  const B = { description: 'Days you have used' };

  it('the template is the FIRST candidate carrying any content', () => {
    expect(leaveFormulaTemplateFrom([null, undefined, {}, { ytdEntitled: A }, { taken: B }])).toEqual({ ytdEntitled: A });
  });

  it('no configured leave type yet ⇒ no template, and the boxes start empty as before', () => {
    expect(leaveFormulaTemplateFrom([])).toBeNull();
    expect(leaveFormulaTemplateFrom([null, {}, { taken: { description: '  ' } as never }])).toBeNull();
  });

  it('an unconfigured leave type is pre-filled from the template', () => {
    const out = applyLeaveFormulaTemplate(null, { ytdEntitled: A, taken: B });
    expect(out.ytdEntitled).toEqual(A);
    expect(out.taken).toEqual(B);
    // Items the template does not cover stay empty rather than being invented.
    expect(out.eligible).toBeNull();
  });

  it('NEVER overwrites: a leave type’s own wording survives the template exactly', () => {
    // The reporter's requirement is explicit — "preserve those values exactly as they are". This is the
    // assertion that a future backfill-style "apply template" cannot be introduced without failing.
    const own = { description: 'Sick leave is granted in full each January' };
    const out = applyLeaveFormulaTemplate({ ytdEntitled: own }, { ytdEntitled: A, taken: B });
    expect(out.ytdEntitled).toEqual(own);
    // …while a PARTLY-configured type still gets the template for the items it has not written. Filling in
    // per item rather than all-or-nothing is what makes the feature useful on a half-done leave type.
    expect(out.taken).toEqual(B);
  });

  it('with no template, the type’s own resolved wording is returned unchanged', () => {
    const own = { description: 'x' };
    expect(applyLeaveFormulaTemplate({ taken: own }, null).taken).toEqual(own);
    expect(applyLeaveFormulaTemplate({ taken: own }, null).eligible).toBeNull();
  });

  it('is a PURE read-side default — the helpers cannot write, and the action has no template branch', () => {
    // Nothing is stored until Save: the template only supplies form defaultValues, so what the action
    // receives is whatever HR reviewed and left in the boxes.
    const actions = read('/app/admin/actions.ts');
    expect(actions.includes('leaveFormulaTemplateFrom')).toBe(false);
    expect(actions.includes('applyLeaveFormulaTemplate')).toBe(false);
    // It is resolved ONCE per page off the already-loaded leave types — no extra query, no N+1.
    const page = read('/app/admin/leave-config/types/page.tsx');
    expect(page.includes('leaveFormulaTemplateFrom')).toBe(true);
    expect(page.includes('formulaTemplate={formulaTemplate}')).toBe(true);
  });
});

describe('admin: ONE merged sub-form, now over the nine summary items', () => {
  const panelSrc = ['/app/admin/leave-config/types/page.tsx', '/app/admin/leave-config/types/leave-type-tabs.tsx', '/app/admin/leave-config/types/leave-type-sub-forms.tsx']
    .map((f) => read(f))
    .join('\n');

  it('the standalone Leave Entitlement Formula Management section stays removed', () => {
    expect(panelSrc.includes("t('formula.sectionTitle')")).toBe(false);
    expect(panelSrc.includes("t('formula.help')")).toBe(false);
  });

  it('one form posts BOTH tri-state markers — essView selections + explanations save together', () => {
    expect(panelSrc.match(/name="essView"/g)).toHaveLength(1);
    expect(panelSrc.match(/name="formula"/g)).toHaveLength(1);
    const formStart = panelSrc.lastIndexOf('<form', panelSrc.indexOf('name="essView"'));
    const form = panelSrc.slice(formStart, panelSrc.indexOf('</form>', formStart));
    expect(form.includes('name="essView"')).toBe(true);
    expect(form.includes('name="formula"')).toBe(true);
    expect(form.includes('essView_${key}')).toBe(true);
  });

  it('ticking an item reveals its editor (hidden, not unmounted, when unticked)', () => {
    expect(panelSrc).toMatch(/checked=\{on\}/);
    expect(panelSrc).toMatch(/onChange=\{\(\) => toggle\(key\)\}/);
    // Concealed with `hidden` so the inputs STILL POST — an untick+save never wipes a stored explanation.
    expect(panelSrc).toMatch(/hidden=\{!on\}/);
    // The FormData contract names are unchanged for the two surviving fields.
    expect(panelSrc.includes('formula_${fieldKey}_description')).toBe(true);
    expect(panelSrc.includes('formula_${fieldKey}_formula')).toBe(true);
    // ed17a4f9: the Result input is gone from the form, so nothing posts it.
    expect(panelSrc.includes('formula_${fieldKey}_result')).toBe(false);
  });

  it('the special-cased calc-breakdown block (seven legacy sub-editors) is gone with its section', () => {
    expect(panelSrc.includes("key === 'entitlementCalcBreakdown'")).toBe(false);
    expect(panelSrc.includes('LEAVE_FORMULA_COMPONENT_KEYS')).toBe(false);
    expect(panelSrc.includes('formula.component.')).toBe(false);
  });

  it('template-sourced wording is LABELLED as a suggestion, so HR knows it is not stored yet', () => {
    expect(panelSrc.includes('formulaTemplate')).toBe(true);
    expect(panelSrc.includes('applyLeaveFormulaTemplate')).toBe(true);
    expect(panelSrc.includes("t('formula.templateHint')")).toBe(true);
    // "From the template" means: this type has none of its own for this item.
    expect(panelSrc.includes('!formulaExplanations?.[key] && defaults[key] != null')).toBe(true);
  });

  it('the action builds the explanation map over the (now narrowed) key list, and drops the result field', () => {
    const actionsSrc = read('/app/admin/actions.ts');
    expect(actionsSrc.includes('LEAVE_EXPLANATION_KEYS.map')).toBe(true);
    expect(actionsSrc.includes('LEAVE_FORMULA_COMPONENT_KEYS')).toBe(false);
    expect(actionsSrc.includes('formula_${key}_result')).toBe(false);
  });
});

describe('employee: hover tooltip on any explained row', () => {
  const panel = read('/components/leave/LeaveDetailsPanel.tsx');

  it('lookup is by field key for every row', () => {
    expect(panel.includes("section.key === 'calcBreakdown'")).toBe(false);
    expect(panel.includes('data.formulaExplanations?.[f.key]')).toBe(true);
  });

  it('hover/focus reveal, tap toggles, Escape dismisses', () => {
    expect(panel).toMatch(/role="tooltip"/);
    expect(panel).toMatch(/onMouseEnter/);
    expect(panel).toMatch(/onMouseLeave/);
    expect(panel).toMatch(/onFocus/);
    expect(panel).toMatch(/onBlur/);
    expect(panel).toMatch(/onClick=\{\(\) => toggleRow\(rowKey\)\}/);
    expect(panel).toMatch(/e\.key === 'Escape'/);
    expect(panel.includes('expandedRows')).toBe(false);
  });

  it('Description and Formula Explanation render on separate lines; Result is gone', () => {
    for (const label of ['explanationDescription', 'explanationFormula']) {
      expect(panel.includes(`t('${label}')`)).toBe(true);
    }
    expect(panel.includes("t('explanationResult')")).toBe(false);
    // An entry with neither field shows NO icon — `hasExpl` must not still be satisfied by a stale result.
    expect(panel.includes('explanation.description || explanation.formula)')).toBe(true);
  });

  it('a11y smoke: focusable button, named, with aria-expanded + aria-describedby wiring', () => {
    expect(panel).toMatch(/aria-expanded=\{isOpen\}/);
    expect(panel).toMatch(/aria-describedby=\{isOpen \? tooltipId : undefined\}/);
    expect(panel).toMatch(/aria-label=\{isOpen \? t\('explanationHide'\) : t\('explanationShow'\)\}/);
    expect(panel.includes('type="button"')).toBe(true);
  });

  it('the static tooltip yields to an HR explanation (one icon per row)', () => {
    // r303 (31492f74) UPDATED: on the employee mounts this is exactly as before — one icon per row, the HR
    // explanation superseding the static tooltip. On the HR mounts (`explained` non-null) NEITHER icon renders:
    // the generated sentences replace them and HR's explanation shows as a plain paragraph underneath.
    // Rendered proof, both sides: test/r303-leave-summary-explain.dom.test.tsx.
    expect(panel.includes('{!explained && f.tooltipKey && !hasExpl && (')).toBe(true);
    expect(panel.includes('{!explained && hasExpl && (')).toBe(true);
    expect(panel.includes('{explained && (')).toBe(true);
  });
});

describe('i18n across all six locales', () => {
  for (const loc of LOCALES) {
    const msgs = JSON.parse(read(`/messages/${loc}.json`));
    it(`${loc}: the two field labels + the template hint; retired strings are gone`, () => {
      const formula = msgs.admin.leave.formula as Record<string, unknown>;
      for (const key of ['descriptionLabel', 'formulaLabel', 'templateHint']) {
        expect(typeof formula[key], `${loc}.admin.leave.formula.${key}`).toBe('string');
        expect((formula[key] as string).length).toBeGreaterThan(0);
      }
      // Retired with the sections and the field they described.
      for (const key of ['sectionTitle', 'help', 'configured', 'resultLabel', 'component']) {
        expect(formula[key], `${loc}.admin.leave.formula.${key} retired`).toBeUndefined();
      }
    });

    it(`${loc}: the checklist labels the nine summary items and nothing else`, () => {
      const essView = msgs.admin.leave.essView as Record<string, unknown>;
      for (const key of ESS_VIEW_COMPONENT_KEYS) {
        expect(typeof essView[key], `${loc}.admin.leave.essView.${key}`).toBe('string');
      }
      // Labels for items the summary no longer has would be an offer the screen cannot keep.
      for (const gone of ['unplanned', 'overutilized', 'carryForwardExpiry', 'entitlementCalcBreakdown']) {
        expect(essView[gone], `${loc}.admin.leave.essView.${gone} retired`).toBeUndefined();
      }
      expect(typeof essView.sectionTitle).toBe('string');
      expect((essView.help as string).length).toBeGreaterThan(0);
    });

    it(`${loc}: the employee hover labels survive, minus the Result line`, () => {
      const breakdown = msgs.leave.breakdown as Record<string, unknown>;
      for (const key of ['explanationDescription', 'explanationFormula', 'explanationShow', 'explanationHide']) {
        expect(typeof breakdown[key], `${loc}.leave.breakdown.${key}`).toBe('string');
      }
      expect(breakdown.explanationResult, `${loc}.leave.breakdown.explanationResult retired`).toBeUndefined();
    });
  }
});
