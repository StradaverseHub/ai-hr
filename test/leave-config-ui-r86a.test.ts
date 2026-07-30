/**
 * r86a — the three CONFIGURATION-SCREEN halves of this round, as static source guards.
 *
 * This repo has no DOM or interaction test runner, so the established convention for these components is a
 * static source guard (see leave-type-config-categories.test.ts and leave-type-general-substeps.test.ts).
 * A guard cannot prove a screen LOOKS right — the browser pass does that — but it can prove the contracts
 * that are invisible on screen and expensive to lose: which action a form posts, which tri-state marker it
 * carries, and which of two conflicting CSS utilities actually wins.
 *
 *   §1  4dbe04c6 — the Minimum Service overflow. The guard is the one that would have PREVENTED the bug:
 *       `inputCls` ends in `w-full`, so a template-string `${inputCls} w-28` does not override it and a
 *       `shrink-0` beside it then turns the losing width into an overflow.
 *   §2  9f5164d8 — the rounding editor: four options, the customize toggle, and the single stored boundary.
 *   §3  c6ffa725 — the Application Limits card: its own tri-state marker, Unlimited posting an empty value.
 *   §4  0890a555 — the Scheme Category column and field, and the fact that the suggestion never writes.
 *   §5  i18n — every key these three surfaces name resolves in all six locales. The coverage guard's
 *       check C skips any file using more than one namespace, and leave-type-panel.tsx uses several, so
 *       these keys are unguarded by it and are checked here by hand.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
const schemeSrc = readFileSync(resolve(here, '../components/benefit-scheme-config.tsx'), 'utf8');
const uiSrc = readFileSync(resolve(here, '../components/ui.tsx'), 'utf8');
const actionsSrc = readFileSync(resolve(here, '../app/admin/actions.ts'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const msgs = (loc: string) => JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));

describe('§1 4dbe04c6 · the Minimum Service pair fits its container', () => {
  it('inputCls really does end in a w-full that a later class cannot beat by concatenation', () => {
    // This is the FACT the bug rested on, pinned so the reasoning in the fix cannot go stale: if inputCls
    // ever stops carrying a width, the cn() below becomes merely tidy rather than load-bearing, and a
    // future reader should be told that by a failing test rather than by guessing.
    expect(uiSrc).toMatch(/export const inputCls\s*=\s*\n?\s*'[^']*\bw-full\b/);
  });

  it('both controls compose their classes through cn(), not a template string', () => {
    // cn() is tailwind-merge: it resolves same-property conflicts by LAST WINS, so w-28 and flex-1 take
    // effect. A template string leaves both in the class list and lets the stylesheet order decide, which
    // is what made the select 100% wide and squeezed the number input to 26px.
    expect(panelSrc).toContain("className={cn(inputCls, 'min-w-0 flex-1')}");
    expect(panelSrc).toContain("className={cn(inputCls, 'w-28 shrink-0')}");
  });

  it('no control anywhere pairs a template-string width with shrink-0 again', () => {
    // The exact combination that overflows: a losing width utility PLUS a refusal to shrink. Either alone
    // is harmless, which is why this checks for the pair rather than for template strings in general.
    const offenders = [...panelSrc.matchAll(/className=\{`\$\{inputCls\}[^`]*`\}/g)]
      .map((m) => m[0])
      .filter((cls) => /\bshrink-0\b/.test(cls) && /\bw-[0-9]/.test(cls));
    expect(offenders).toEqual([]);
  });
});

describe('§2 9f5164d8 · the rounding editor', () => {
  it('offers the four methods the request lists, and only those', () => {
    for (const v of ['value="none"', 'value="nearest_half"', 'value="up"', 'value="down"']) {
      expect(panelSrc.includes(`<option ${v}>`), `rounding option ${v}`).toBe(true);
    }
  });

  it('keeps the roundingMethodRendered tri-state marker and does NOT coerce the field with ?? null', () => {
    expect(panelSrc).toContain('<input type="hidden" name="roundingMethodRendered" value="1" />');
    // r85 caught `roundingMethodField(formData) ?? null` about to ship: it would CLEAR stored rounding for
    // any form that ever stopped rendering the control, defeating the tri-state the helper exists to give.
    expect(actionsSrc).toContain('roundingMethod: roundingMethodField(formData),');
    expect(actionsSrc).not.toContain('roundingMethodField(formData) ?? null');
    // The threshold rides the SAME marker and carries the same discipline.
    expect(actionsSrc).toContain('roundingThreshold: roundingThresholdField(formData),');
    expect(actionsSrc).not.toContain('roundingThresholdField(formData) ?? null');
  });

  it('posts exactly ONE roundingThreshold field — the boundary, not four independent numbers', () => {
    // Four stored figures would make "no gaps / no overlaps / full coverage" violable and then need three
    // more validators. One boundary makes them true by construction.
    expect(panelSrc.match(/name="roundingThreshold"/g)).toHaveLength(1);
    expect(panelSrc).toContain('<input type="hidden" name="roundingThreshold"');
  });

  it('shows the thresholds only under Nearest 0.5 day, behind the customize checkbox', () => {
    expect(panelSrc).toContain("const showThresholds = rounding === 'nearest_half';");
    expect(panelSrc).toContain('{custom && <RoundingThresholdEditor');
  });

  it('the worked example runs the REAL evaluator, not a lookalike', () => {
    // An administrator is shown what a rule produces before saving it. A second implementation of the rule
    // is a second thing that can disagree with the ledger.
    expect(panelSrc).toMatch(/import \{[\s\S]*?\bapplyRounding\b[\s\S]*?\} from '@\/core\/leave-compute'/);
    expect(panelSrc).toContain('applyRounding(ROUNDING_EXAMPLE_RAW, rounding, effectiveThreshold)');
  });

  it('the panel receives the stored threshold from the page (or it renders as lost on every reload)', () => {
    expect(pageSrc).toContain('roundingThreshold: lt.roundingThreshold == null ? null : Number(lt.roundingThreshold)');
  });
});

describe('§3 c6ffa725 · the Application Limits card', () => {
  it('sits in the Leave Application Rules sub-step with its own tri-state marker', () => {
    expect(panelSrc).toContain("t('conditionStep.applicationLimitsTitle')");
    expect(panelSrc).toContain('<input type="hidden" name="applicationLimits" value="1" />');
  });

  it('Unlimited posts an EXPLICITLY EMPTY value, which the action reads as a clear', () => {
    // With the marker present, an omitted field and a blank one would both have to mean something and only
    // one of them can. Blank is the clear.
    expect(panelSrc).toContain('<input type="hidden" name="maxDaysPerLeaveYear" value="" />');
    expect(actionsSrc).toContain("maxDaysPerLeaveYearRaw === '' ? null : Number(maxDaysPerLeaveYearRaw)");
  });

  it('the action only touches the column when the marker is present', () => {
    expect(actionsSrc).toContain("const touchApplicationLimits = fd.get('applicationLimits') === '1';");
  });

  it('the panel receives the stored limit from the page', () => {
    expect(pageSrc).toContain('maxDaysPerLeaveYear={lt.maxDaysPerLeaveYear == null ? null : Number(lt.maxDaysPerLeaveYear)}');
  });
});

describe('§4 0890a555 · the Scheme Category column and field', () => {
  it('renders as a column immediately after Employment Type', () => {
    const head = schemeSrc.slice(schemeSrc.indexOf("{t('colEmpType')}"), schemeSrc.indexOf("{t('colName')}</th>"));
    const empAt = head.indexOf("{t('colEmpType')}");
    const catAt = head.indexOf("{t('colSchemeCategory')}");
    const groupAt = head.indexOf("{t('colGradeGroup')}");
    expect(catAt).toBeGreaterThan(empAt);
    expect(groupAt).toBeGreaterThan(catAt);
  });

  it('the editor posts schemeCategory, and the suggestion is only ever a DEFAULT on the add form', () => {
    expect(schemeSrc).toContain('name="schemeCategory"');
    expect(schemeSrc).toContain('suggestSchemeCategory(');
    // An EXISTING scheme is never overwritten by a suggestion — the tenant already decided.
    expect(schemeSrc).toContain('const effectiveCategory = scheme == null && !categoryTouched ? suggestion : category;');
    expect(actionsSrc.match(/schemeCategory: String\(fd\.get\('schemeCategory'\) \?\? ''\)/g)).toHaveLength(2);
  });

  it('the naming rule lives in the shared module, not inline at the call site', () => {
    // r76 Decision 4: one place composes a scheme's identity, and that module is import-free so it stays
    // outside the ADR-0080 pack boundary.
    expect(schemeSrc).toMatch(/import \{[\s\S]*?suggestSchemeCategory[\s\S]*?\} from '@\/lib\/benefit-scheme-label'/);
    const labelSrc = readFileSync(resolve(here, '../lib/benefit-scheme-label.ts'), 'utf8');
    expect(labelSrc).toContain('export function suggestSchemeCategory(');
    expect(labelSrc).not.toMatch(/^import /m); // still import-free
  });
});

describe('§5 i18n — every new key resolves in all six locales', () => {
  const SUB_STEP = [
    'yearType',
    'yearTypeStepHelp',
    'roundingNearestHalf',
    'roundingCustomize',
    'roundingThresholdsTitle',
    'roundingDownRangeLabel',
    'roundingUpRangeLabel',
    'roundingFromInclusive',
    'roundingToExclusive',
    'roundingToInclusive',
    'roundingThresholdHelp',
    'roundingWorkedExample',
  ];
  const CONDITION = [
    'applicationLimitsTitle',
    'applicationLimitYearLabel',
    'applicationLimitUnlimited',
    'applicationLimitLimited',
    'applicationLimitMaxLabel',
    'applicationLimitHelp',
  ];
  const BENEFIT = ['colSchemeCategory', 'schemeCategoryPlaceholder', 'schemeCategoryUnset', 'schemeCategoryHelp'];

  for (const loc of LOCALES) {
    it(`${loc} carries every key, non-blank`, () => {
      const m = msgs(loc);
      for (const k of SUB_STEP) expect(typeof m?.admin?.leave?.subStep?.[k], `${loc} subStep.${k}`).toBe('string');
      for (const k of SUB_STEP) expect(String(m.admin.leave.subStep[k]).trim().length, `${loc} subStep.${k}`).toBeGreaterThan(0);
      for (const k of CONDITION) expect(typeof m?.admin?.leave?.conditionStep?.[k], `${loc} conditionStep.${k}`).toBe('string');
      for (const k of BENEFIT) expect(typeof m?.admin?.benefitScheme?.[k], `${loc} benefitScheme.${k}`).toBe('string');
      expect(typeof m?.leave?.errors?.leaveYearApplicationLimit, `${loc} leave.errors.leaveYearApplicationLimit`).toBe('string');
    });
  }

  it('the application-limit refusal message names every placeholder the error supplies', () => {
    // A message missing a placeholder renders a sentence that cannot be acted on — "you have used ? of ?".
    for (const loc of LOCALES) {
      const text = String(msgs(loc).leave.errors.leaveYearApplicationLimit);
      for (const token of ['{typeName}', '{maxDays}', '{usedDays}', '{yearStart}', '{yearEnd}', '{days}']) {
        expect(text.includes(token), `${loc} missing ${token}`).toBe(true);
      }
    }
  });

  it('the rounding worked example names both of its placeholders', () => {
    for (const loc of LOCALES) {
      const text = String(msgs(loc).admin.leave.subStep.roundingWorkedExample);
      expect(text.includes('{raw}'), `${loc} missing {raw}`).toBe(true);
      expect(text.includes('{rounded}'), `${loc} missing {rounded}`).toBe(true);
    }
  });
});
