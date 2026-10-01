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

/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. `components/leave-type-panel.tsx` (3,367 lines)
 * was DELETED with the page that mounted it: the four steps and six sub-steps it carried are the FIVE
 * TABS of `/admin/leave-config/types` (IA §2). The panel became three files, so what this guard reads is
 * their concatenation — the property it pins is about the leave TYPE screen, not about one filename, and
 * pinning it to a file that no longer exists would have taken the guard out rather than moved it.
 */
const panel = ['/app/admin/leave-config/types/page.tsx', '/app/admin/leave-config/types/leave-type-tabs.tsx', '/app/admin/leave-config/types/leave-type-sub-forms.tsx']
  .map((f) => read(f))
  .join('\n');
const engine = read('/core/leave-compute.ts');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/**
 * The body of `CarryPolicyForm`, from its declaration to the end of the concatenated source.
 *
 * ⚠️ r375 — `expect(form).not.toBe('')` USED TO STAND HERE AND CAUGHT NOTHING. When `indexOf` misses it
 * returns −1, and `panel.slice(-1)` is the LAST CHARACTER of the file, not `""` — a non-empty string that
 * sails past an emptiness check. (The sibling trap is `slice(-1, n)`, which IS `""` because a negative
 * start is read as `length + start`; `test/r219-ea-cp8a-form.test.ts` asserted nothing at all for 27
 * rounds that way.) Every marker below is therefore asserted `>= 0` — never truthy, since −1 is truthy —
 * BEFORE it is used to slice, and every slice is asserted substantial. A length assertion is the only
 * thing separating "no violations found" from "no text searched".
 */
function formBody(): string {
  const at = panel.indexOf('function CarryPolicyForm(');
  expect(at, 'CarryPolicyForm was renamed or removed — this whole guard would otherwise no-op').toBeGreaterThanOrEqual(0);
  const form = panel.slice(at);
  expect(form.length, 'the sliced CarryPolicyForm body is not substantial').toBeGreaterThan(500);
  return form;
}

/** The `mode === 'percent' ? ( … )` arm of CarryPolicyForm, sliced from its source. */
function percentBranch(): string {
  const form = formBody();
  const start = form.indexOf("mode === 'percent' ? (");
  expect(start, 'the percent-mode ternary marker was renamed').toBeGreaterThanOrEqual(0);
  // Ends where the ternary's alternative begins — the `) : (` that opens the fixed_max arm.
  const end = form.indexOf(') : (', start);
  expect(end, 'the `) : (` that closes the percent arm was not found').toBeGreaterThan(start);
  const slice = form.slice(start, end);
  expect(slice.length, 'the sliced percent branch is not substantial — the guard would assert nothing').toBeGreaterThan(200);
  return slice;
}

function fixedMaxBranch(): string {
  const form = formBody();
  const pct = form.indexOf("mode === 'percent' ? (");
  expect(pct, 'the percent-mode ternary marker was renamed').toBeGreaterThanOrEqual(0);
  const alt = form.indexOf(') : (', pct);
  expect(alt, 'the `) : (` that opens the fixed_max arm was not found').toBeGreaterThan(pct);
  const end = form.indexOf('<CarryExpiryFields', alt);
  expect(end, 'CarryExpiryFields no longer follows the mode ternary').toBeGreaterThan(alt);
  const slice = form.slice(alt, end);
  expect(slice.length, 'the sliced fixed_max branch is not substantial — the guard would assert nothing').toBeGreaterThan(200);
  return slice;
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
    const form = formBody();
    const percentStart = form.indexOf("mode === 'percent' ? (");
    expect(percentStart, 'the percent-mode ternary marker was renamed').toBeGreaterThanOrEqual(0);
    const ternaryEnd = form.indexOf('<CarryExpiryFields', percentStart);
    expect(ternaryEnd, 'CarryExpiryFields was not found after the mode ternary').toBeGreaterThan(percentStart);
    const between = form.slice(percentStart, ternaryEnd);
    expect(between.length, 'the slice between the ternary and CarryExpiryFields is not substantial').toBeGreaterThan(200);
    expect(between).toContain(') : (');
  });
});

describe('7cd914b1 rev 2 — the engine clamp is a backstop and must survive', () => {
  it('resolveCarryAllowance still takes the smaller of percentage and cap', () => {
    // Deliberately asserting the SOURCE, not just behaviour: the behavioural cases live in
    // carry-forward-percent.test.ts, and this one exists so that deleting the clamp as "dead code"
    // fails with a message saying why it is not dead.
    // r375 — the same discipline: a guard that searches a file must prove it read one.
    expect(engine.length, 'core/leave-compute.ts read as empty — this guard would assert nothing').toBeGreaterThan(1000);
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
