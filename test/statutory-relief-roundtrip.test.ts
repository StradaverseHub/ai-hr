/**
 * 2e3ec77d — saving the advanced statutory editor must not DELETE a relief it does not render.
 *
 * THE LIVE BUG THIS PINS. components/statutory-config-form.tsx rebuilt `pcb.reliefs` as a fresh object
 * from the four fields the form shows — individual, spouse, perChild, epfReliefCap — with no spread of the
 * value it started from. `pcb.reliefs` carries a FIFTH the payroll kernel reads, `disabledIndividual`
 * (the further deduction a registered disabled employee receives), and this screen has never rendered it.
 *
 * So every save through the editor dropped it, and because localization/my/payroll.ts reads it as
 * `pcb.reliefs.disabledIndividual ?? DEFAULT_MY_STATUTORY.pcb.reliefs.disabledIndividual ?? 0`, the loss was
 * SILENT: the ruleset quietly reverted to the pack's built-in figure. A tenant who had corrected that
 * amount lost the correction, with no error and nothing on screen, and the monthly tax of every flagged
 * employee moved the following month.
 *
 * WHY A TEST AND NOT JUST THE SPREAD. The spread fixes today's fifth key. The NEXT relief added to the
 * ruleset will be dropped exactly the same way unless something fails when it happens — and the same file
 * already carries a written warning about this hazard for the `ot` slice, which did not stop the reliefs
 * being written the unsafe way. A comment did not hold. This does.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assemble, initState } from '../components/statutory-config-form';
import {
  DEFAULT_MY_STATUTORY,
  MY_EPF_THIRD_SCHEDULE_PART_A,
  MY_EPF_THIRD_SCHEDULE_PART_E,
  type StatutoryRuleset,
} from '../localization/my/statutory-tables';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const formSrc = readFileSync(resolve(ROOT, 'components/statutory-config-form.tsx'), 'utf8');

/** The `pcb: { ... }` object literal the form builds on save. */
function pcbBlock(): string {
  const start = formSrc.indexOf('    pcb: {');
  expect(start, 'the pcb block is where it was').toBeGreaterThan(-1);
  return formSrc.slice(start, formSrc.indexOf('\n    },', start));
}

describe('2e3ec77d · the statutory editor preserves reliefs it does not render', () => {
  it('the reliefs object SPREADS its base before overwriting the edited fields', () => {
    const pcb = pcbBlock();
    const reliefsAt = pcb.indexOf('reliefs: {');
    expect(reliefsAt, 'reliefs is still built here').toBeGreaterThan(-1);
    const reliefs = pcb.slice(reliefsAt, pcb.indexOf('},', reliefsAt));

    // The whole fix, in one assertion: the spread must be present AND must come first, or a key it
    // restores would be clobbered by the four literals below it.
    expect(reliefs).toContain('...base.pcb.reliefs');
    expect(reliefs.indexOf('...base.pcb.reliefs')).toBeLessThan(reliefs.indexOf('individual:'));
  });

  it('the four rendered fields are still written, so the editor still edits', () => {
    const reliefs = pcbBlock();
    for (const f of ['individual:', 'spouse:', 'perChild:', 'epfReliefCap:']) {
      expect(reliefs).toContain(f);
    }
  });

  it('disabledIndividual is a REAL relief the kernel reads — the thing that was being dropped', () => {
    // If this key ever stops existing, the bug above stops mattering and this file can be re-scoped.
    // Until then it is the proof that the fix is not theoretical.
    const tables = readFileSync(resolve(ROOT, 'localization/my/statutory-tables.ts'), 'utf8');
    expect(tables).toMatch(/disabledIndividual:\s*\d+/);
    const payroll = readFileSync(resolve(ROOT, 'localization/my/payroll.ts'), 'utf8');
    expect(payroll).toContain('pcb.reliefs.disabledIndividual');
    // And the fallback is what made the loss silent rather than loud.
    expect(payroll).toMatch(/disabledIndividual\s*\?\?/);
  });

  it('the form does NOT render disabledIndividual, which is why the spread is the fix', () => {
    // Stated as a fact rather than a complaint: adding it to the form is a separate, larger item
    // (d64d0df4). What must hold meanwhile is that not rendering it does not delete it.
    expect(formSrc).not.toContain('reliefDisabledIndividual');
  });

  it('the ot slice is still carried whole — the precedent this fix follows', () => {
    // The same file already solved this for overtime and wrote down why. Kept asserted so the two stay
    // consistent, and so the reasoning stays discoverable next to the reliefs fix.
    expect(pcbBlock().length).toBeGreaterThan(0);
    expect(formSrc).toContain('ot: base.ot');
  });
});

