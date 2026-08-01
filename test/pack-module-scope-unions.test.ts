/**
 * The module-scope pack unions are NOT empty at import time.
 *
 * r91 browser-verified that "Seed Malaysia defaults" on Pay Items appeared to do nothing, and recorded a
 * SUSPECTED cause: `core/pay-components.ts` computes its constants from `countryPacks()` at MODULE LOAD,
 * so if the registry were unpopulated at that moment the arrays would be empty for the life of the
 * process and the seed loop would iterate zero times, reporting success.
 *
 * THAT HYPOTHESIS IS WRONG, and r91 hedged it correctly as "suspected, NOT yet confirmed". These modules
 * import `countryPacks` FROM `localization/registry`, which is the same module whose top-level body calls
 * `registerPack`. ESM fully evaluates an imported module before the importer's body runs, so registration
 * always precedes the union. Verified empirically in the adversarial order (importing pay-components
 * first): the union resolves 3 remuneration types and 13 component defaults, never 0.
 *
 * The failure mode is still worth a guard, because it is one refactor away: move the registration behind
 * a lazy call, or introduce an import cycle between core/ and localization/, and these become silently
 * empty. Nothing would fail loudly — a seed that inserts nothing and reports "0 created" looks like a
 * catalog that was already complete. That is precisely why r91's report was so hard to diagnose.
 */
import { describe, expect, it } from 'vitest';
import { PCB_REMUNERATION_TYPES } from '../core/pay-components';
import { EA_FIELDS } from '../core/ea-override';
import { countryPacks } from '../localization/registry';

describe('pack-derived module-scope constants resolve at import time', () => {
  it('the registry is populated before any module-scope union is computed', () => {
    expect(countryPacks().length).toBeGreaterThan(0);
  });

  // Each of these is a `countryPacks().flatMap(...)` evaluated at module load. An empty array here means
  // the registry was not yet populated when this module's body ran.
  it('pay-component PCB vocabulary is non-empty', () => {
    expect(PCB_REMUNERATION_TYPES.length).toBeGreaterThan(0);
  });

  it('EA field vocabulary is non-empty', () => {
    expect(EA_FIELDS.length).toBeGreaterThan(0);
  });

  // The seed's own source. If this were empty, seedPayComponentCatalog would iterate zero times and
  // report a successful no-op — the exact symptom r91 saw and could not explain.
  it('the MY pack really supplies the pay-component defaults the seed loops over', () => {
    const defaults = countryPacks().flatMap((p) => p.payComponents.defaults);
    expect(defaults.length, 'an empty catalog makes "Seed defaults" a silent no-op').toBeGreaterThan(0);
    expect(defaults.some((d) => d.code === 'BASIC')).toBe(true);
  });
});
