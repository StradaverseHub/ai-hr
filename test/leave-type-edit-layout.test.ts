/**
 * Reorganize Leave Type Edit Form Layout (feedback 6ef6e355).
 *
 * Reported defect: the leave-type identity edit form laid every field out in a single `flex flex-wrap` row
 * with fixed pixel widths, so the Paid checkbox sat squeezed between text inputs, the Description box looked
 * oversized, and fields compressed instead of wrapping cleanly.
 *
 * The fix is a pure Tailwind re-layout of the identity edit sub-form into a responsive grid:
 *   - container: grid, 1 col → 3 (lg) since 73cbffa1 (was 1 → 2 sm → 4 lg)
 *   - every field input goes w-full (no fixed w-40 / w-52 / w-64)
 *   - Description spans the full row and flows fluid (col-span-full + w-full, keeps resize-y)
 *   - Leave Unit and Paid sit in adjacent cells of their own row (13ec5d3b; regridded by 73cbffa1) so Paid sits immediately beside the
 *     unit select instead of wrapping onto an orphaned row
 *   - Save/Cancel live in their own full-width cell
 *
 * No field, name attr, marker, server action or substrate changed — so this guards the layout invariants
 * statically (the repo convention for this UI-only component; see leave-type-edit-code-field.test.ts).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. `components/leave-type-panel.tsx` (3,367 lines)
 * was DELETED with the page that mounted it: the four steps and six sub-steps it carried are the FIVE
 * TABS of `/admin/leave-config/types` (IA §2), which is what this whole item was raised about. The panel
 * became three files, so what this guard scans is their concatenation — the property it pins is about the
 * leave TYPE screen, not about one filename, and pinning it to a file that no longer exists would have
 * taken the guard out rather than moved it.
 */
const LEAVE_TYPE_SCREEN = [
  'app/admin/leave-config/types/page.tsx',
  'app/admin/leave-config/types/leave-type-tabs.tsx',
  'app/admin/leave-config/types/leave-type-sub-forms.tsx',
];
const panelSrc = LEAVE_TYPE_SCREEN.map((f) => readFileSync(resolve(here, '..', f), 'utf8')).join('\n');

/** Isolate the identity edit <form> (keyed by the `identity` marker input). */
function identityForm(): string {
  const marker = panelSrc.indexOf('name="identity"');
  expect(marker).toBeGreaterThan(-1);
  // The <form ...> opening tag starts before the marker.
  const formStart = panelSrc.lastIndexOf('<form', marker);
  const formEnd = panelSrc.indexOf('</form>', marker);
  expect(formStart).toBeGreaterThan(-1);
  expect(formEnd).toBeGreaterThan(formStart);
  return panelSrc.slice(formStart, formEnd + '</form>'.length);
}

