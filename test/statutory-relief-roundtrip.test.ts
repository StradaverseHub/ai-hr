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
