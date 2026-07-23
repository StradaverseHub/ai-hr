/**
 * Add Leave Type form layout — the modal two-column grid (feedback 750732c3 → a9c5870a → 8cc268c4).
 *
 * History: 750732c3 widened Description to 3 of the 6 equal sm+ columns; a9c5870a healed the resulting orphan
 * second row with an explicit one-row lg grid-template. 8cc268c4 then moved the form off the page entirely —
 * it now renders ONLY inside the workspace's "Add Leave Type" pop-up (components/leave-type-workspace.tsx),
 * so the page-row concerns (six sm columns, the one-row lg template, the right-pinned Add button) are
 * superseded by a modal-width layout:
 *   - mobile: grid-cols-1 stacks everything full-width, unchanged
 *   - sm+: two equal columns — Code/Name share a row, Description spans the full modal width
 *     (sm:col-span-2), Status/Leave Unit share a row, then Paid
 *   - the footer is the standard bottom-right modal pair: Cancel (AddLeaveTypeCancel → Dialog.Close) then
 *     Save (btnPrimary submit) in a col-span-full flex justify-end row.
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

describe('8cc268c4 · Add Leave Type form layout — modal two-column grid with Cancel/Save footer', () => {
  const form = createForm();

  it('keeps the responsive grid container: mobile stack, two sm+ columns, no page-row chrome', () => {
    // className may sit on a following line inside the <form ...> tag; check the pre-first-Field region.
    const attrsRegion = form.slice(0, form.indexOf('<Field'));
    const classMatch = attrsRegion.match(/className="([^"]*)"/);
    expect(classMatch, 'form container className present').not.toBeNull();
    const containerClass = classMatch![1];
    expect(containerClass).toMatch(/\bgrid\b/);
    // grid-cols-1 is the mobile-stack promise — on a phone the boxes stack one per line exactly as before.
    expect(containerClass).toMatch(/\bgrid-cols-1\b/);
    // sm+ is the modal-width two-column layout the 8cc268c4 build note prescribes for the dialog.
    expect(containerClass).toMatch(/sm:grid-cols-2/);
    expect(containerClass).toMatch(/\bitems-end\b/);
    expect(containerClass).toMatch(/\bgap-3\b/);
    // The old page-row chrome (top border + p-4 gutters) is gone — the dialog shell provides the padding.
    expect(containerClass).not.toMatch(/border-t/);
    // …and so is the a9c5870a page-only one-row lg template.
    expect(containerClass).not.toMatch(/lg:\[grid-template-columns/);
  });

  it('spans Description across the full modal width', () => {
    const descLabelIdx = form.indexOf("t('descriptionLabel')");
    expect(descLabelIdx).toBeGreaterThan(-1);
    const fieldTagStart = form.lastIndexOf('<Field', descLabelIdx);
    expect(fieldTagStart).toBeGreaterThan(-1);
    const fieldTag = form.slice(fieldTagStart, form.indexOf('>', fieldTagStart));
    expect(fieldTag).toMatch(/sm:col-span-2/);
  });

  it('keeps the Description textarea multiline, fluid and vertically resizable, trimmed to two rows (fbcadc71)', () => {
    const taStart = form.indexOf('name="description"');
    expect(taStart).toBeGreaterThan(-1);
    const taBlock = form.slice(taStart, form.indexOf('/>', taStart) + 2);
    // rows={2} + trimmed min-h keep the modal compact; long text still scrolls inside and the resize-y drag
    // handle still grows the box on demand.
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

  it('follows with Leave Unit then Paid, then the bottom-right Cancel/Save footer (8cc268c4)', () => {
    // Source order is the dc3ec3c6-pinned Leave Unit → Paid (see test/leave-type-add-field-order.test.ts).
    const unitIdx = form.indexOf('name="leaveUnit"');
    const paidIdx = form.indexOf('name="paid"');
    expect(unitIdx).toBeGreaterThan(-1);
    expect(paidIdx).toBeGreaterThan(unitIdx);
    // Footer: a full-width right-aligned row — Cancel (the workspace-exported Dialog.Close wrapper) BEFORE
    // the primary Save submit, the standard modal button order.
    const footerIdx = form.indexOf('col-span-full', paidIdx);
    expect(footerIdx).toBeGreaterThan(paidIdx);
    const footer = form.slice(footerIdx, form.indexOf('</div>', footerIdx));
    expect(footer).toMatch(/flex justify-end gap-2/);
    const cancelIdx = form.indexOf('<AddLeaveTypeCancel>', footerIdx);
    const saveIdx = form.indexOf('<button', footerIdx);
    expect(cancelIdx).toBeGreaterThan(footerIdx);
    expect(saveIdx).toBeGreaterThan(cancelIdx);
    const buttonTag = form.slice(saveIdx, form.indexOf('>', saveIdx));
    expect(buttonTag).toMatch(/btnPrimary/);
    // The Save label is the modal-standard t('save') — the trigger button outside carries t('addType').
    expect(form.slice(saveIdx)).toContain("{t('save')}");
  });

  it('keeps every posted field name — validations and data-saving behaviour unchanged', () => {
    for (const name of ['code', 'name', 'description', 'active', 'paid', 'leaveUnit']) {
      expect(form).toContain(`name="${name}"`);
    }
  });
});