describe('Leave Type edit form layout (6ef6e355) — responsive grid', () => {
  const form = identityForm();

  it('uses a responsive grid container, not the old flex-wrap row', () => {
    // Container className lives on the opening <form ...> tag (before the first field).
    const openTagEnd = form.indexOf('>');
    const openTag = form.slice(0, openTagEnd);
    // The className with grid classes may sit on a following line inside the tag; search the tag+attrs region.
    const attrsRegion = form.slice(0, form.indexOf('<input'));
    // Pull the actual container className value (ignore the explanatory comment which cites the old layout).
    const classMatch = attrsRegion.match(/className="([^"]*)"/);
    expect(classMatch, 'form container className present').not.toBeNull();
    const containerClass = classMatch![1];
    expect(containerClass).toMatch(/\bgrid\b/);
    // 73cbffa1 — 1 column below lg, 3 at lg: Code · Icon · Colour / Name · Reason / Leave Unit · Paid.
    expect(containerClass).toMatch(/grid-cols-1/);
    expect(containerClass).toMatch(/lg:grid-cols-3/);
    expect(containerClass).toMatch(/items-start/);
    // The old squeezed layout must be gone from the actual classes.
    expect(containerClass).not.toMatch(/flex-wrap/);
    // Guard we actually looked at the form open tag.
    expect(openTag).toContain('action={updateTypeAction}');
  });

  it('gives every field input a fluid width — no fixed w-40 / w-52 / w-64 remain', () => {
    expect(form).not.toMatch(/\bw-40\b/);
    expect(form).not.toMatch(/\bw-52\b/);
    expect(form).not.toMatch(/\bw-64\b/);
    // Name + reason inputs are fluid.
    expect(form).toMatch(/name="name"[\s\S]*?w-full/);
    expect(form).toMatch(/name="reason"[\s\S]*?w-full/);
  });

  it('makes Description span the full row and flow fluid, keeping the vertical resize handle', () => {
    // The Description Field wrapper carries col-span-full.
    const descLabelIdx = form.indexOf("t('descriptionLabel')");
    expect(descLabelIdx).toBeGreaterThan(-1);
    // Its enclosing <Field ...> opening tag should have col-span-full.
    const fieldTagStart = form.lastIndexOf('<Field', descLabelIdx);
    const fieldTag = form.slice(fieldTagStart, form.indexOf('>', fieldTagStart));
    expect(fieldTag).toMatch(/col-span-full/);
    // The textarea itself is fluid + resizable.
    const ta = form.slice(form.indexOf('<textarea'), form.indexOf('</textarea') + 1 || form.indexOf('/>', form.indexOf('<textarea')) + 2);
    const taBlock = form.slice(form.indexOf('name="description"'), form.indexOf('/>', form.indexOf('name="description"')) + 2);
    expect(taBlock).toMatch(/w-full/);
    expect(taBlock).toMatch(/resize-y/);
    void ta;
  });

  it('keeps Paid immediately beside Leave Unit on its own row (13ec5d3b, 73cbffa1)', () => {
    // 13ec5d3b's point was that Paid must not be orphaned or squeezed between text inputs. 73cbffa1's
    // 3-column grid gives Leave Unit and Paid adjacent cells of their own row (Leave Unit starts the row).
    const unitLabelIdx = form.indexOf("t('leaveUnitLabel')");
    const paidLabelIdx = form.indexOf("t('paidLabel')");
    const descLabelIdx = form.indexOf("t('descriptionLabel')");
    expect(unitLabelIdx).toBeGreaterThan(-1);
    expect(paidLabelIdx).toBeGreaterThan(-1);
    expect(descLabelIdx).toBeGreaterThan(-1);
    const unitFieldStart = form.lastIndexOf('<Field', unitLabelIdx);
    const unitFieldTag = form.slice(unitFieldStart, form.indexOf('>', unitFieldStart));
    expect(unitFieldTag).toMatch(/lg:col-start-1/);
    // No other field between Leave Unit and Paid.
    const between = form.slice(unitLabelIdx, paidLabelIdx);
    expect(between.match(/<Field/g)?.length ?? 0).toBe(1);
    expect(unitLabelIdx).toBeLessThan(paidLabelIdx);
    expect(paidLabelIdx).toBeLessThan(descLabelIdx);
    const paidFieldStart = form.lastIndexOf('<Field', paidLabelIdx);
    const paidFieldTag = form.slice(paidFieldStart, form.indexOf('>', paidFieldStart));
    expect(paidFieldTag).not.toMatch(/justify-self-end/);
    expect(form.indexOf("t('nameLabel')")).toBeLessThan(paidLabelIdx);
    expect(form.indexOf("t('reasonLabel')")).toBeLessThan(paidLabelIdx);
    const paidBlock = form.slice(form.indexOf('type="checkbox"'), form.indexOf('/>', form.indexOf('type="checkbox"')) + 2);
    expect(paidBlock).toMatch(/name="paid"/);
    expect(paidBlock).toMatch(/defaultChecked=\{paid\}/);
  });

  it('keeps Save/Discard together in their own full-width cell', () => {
    // The actions live in a col-span-full flex wrapper containing both buttons. editablecode/a7194511
    // relabelled the outer Cancel button to Discard changes (the Save confirmation dialog now owns Cancel).
    const saveIdx = form.indexOf("t('save')");
    const discardIdx = form.indexOf("t('discardChanges')");
    expect(saveIdx).toBeGreaterThan(-1);
    expect(discardIdx).toBeGreaterThan(saveIdx);
    // Their shared wrapper <div ...> just before Save has col-span-full.
    const wrapStart = form.lastIndexOf('<div', saveIdx);
    const wrapTag = form.slice(wrapStart, form.indexOf('>', wrapStart));
    expect(wrapTag).toMatch(/col-span-full/);
    expect(wrapTag).toMatch(/flex/);
  });

  it('preserves prior chain work: Code stays surfaced (read-only for statutory, editable for custom)', () => {
    // editcode/37a49524 invariant — a statutory Code field is present, read-only, no name attr…
    expect(form).toMatch(/value=\{code\}/);
    const codeBlock = form.slice(form.indexOf('value={code}') - 60, form.indexOf('/>', form.indexOf('value={code}')) + 2);
    expect(codeBlock).toMatch(/readOnly/);
    expect(codeBlock).not.toMatch(/\sname=/);
    // …and editablecode/a7194511 adds the editable branch (defaultValue + name="code") for custom types.
    expect(form).toMatch(/name="code"/);
    expect(form).toMatch(/defaultValue=\{code\}/);
  });
});
