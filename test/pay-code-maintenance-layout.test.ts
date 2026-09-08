/**
 * 13b7517b — Pay Code maintenance screen redesign: static layout assertions (source-assertion
 * convention, cf. test/pay-components-split-page.test.ts).
 *
 * The redesign is UI-only — no schema, action, or engine changes — so this file pins the layout
 * contract itself: the derived Input Type field is gone from the maintenance form (but the list
 * page KEEPS its column and derivation), and the form reads top-to-bottom as three cards —
 * Basic Information, Pay Settings (rounding + the "How is this calculated?" pay-rule editor),
 * Government Statutory Configuration (statutory flags + hint). Submission plumbing is untouched:
 * everything stays inside the single form with the eaFormLine passthrough.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', 'app', 'admin', 'pay-components');
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');

const formSrc = read(DIR, 'component-form.tsx');
const listSrc = read(DIR, 'page.tsx');
const en = JSON.parse(readFileSync(join(__dirname, '..', 'messages', 'en.json'), 'utf8'));

describe('13b7517b — Input Type removed from the maintenance form only', () => {
  it('the form no longer renders the Input Type field nor keeps its derivation helper', () => {
    expect(formSrc).not.toContain('colInputType');
    expect(formSrc).not.toContain('inputTypeOf');
  });

  it('the list page KEEPS its Input Type column and derivation (out of this scope)', () => {
    expect(listSrc).toContain('colInputType');
    expect(listSrc).toContain('inputTypeOf');
  });
});

describe('13b7517b — card structure in order (711adcd2: four cards, and full width)', () => {
  const basicAt = formSrc.indexOf("t('sectionBasic')");
  const orpAt = formSrc.indexOf("t('sectionOrp')");
  const payAt = formSrc.indexOf("t('sectionPaySettings')");
  const statutoryAt = formSrc.indexOf("t('sectionConfig')");

  it('renders General Information, then Ordinary Rate of Pay, then Calculation, then Statutory Configuration', () => {
    // 711adcd2 UPDATES 13b7517b's three-card case rather than replacing it: the three cards are all still
    // here, in the same relative order, and the reporter's ORP card is inserted SECOND — beside Category,
    // which is the setting it took over from, and above the mechanics of how the amount is worked out.
    expect(basicAt).toBeGreaterThan(-1);
    expect(orpAt).toBeGreaterThan(basicAt);
    expect(payAt).toBeGreaterThan(orpAt);
    expect(statutoryAt).toBeGreaterThan(payAt);
  });

  it('is FULL WIDTH, with Back top-left and Cancel/Save bottom-right', () => {
    // The screen was capped at max-w-3xl, which is what the reporter's redesign asked us to lift.
    expect(formSrc).not.toContain('max-w-3xl');
    expect(formSrc).toContain('back={{ href: LIST');
    const toolbarAt = formSrc.indexOf('justify-end');
    expect(toolbarAt).toBeGreaterThan(statutoryAt);
  });

  it('the two ORP tick boxes are submitted by NAME and are never disabled', () => {
    // A disabled control posts nothing, and the action reads an absent field as UNTICKED — so disabling a
    // box would silently clear a stored flag and re-price somebody's overtime. The deduction case is a
    // warning, never a lock. (Asserted on the island, which is where the controls live.)
    const orpSrc = read(DIR, 'orp-config.tsx');
    expect(orpSrc).toContain('name="orpUnpaidLeave"');
    expect(orpSrc).toContain('name="orpOvertime"');
    expect(orpSrc).not.toContain('disabled');
    expect(orpSrc).toContain('orpDeductionWarning');
  });

  it('Pay Settings holds the rounding select and the pay-rule editor; the statutory card holds the flags + hint', () => {
    const roundingAt = formSrc.indexOf('name="roundingMethod"');
    const ruleEditorAt = formSrc.indexOf('<PayRuleEditor');
    const statutoryConfigAt = formSrc.indexOf('<StatutoryConfig');
    const flagsHintAt = formSrc.indexOf("t('flagsHint')");
    // rounding + rule editor sit between the Pay Settings and statutory headings
    for (const at of [roundingAt, ruleEditorAt]) {
      expect(at).toBeGreaterThan(payAt);
      expect(at).toBeLessThan(statutoryAt);
    }
    // statutory flags and their hint stay together under the statutory heading
    expect(statutoryConfigAt).toBeGreaterThan(statutoryAt);
    expect(flagsHintAt).toBeGreaterThan(statutoryConfigAt);
  });

  it('submission plumbing is unchanged: single form, eaFormLine passthrough intact', () => {
    expect(formSrc.match(/<form /g)).toHaveLength(1);
    expect(formSrc).toContain('name="eaFormLine"');
  });
});

describe('13b7517b — headings say what each card is for (en)', () => {
  it('the headings are the four the reporter drew', () => {
    // 711adcd2 UPDATES 13b7517b's case with the reporter's own section names. The KEYS are unchanged —
    // only their English values — so no locale loses a string and no screen loses a heading.
    expect(en.payComponents.sectionBasic).toBe('General Information');
    expect(en.payComponents.sectionOrp).toBe('Ordinary Rate of Pay (ORP) Calculation');
    expect(en.payComponents.sectionPaySettings).toBe('Calculation');
    expect(en.payComponents.sectionConfig).toBe('Statutory Configuration');
  });

  it('the renamed vocabulary reads as the reporter asked, in every locale', () => {
    // Category: Allowance -> Earning, Non-Payable (BIK) -> Non-Payable. Payroll Category: Allowance ->
    // Earning, plus Benefit in Kind (BIK), and "Automatic (from Statutory Settings)" renamed rather than
    // removed — six of the reporter's 29 items are on it and it decides nothing statutory.
    expect(en.payComponents.kind_allowance).toBe('Earning');
    expect(en.payComponents.kind_non_payable).toBe('Non-Payable');
    expect(en.payComponents.displayCategory_allowance).toBe('Earning');
    expect(en.payComponents.displayCategory_bik).toBe('Benefit in Kind (BIK)');
    expect(en.payComponents.displayCategory_auto).toBe('Work it out automatically');
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(readFileSync(join(__dirname, '..', 'messages', `${loc}.json`), 'utf8'));
      for (const k of ['sectionOrp', 'sectionOrpHint', 'orpUnpaidLeaveLabel', 'orpUnpaidLeaveHint', 'orpOvertimeLabel', 'orpOvertimeHint', 'orpDeductionWarning', 'orpStatutoryNote', 'displayCategory_bik']) {
        expect(m.payComponents[k], `payComponents.${k} in ${loc}`).toBeTruthy();
      }
      // Not left in English: each locale's own words, not a copy of ours.
      if (loc !== 'en') {
        expect(m.payComponents.sectionOrp, `${loc} sectionOrp translated`).not.toBe(en.payComponents.sectionOrp);
        expect(m.payComponents.orpOvertimeLabel, `${loc} orpOvertimeLabel translated`).not.toBe(en.payComponents.orpOvertimeLabel);
      }
    }
  });
});
