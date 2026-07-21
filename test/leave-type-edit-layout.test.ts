/**
 * Reorganize Leave Type Edit Form Layout (feedback 6ef6e355).
 *
 * Reported defect: the leave-type identity edit form laid every field out in a single `flex flex-wrap` row
 * with fixed pixel widths, so the Paid checkbox sat squeezed between text inputs, the Description box looked
 * oversized, and fields compressed instead of wrapping cleanly.
 *
 * The fix is a pure Tailwind re-layout of the identity edit sub-form into a responsive grid:
 *   - container: grid, 1 col → 2 (sm) → 4 (lg)
 *   - every field input goes w-full (no fixed w-40 / w-52 / w-64)
 *   - Description spans the full row and flows fluid (col-span-full + w-full, keeps resize-y)
 *   - Leave Unit and Paid share ONE grid cell (a flex row, 13ec5d3b) so Paid sits immediately beside the
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
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');

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
    expect(containerClass).toMatch(/sm:grid-cols-2/);
    expect(containerClass).toMatch(/lg:grid-cols-4/);
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

  it('keeps Leave Unit and Paid together in one cell (13ec5d3b)', () => {
    const unitLabelIdx = form.indexOf("t('leaveUnitLabel')");
    const paidLabelIdx = form.indexOf("t('paidLabel')");
    const descLabelIdx = form.indexOf("t('descriptionLabel')");
    expect(unitLabelIdx).toBeGreaterThan(-1);
    expect(paidLabelIdx).toBeGreaterThan(-1);
    expect(descLabelIdx).toBeGreaterThan(-1);
    // The shared-cell wrapper is the flex div immediately preceding the Leave Unit Field. Anchor/order-based
    // on purpose: the Paid Field nests its own inner div, so slicing wrapper-open → first </div> would cut
    // BEFORE t('paidLabel') and silently weaken the assertion.
    const wrapperOpen = form.lastIndexOf('<div', unitLabelIdx);
    expect(wrapperOpen).toBeGreaterThan(-1);
    const wrapperTag = form.slice(wrapperOpen, form.indexOf('>', wrapperOpen));
    // A flex row with a gap; items-end vs items-start is a visual equivalence we deliberately do not pin.
    expect(wrapperTag).toMatch(/\bflex\b/);
    expect(wrapperTag).toMatch(/gap-/);
    // Order: wrapper opens, then Leave Unit, then Paid — both before Description, i.e. inside the same cell.
    expect(wrapperOpen).toBeLessThan(unitLabelIdx);
    expect(unitLabelIdx).toBeLessThan(paidLabelIdx);
    expect(paidLabelIdx).toBeLessThan(descLabelIdx);
    // The old far-right push is gone from the Paid Field tag.
    const paidFieldStart = form.lastIndexOf('<Field', paidLabelIdx);
    const paidFieldTag = form.slice(paidFieldStart, form.indexOf('>', paidFieldStart));
    expect(paidFieldTag).not.toMatch(/justify-self-end/);
    // Paid must come AFTER the compact text inputs (name, reason) so it is not squeezed between them.
    expect(form.indexOf("t('nameLabel')")).toBeLessThan(paidLabelIdx);
    expect(form.indexOf("t('reasonLabel')")).toBeLessThan(paidLabelIdx);
    // The Paid checkbox is still the same posted field.
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
