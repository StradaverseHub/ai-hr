/**
 * b9c30be0 — Eligibility Gender/Marital pickers: standardized multi-select auto-close.
 *
 * ChipMultiSelect (components/ui/chip-multi-select.tsx) previously dismissed its popover via a
 * full-viewport `fixed inset-0` backdrop rendered inside the component. The two eligibility call
 * sites in components/leave-type-panel.tsx wrapped the control in <Field> (a <label>): a click on
 * the backdrop closed the panel, then the label's activation behaviour forwarded a synthetic click
 * to its first labelable descendant — the trigger button — which toggled the popover open again in
 * the same interaction. Net effect: click-outside never visibly closed the panel. This is the exact
 * label-activation bug ticket 2449fbb7 (standardize multi-select auto-close) diagnosed and fixed
 * for MultiSelectPopover; this change applies the same remedy to ChipMultiSelect:
 *
 * - No backdrop. Outside click closes via a document `mousedown` listener against a root ref (the
 *   components/ui/combobox.tsx idiom, shared by multi-select-popover.tsx).
 * - Escape is handled on the ROOT div (key events bubble from both the trigger and the panel rows),
 *   so it closes the popover even with focus still on the trigger — the normal state right after
 *   opening by mouse.
 * - The component owns its caption via an opt-in `label` prop (useId span + aria-labelledby on the
 *   trigger), and the two leave call sites drop their <Field> wrappers so no <label> exists to
 *   re-activate the trigger. The /performance new-cycle pickers still use <Field> (no label prop),
 *   so the aria-labelledby MUST stay conditional — an unconditional reference to the nonexistent
 *   caption id would compute an EMPTY accessible name and silently strip their field names.
 *
 * The suite has no DOM runner (vitest.config.ts: no jsdom), so the click-outside behaviour itself
 * is browser-verified; this file locks the source shape a regression would silently undo. All
 * markup assertions run on comment-stripped source so doc-comment prose (including this history)
 * can neither satisfy nor trip them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
/** Strip block comments so markup-shaped prose in doc comments can't satisfy (or trip) markup assertions. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');

const CHIP = 'components/ui/chip-multi-select.tsx';
/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. `components/leave-type-panel.tsx` (3,367 lines)
 * was DELETED with the page that mounted it: the four steps and six sub-steps it carried are the FIVE
 * TABS of `/admin/leave-config/types` (IA §2). The panel became three files, so what this guard reads is
 * their concatenation — the property it pins is about the leave TYPE screen, not about one filename, and
 * pinning it to a file that no longer exists would have taken the guard out rather than moved it.
 */
const PANEL_FILES = ['app/admin/leave-config/types/page.tsx', 'app/admin/leave-config/types/leave-type-tabs.tsx', 'app/admin/leave-config/types/leave-type-sub-forms.tsx'];

describe('b9c30be0 · ChipMultiSelect standardized auto-close', () => {
  const chip = stripComments(read(CHIP));
  const panel = stripComments(PANEL_FILES.map((f) => read(f)).join('\n'));

  it('(a) the fixed inset-0 backdrop is gone; outside click closes via document mousedown on the root ref', () => {
    expect(chip).not.toMatch(/fixed inset-0/);
    expect(chip).toContain("document.addEventListener('mousedown'");
    expect(chip).toMatch(/rootRef\.current && !rootRef\.current\.contains\(e\.target as Node\)/);
  });

  it('(b) the hidden inputs render before (outside) the {open && panel guard — form contract survives the close', () => {
    // Same source-order proof as test/multiselect-form-contract.test.ts: if the hidden inputs moved
    // inside the panel, closing the dropdown would unmount them and the save action's getAll() would
    // silently post an empty selection.
    const hiddenAt = chip.indexOf('type="hidden"');
    const openGuardAt = chip.indexOf('{open &&');
    expect(hiddenAt).toBeGreaterThan(-1);
    expect(openGuardAt).toBeGreaterThan(-1);
    expect(hiddenAt, 'hidden inputs must render before (outside) the {open && panel guard').toBeLessThan(
      openGuardAt,
    );
  });

  it('(c) Escape is handled at the ROOT div, not inside the panel — it works with focus still on the trigger', () => {
    // Source-order proof: the root <div> (and its onKeyDown) opens before the {open && panel
    // conditional, so the Escape handler's index must come first. A handler on the panel div only
    // fires once focus is inside the list — Escape straight after opening by mouse would do nothing.
    const escapeAt = chip.indexOf("e.key === 'Escape'");
    const openGuardAt = chip.indexOf('{open &&');
    expect(escapeAt).toBeGreaterThan(-1);
    expect(openGuardAt).toBeGreaterThan(-1);
    expect(escapeAt, 'Escape handler must sit on the root div, before the {open && panel guard').toBeLessThan(
      openGuardAt,
    );
  });

  it('(d) the two eligibility pickers use the component-owned label prop, NOT a <Field> wrapper', () => {
    // Negative checks scoped to exactly these two captions — the same form legitimately uses <Field>
    // for its other inputs (min service, probation, …).
    expect(panel).not.toContain("<Field label={t('eligibilityGenderLabel')}");
    expect(panel).not.toContain("<Field label={t('eligibilityMaritalLabel')}");
    // Positive checks so the negatives cannot pass vacuously (e.g. by renaming the i18n keys).
    expect(panel).toContain("label={t('eligibilityGenderLabel')}");
    expect(panel).toContain("label={t('eligibilityMaritalLabel')}");
  });

  it("(e) the trigger's aria-labelledby is conditional on the label prop — no empty accessible name at /performance", () => {
    expect(chip).toMatch(/aria-labelledby=\{label != null \? captionId : undefined\}/);
  });
});
