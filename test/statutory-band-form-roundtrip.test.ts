/**
 * SOCSO/EIS editable band grid — the byte-identical round-trip invariant (feedback ee6e1292).
 *
 * The config form now lets an admin edit the SOCSO Cat 1 / Cat 2 and EIS RM-amount band tables. The
 * headline safety property mirrors the whole-ruleset equivalence test: loading the verified default into
 * the form and saving with NO edits must reproduce the SOCSO/EIS bands byte-identically — no dropped
 * `skbbk` leg, no amount run through a percent helper, no reordering. `assemble(initState(DEFAULT))` is
 * the pure representation of "open the editor, change nothing, publish".
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MY_STATUTORY, type StatutoryRuleset } from '../localization/my/statutory-tables';
import { assemble, initState } from '../components/statutory-config-form';

describe('SOCSO/EIS band grid round-trip', () => {
  const out = assemble(initState(DEFAULT_MY_STATUTORY), DEFAULT_MY_STATUTORY) as StatutoryRuleset;

  it('reproduces SOCSO Category 1 bands byte-identically (incl. the SKBBK leg)', () => {
    expect(out.socso.category1).toEqual(DEFAULT_MY_STATUTORY.socso.category1);
    // Guard the exact SKBBK values survived — the field most likely to be silently dropped.
    expect(out.socso.category1.map((b) => b.skbbk)).toEqual(
      DEFAULT_MY_STATUTORY.socso.category1.map((b) => b.skbbk),
    );
  });

  it('reproduces SOCSO Category 2 bands byte-identically (employer-only + SKBBK)', () => {
    expect(out.socso.category2).toEqual(DEFAULT_MY_STATUTORY.socso.category2);
  });

  it('reproduces EIS bands byte-identically', () => {
    expect(out.eis.bands).toEqual(DEFAULT_MY_STATUTORY.eis.bands);
  });

  it('preserves the SOCSO/EIS cross-check rates and verifiedUpTo (not editable in the grid)', () => {
    expect(out.socso.rates).toEqual(DEFAULT_MY_STATUTORY.socso.rates);
    expect(out.socso.verifiedUpTo).toBe(DEFAULT_MY_STATUTORY.socso.verifiedUpTo);
    expect(out.eis.rates).toEqual(DEFAULT_MY_STATUTORY.eis.rates);
  });

  it('does not confuse amounts with percentages (a >1 RM amount stays itself)', () => {
    // SOCSO Cat 1 top band employer = 104.15 RM; a percent round-trip would have mangled it.
    const top = out.socso.category1[out.socso.category1.length - 1];
    expect(top.employer).toBe(104.15);
    expect(top.employee).toBe(29.75);
  });

  // Per-body sub-menu redesign (31646c85): the config form now renders a SUBSET of body sections on each
  // body tab (sections={['epf','ceilings']} on the EPF tab, etc.), but form state is always seeded from the
  // FULL ruleset and the hidden payload is always the FULL assemble(...) output — so unrendered sections
  // round-trip byte-identically by construction. Pin the EPF slice at the FORM layer here: the scalar-merge
  // test (statutory-component-epf-merge) pins it only at the scalar-action layer.
  it('preserves the EPF Third Schedule Part A / Part E through the form round-trip', () => {
    expect(out.epf.partA).toEqual(DEFAULT_MY_STATUTORY.epf.partA);
    expect(out.epf.partE).toEqual(DEFAULT_MY_STATUTORY.epf.partE);
  });

  it('preserves EPF fields the form never renders (scheduleMax / senior / non-citizen rates)', () => {
    expect(out.epf.scheduleMax).toBe(DEFAULT_MY_STATUTORY.epf.scheduleMax);
    expect(out.epf.seniorEmployerRate).toBe(DEFAULT_MY_STATUTORY.epf.seniorEmployerRate);
    expect(out.epf.nonCitizenEmployeeRate).toBe(DEFAULT_MY_STATUTORY.epf.nonCitizenEmployeeRate);
    expect(out.epf.nonCitizenEmployerRate).toBe(DEFAULT_MY_STATUTORY.epf.nonCitizenEmployerRate);
  });
});