/**
 * d64d0df4 — THE SAME ROUND TRIP, RUN RATHER THAN READ, and extended to the reliefs this item adds.
 *
 * The block above asserts the SHAPE of the source. These assertions actually call `initState` → `assemble`
 * and compare the object that comes out, which is what a real save does. They are here rather than in
 * test/statutory-disabled-spouse-child-table.test.ts on purpose: this file is the one place that owns
 * "the editor must not delete a relief it does not render", and the answer to "does the NEXT relief
 * survive?" belongs beside the question rather than in whichever item happened to add it.
 *
 * `disabledSpouse` and `childByCategory` (item d64d0df4) are the second and third keys the form has never
 * rendered — and `childByCategory` is the first that is a MAP rather than a scalar, so it also proves the
 * spread carries a nested value through by reference-or-value rather than flattening it.
 */
describe('d64d0df4 · the same round trip, executed — the new reliefs survive it too', () => {
  const EPF_FALLBACK = { partA: MY_EPF_THIRD_SCHEDULE_PART_A, partE: MY_EPF_THIRD_SCHEDULE_PART_E };

  it('open the editor, change nothing, publish ⇒ pcb.reliefs is byte-identical', () => {
    const out = assemble(
      initState(DEFAULT_MY_STATUTORY, EPF_FALLBACK),
      DEFAULT_MY_STATUTORY,
      EPF_FALLBACK,
    ) as StatutoryRuleset;
    expect(out.pcb.reliefs).toEqual(DEFAULT_MY_STATUTORY.pcb.reliefs);
    // Named explicitly: these are the keys the form does NOT edit and used to drop on the floor.
    expect(out.pcb.reliefs.disabledIndividual).toBe(DEFAULT_MY_STATUTORY.pcb.reliefs.disabledIndividual);
    expect(out.pcb.reliefs.disabledSpouse).toBe(DEFAULT_MY_STATUTORY.pcb.reliefs.disabledSpouse);
    expect(out.pcb.reliefs.childByCategory).toEqual(DEFAULT_MY_STATUTORY.pcb.reliefs.childByCategory);
  });

  it('an EDIT to one of the four editable reliefs still carries the other keys through', () => {
    const state = initState(DEFAULT_MY_STATUTORY, EPF_FALLBACK);
    const out = assemble(
      { ...state, reliefIndividual: '9500' },
      DEFAULT_MY_STATUTORY,
      EPF_FALLBACK,
    ) as StatutoryRuleset;
    expect(out.pcb.reliefs.individual).toBe(9500);
    expect(out.pcb.reliefs.disabledIndividual).toBe(DEFAULT_MY_STATUTORY.pcb.reliefs.disabledIndividual);
    expect(out.pcb.reliefs.disabledSpouse).toBe(DEFAULT_MY_STATUTORY.pcb.reliefs.disabledSpouse);
    expect(out.pcb.reliefs.childByCategory).toEqual(DEFAULT_MY_STATUTORY.pcb.reliefs.childByCategory);
  });

  it('a CORRECTED figure the owner signed off survives an unrelated save of the same screen', () => {
    // The failure this pins: the owner corrects an unverified pending figure, someone else opens the
    // editor to change the EPF cap, and the correction is silently undone.
    const corrected: StatutoryRuleset = {
      ...DEFAULT_MY_STATUTORY,
      pcb: {
        ...DEFAULT_MY_STATUTORY.pcb,
        reliefs: {
          ...DEFAULT_MY_STATUTORY.pcb.reliefs,
          disabledIndividual: 6543,
          disabledSpouse: 4321,
          childByCategory: { ...DEFAULT_MY_STATUTORY.pcb.reliefs.childByCategory, disabled: 6789 },
        },
      },
    };
    const state = initState(corrected, EPF_FALLBACK);
    const out = assemble({ ...state, reliefEpfCap: '4500' }, corrected, EPF_FALLBACK) as StatutoryRuleset;
    expect(out.pcb.reliefs.epfReliefCap).toBe(4500);
    expect(out.pcb.reliefs.disabledIndividual).toBe(6543);
    expect(out.pcb.reliefs.disabledSpouse).toBe(4321);
    expect(out.pcb.reliefs.childByCategory?.disabled).toBe(6789);
  });

  it('a relief the form does not edit is never MATERIALISED into an override that omitted it', () => {
    // A figure still awaiting sign-off must not be frozen into tenant data by an unrelated save; absent
    // stays absent, and pcbMonth resolves it through the fallback the PCB configuration screen displays.
    const legacy = {
      ...DEFAULT_MY_STATUTORY,
      pcb: { ...DEFAULT_MY_STATUTORY.pcb, reliefs: { ...DEFAULT_MY_STATUTORY.pcb.reliefs } },
    };
    delete (legacy.pcb.reliefs as Record<string, unknown>).disabledSpouse;
    delete (legacy.pcb.reliefs as Record<string, unknown>).childByCategory;
    const out = assemble(initState(legacy, EPF_FALLBACK), legacy, EPF_FALLBACK) as StatutoryRuleset;
    expect('disabledSpouse' in out.pcb.reliefs).toBe(false);
    expect('childByCategory' in out.pcb.reliefs).toBe(false);
  });
});
