/**
 * 7cd914b1 rev 2 — the Carry cap (days) input is gone from PERCENTAGE mode.
 *
 * The three-mode Carry Forward Policy shipped in r117. What the reporter contested afterwards is that
 * percentage mode still rendered a Carry cap (days) box beside the percentage, and that cap was not
 * decoration: `resolveCarryAllowance` takes the SMALLER of the two, so a type set to "carry 50%" while
 * still holding an old cap of 5 days carried 5 days, with nothing on screen saying which number won.
 *
 * DB-free source guard (this repo's `dom` project cannot render the RSC panel): assert the composition
 * statically, the same way test/entitlement-rules-card-removal.test.ts does.
 *
 * WHAT THIS PINS, and why each one is here rather than left to review:
 *   1. percent mode renders NO carryForwardMax number input  — the defect itself;
 *   2. percent mode DOES post an explicit hidden zero        — `app/admin/actions.ts` reads
 *      carryForwardMax as `num(...) ?? null`, which is NOT tri-state, so an omitted field would clear
 *      it anyway; the explicit zero is what makes the intent readable at the call site;
 *   3. fixed_max mode STILL renders its cap input            — the reporter asked for percentage only;
 *   4. the expiry fields are still reachable from percent mode — explicitly asked to be kept;
 *   5. the engine clamp SURVIVES                             — it is the hand-edited-data backstop;
 *   6. `carryHelp` no longer claims the cap acts as a ceiling, in all six catalogs;
 *   7. `carryCapLabel` SURVIVES in all six                   — Fixed Maximum still renders it, and
 *      pruning it by prefix is precisely the mistake r137 made one level down in the catalog.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const panel = read('/components/leave-type-panel.tsx');
const engine = read('/core/leave-compute.ts');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/** The `mode === 'percent' ? ( … ) : ( … )` arm of CarryPolicyForm, sliced from its source. */
function percentBranch(): string {
  const form = panel.slice(panel.indexOf('function CarryPolicyForm('));
  expect(form).not.toBe('');
  const start = form.indexOf("mode === 'percent' ? (");
  expect(start).toBeGreaterThan(-1);
  // Ends where the ternary's alternative begins — the `) : (` that opens the fixed_max arm.
  const end = form.indexOf(') : (', start);
  expect(end).toBeGreaterThan(start);
  return form.slice(start, end);
}

function fixedMaxBranch(): string {
  const form = panel.slice(panel.indexOf('function CarryPolicyForm('));
  const alt = form.indexOf(') : (', form.indexOf("mode === 'percent' ? ("));
  const end = form.indexOf('<CarryExpiryFields', alt);
  expect(end).toBeGreaterThan(alt);
  return form.slice(alt, end);
}

describe('7cd914b1 rev 2 — percentage mode shows one number', () => {
  it('renders no Carry cap NUMBER input in percent mode', () => {
    const branch = percentBranch();
    expect(branch).toContain('name="carryForwardPercent"');
    // The defect: a `type="number"` input bound to carryForwardMax living in this branch.
    expect(branch).not.toMatch(/name="carryForwardMax"[^>]*type="number"/);
    expect(branch).not.toMatch(/type="number"[^>]*name="carryForwardMax"/);
  });

  it('posts an explicit hidden zero for the cap instead of omitting the field', () => {
    expect(percentBranch()).toMatch(/<input\s+type="hidden"\s+name="carryForwardMax"\s+value="0"\s*\/>/);
  });

  it('does not render the cap LABEL in percent mode', () => {
    expect(percentBranch()).not.toContain("t('carryCapLabel')");
  });

  it('leaves Fixed Maximum untouched — its cap input is still there', () => {
    const branch = fixedMaxBranch();
    expect(branch).toContain("t('carryCapLabel')");
    expect(branch).toMatch(/name="carryForwardMax"[^>]*type="number"/);
  });

  it('keeps the carry expiry fields reachable from percent mode', () => {
    // CarryExpiryFields sits OUTSIDE the mode ternary, so both modes render it. If someone moves it
    // inside the fixed_max arm, percentage types silently lose their expiry configuration.
    const form = panel.slice(panel.indexOf('function CarryPolicyForm('));
    const ternaryEnd = form.indexOf('<CarryExpiryFields');
    const percentStart = form.indexOf("mode === 'percent' ? (");
    expect(ternaryEnd).toBeGreaterThan(percentStart);
    expect(form.slice(percentStart, ternaryEnd)).toContain(') : (');
  });
});

describe('7cd914b1 rev 2 — the engine clamp is a backstop and must survive', () => {
  it('resolveCarryAllowance still takes the smaller of percentage and cap', () => {
    // Deliberately asserting the SOURCE, not just behaviour: the behavioural cases live in
    // carry-forward-percent.test.ts, and this one exists so that deleting the clamp as "dead code"
    // fails with a message saying why it is not dead.
    expect(engine).toMatch(/Math\.min/);
    expect(engine).toContain('hand-written UPDATE');
  });
});

describe('7cd914b1 rev 2 — the help text stops describing a ceiling', () => {
  for (const loc of LOCALES) {
    it(`${loc}: carryHelp no longer says the cap caps the percentage`, () => {
      const cat = JSON.parse(read(`/messages/${loc}.json`));
      const help: string = cat.admin.leave.subStep.carryHelp;
      expect(typeof help).toBe('string');
      expect(help.length).toBeGreaterThan(0);
      // The English clause and the zh rendering of it are the two that state the old rule literally.
      expect(help).not.toContain('acting as a ceiling');
      expect(help).not.toContain('上限作为最高限额');
    });

    it(`${loc}: carryCapLabel SURVIVES — Fixed Maximum still renders it`, () => {
      const cat = JSON.parse(read(`/messages/${loc}.json`));
      expect(cat.admin.leave.carryCapLabel).toBeTruthy();
    });
  }
});
