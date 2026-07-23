/**
 * Add Leave Type form layout — wide Description WITHOUT the orphan second row (feedback 750732c3 → a9c5870a).
 *
 * History: 750732c3 widened Description to 3 of the 6 equal sm+ columns, which pushed Leave Unit, Paid and the
 * Add button onto a second, mostly-empty row at every width. Feedback a9c5870a asked for the row to heal: keep
 * the wide Description but let all seven pieces share ONE row when the screen is wide enough.
 *
 * The fix is UI-only, three tiers on the same grid container (app/admin/leave/entitlements/page.tsx):
 *   - mobile: grid-cols-1 stacks everything full-width, unchanged
 *   - sm–lg: the original six equal columns with Description sm:col-span-3 — the tidy two-row split, with the
 *     Add button pinned right via sm:col-start-6
 *   - lg+: an explicit grid-template packs one row of seven columns — Code, Name, Description (wide 3fr),
 *     Status and Leave Unit as flexible minmax columns; Paid and Add as content-sized auto columns, so no dead
 *     space. Description resets its span (lg:col-span-1) and the button releases its pin (lg:col-start-auto).
 *   - the textarea drops to rows={2} with a trimmed min-h so the single row sits visually balanced.
 *
 * No field, name attr, server action or substrate changed — so this guards the layout invariants statically
 * (the repo convention for UI-only changes in this feature area; see test/leave-type-edit-layout.test.ts,
 * whose form-slicing helper this file mirrors).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');

/** The exact lg template: five flexible text-field columns (Description the wide 3fr one) + two content-sized
 *  auto columns for Paid and the Add button. Asserted verbatim — the column recipe IS the fix. */
const LG_TEMPLATE =
  'lg:[grid-template-columns:minmax(6.5rem,1fr)_minmax(8rem,1fr)_minmax(16rem,3fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_auto_auto]';

/** Isolate the create-leave-type <form> with an ANCHORED slice (keyed by its action). The page contains other
 *  forms — an unanchored lastIndexOf('<form') would grab the later setCompanyLeaveCycleAction form — so the
 *  slice anchors on the action marker first, exactly like leave-type-edit-layout.test.ts. */
function createForm(): string {
  const marker = pageSrc.indexOf('action={createLeaveTypeAction}');
  expect(marker).toBeGreaterThan(-1);
  const formStart = pageSrc.lastIndexOf('<form', marker);
  const formEnd = pageSrc.indexOf('</form>', marker);
  expect(formStart).toBeGreaterThan(-1);
  expect(formEnd).toBeGreaterThan(formStart);
  return pageSrc.slice(formStart, formEnd + '</form>'.length);
}

describe('a9c5870a · Add Leave Type form layout — single lg row, wide Description, no dead space', () => {
  const form = createForm();

  it('keeps the responsive grid container: mobile stack, six sm columns, explicit seven-column lg template', () => {
    // className may sit on a following line inside the <form ...> tag; check the pre-first-Field region.
    const attrsRegion = form.slice(0, form.indexOf('<Field'));
    const classMatch = attrsRegion.match(/className="([^"]*)"/);
    expect(classMatch, 'form container className present').not.toBeNull();
    const containerClass = classMatch![1];
    expect(containerClass).toMatch(/\bgrid\b/);
    // grid-cols-1 is the mobile-stack promise — on a phone the boxes stack one per line exactly as before.
    expect(containerClass).toMatch(/\bgrid-cols-1\b/);
    // sm–lg keeps the sane two-row split 750732c3 shipped.
    expect(containerClass).toMatch(/sm:grid-cols-6/);
    // lg+ packs everything onto one row: flexible text columns, auto Paid + Add — the a9c5870a fix itself.
    expect(containerClass).toContain(LG_TEMPLATE);
    expect(containerClass).toMatch(/\bitems-end\b/);
    expect(containerClass).toMatch(/\bgap-3\b/);
  });

  it('gives Description 3 of 6 columns at sm and resets the span at lg to sit in the wide 3fr slot', () => {
    const descLabelIdx = form.indexOf("t('descriptionLabel')");
    expect(descLabelIdx).toBeGreaterThan(-1);
    const fieldTagStart = form.lastIndexOf('<Field', descLabelIdx);
    expect(fieldTagStart).toBeGreaterThan(-1);
    const fieldTag = form.slice(fieldTagStart, form.indexOf('>', fieldTagStart));
    expect(fieldTag).toMatch(/sm:col-span-3/);
    // With the explicit lg template, a 3-column span would swallow Status and Leave Unit's tracks — the span
    // MUST reset so Description occupies exactly the minmax(16rem,3fr) column.
    expect(fieldTag).toMatch(/lg:col-span-1/);
  });

  it('keeps the Description textarea multiline, fluid and vertically resizable, trimmed to two rows (fbcadc71 → a9c5870a)', () => {
    const taStart = form.indexOf('name="description"');
    expect(taStart).toBeGreaterThan(-1);
    const taBlock = form.slice(taStart, form.indexOf('/>', taStart) + 2);
    // rows={2} + trimmed min-h keep the single lg row visually balanced next to the h-9 neighbours; long text
    // still scrolls inside and the resize-y drag handle still grows the box on demand.
    expect(taBlock).toMatch(/rows=\{2\}/);
    expect(taBlock).toMatch(/min-h-\[3\.25rem\]/);
    expect(taBlock).toMatch(/resize-y/);
    // inputCls contains w-full, so the textarea fills the wide cell automatically.
    expect(taBlock).toMatch(/inputCls/);
  });

  it('keeps the field order: Code, Name, the wide Description, then Status', () => {
    const codeIdx = form.indexOf('name="code"');
    const nameIdx = form.indexOf('name="name"');
    const descIdx = form.indexOf('name="description"');
    const statusIdx = form.indexOf('name="active"');
    expect(codeIdx).toBeGreaterThan(-1);
    expect(nameIdx).toBeGreaterThan(codeIdx);
    expect(descIdx).toBeGreaterThan(nameIdx);
    expect(statusIdx).toBeGreaterThan(descIdx);
    // Status is the select posting name="active".
    const statusBlock = form.slice(form.lastIndexOf('<select', statusIdx), form.indexOf('</select>', statusIdx));
    expect(statusBlock).toContain('name="active"');
  });

  it('follows with Leave Unit then Paid, right-anchors Add at sm and releases the pin at lg', () => {
    // Source order is the dc3ec3c6-pinned Leave Unit → Paid (see test/leave-type-add-field-order.test.ts).
    const unitIdx = form.indexOf('name="leaveUnit"');
    const paidIdx = form.indexOf('name="paid"');
    const buttonIdx = form.indexOf('<button');
    expect(unitIdx).toBeGreaterThan(-1);
    expect(paidIdx).toBeGreaterThan(unitIdx);
    expect(buttonIdx).toBeGreaterThan(paidIdx);
    const buttonTag = form.slice(buttonIdx, form.indexOf('>', buttonIdx));
    expect(buttonTag).toMatch(/btnPrimary/);
    // sm two-row split: Add stays pinned under Status at the row's right edge (the 750732c3 tidy-second-row
    // promise). lg single row: the pin MUST release or Add would jump to a phantom column 6 of the 7-column
    // template instead of flowing into its own auto column at the end.
    expect(buttonTag).toMatch(/sm:col-start-6/);
    expect(buttonTag).toMatch(/lg:col-start-auto/);
  });

  it('keeps every posted field name — validations and data-saving behaviour unchanged', () => {
    for (const name of ['code', 'name', 'description', 'active', 'paid', 'leaveUnit']) {
      expect(form).toContain(`name="${name}"`);
    }
  });
});
