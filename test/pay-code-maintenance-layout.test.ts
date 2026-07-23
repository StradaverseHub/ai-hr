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

describe('13b7517b — three-card structure in order', () => {
  const basicAt = formSrc.indexOf("t('sectionBasic')");
  const payAt = formSrc.indexOf("t('sectionPaySettings')");
  const statutoryAt = formSrc.indexOf("t('sectionConfig')");

  it('renders Basic Information, then Pay Settings, then Government Statutory Configuration', () => {
    expect(basicAt).toBeGreaterThan(-1);
    expect(payAt).toBeGreaterThan(basicAt);
    expect(statutoryAt).toBeGreaterThan(payAt);
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
  it('renames Payroll Configuration and introduces Pay Settings', () => {
    expect(en.payComponents.sectionConfig).toBe('Government Statutory Configuration');
    expect(en.payComponents.sectionPaySettings).toBe('Pay Settings');
    expect(en.payComponents.sectionBasic).toBe('Basic Information');
  });
});
