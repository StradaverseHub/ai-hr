/**
 * Edit Leave Year dialog (feedback 7903c197).
 *
 * The Application Rules page used to render each Leave Year row's two control dates as an always-open
 * inline form whose submit button was labelled "Edit" — clicking Edit SAVED immediately and fired the
 * "Leave year saved." toast with no review step. That inline form is GONE: each row now shows its
 * dates read-only next to an Edit button that opens LeaveYearEditDialog, prefilled with the saved
 * dates; upsertLeaveYearConfigAction (and its toast) only fires from the Save button inside the
 * dialog. The repo has no jsdom/RTL harness (vitest runs node-env DB tests), so this asserts the
 * wiring at source level, in the style of leave-year-rule-dialog.test.ts:
 *  - the dialog is a Radix Dialog whose hidden year input comes from the `year` prop with NO
 *    fallback (the year identifies the record and is never chosen inside the dialog);
 *  - the trigger is type="button" — a default-type trigger sitting next to the row's lifecycle and
 *    delete forms would submit one of them, the exact click-Edit-triggers-a-save bug this fixes;
 *  - the date inputs carry no unconditional `required` (blanking a date then saving must clear it —
 *    the action coerces '' to null);
 *  - the page keeps exactly ONE action={upsertLeaveYearConfigAction} form (the bottom create form)
 *    and renders LeaveYearEditDialog exactly once, outside the status branches (Edit is available on
 *    every row whatever its stage);
 *  - locale parity for the one new key across all 6 locales.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const dialog = readFileSync(join(root, 'components/leave/leave-year-edit-dialog.tsx'), 'utf8');
const page = readFileSync(join(root, 'app/admin/leave/application-rules/page.tsx'), 'utf8');

describe('leave-year edit dialog (7903c197)', () => {
  it('is a Radix Dialog', () => {
    expect(dialog).toMatch(/@radix-ui\/react-dialog/);
  });

  it('pins the save to the clicked row: hidden year input from the year prop, no fallback anywhere', () => {
    expect(dialog).toContain('<input type="hidden" name="year" value={year} />');
    // No module-level / page-default year computation or fallback in the dialog file.
    expect(dialog).not.toMatch(/defaultNewYear|new Date\(|getUTCFullYear/);
    expect(dialog).not.toMatch(/year\s*\?\?/);
    // And no year dropdown — the year identifies the record, it is shown but never chosen.
    expect(dialog).not.toMatch(/<select[^>]*name="year"/);
  });

  it('the trigger is an explicit type="button" (it must never submit an adjacent row form)', () => {
    const trigger = dialog.slice(dialog.indexOf('<Dialog.Trigger'), dialog.indexOf('</Dialog.Trigger>'));
    expect(trigger).toContain('type="button"');
  });

  it('date inputs carry no unconditional required — clearing a date to empty must still save', () => {
    expect(dialog).not.toMatch(/\srequired[\s>]/);
    expect(dialog).not.toContain('required={true}');
    expect(dialog).not.toContain('required=""');
  });

  it('dates prefill from the row and blank cleanly (defaultValue with an empty-string fallback)', () => {
    expect(dialog).toContain("defaultValue={current.openLeaveYearDate ?? ''}");
    expect(dialog).toContain("defaultValue={current.employeeApplicationStartDate ?? ''}");
  });

  it('the page keeps exactly one upsert form (the create form) — the inline row form is gone', () => {
    expect(page.match(/action=\{upsertLeaveYearConfigAction\}/g)).toHaveLength(1);
  });

  it('the page renders the dialog exactly once, outside the status branches (Edit on every row)', () => {
    expect(page.match(/<LeaveYearEditDialog/g)).toHaveLength(1);
    // Feedback 4f4d9cff pins the action-group order: the Edit dialog sits AFTER the lifecycle
    // branches (Start / Close / Reopen) and BEFORE Delete — so the render site follows the last
    // status branch. It must NOT be gated on cfg.status itself: no status conditional opens between
    // the closed branch's end and the dialog.
    const editIdx = page.indexOf('<LeaveYearEditDialog');
    const closedIdx = page.indexOf("cfg.status === 'closed' && (");
    expect(closedIdx).toBeGreaterThan(-1);
    expect(editIdx).toBeGreaterThan(closedIdx);
    const closedBranchEnd = page.indexOf(')}', closedIdx);
    expect(page.slice(closedBranchEnd, editIdx)).not.toContain('cfg.status');
  });

  it('uses the new title key plus the reused edit/cancel/save keys', () => {
    expect(dialog).toContain("t('editLeaveYearTitle')");
    expect(dialog).toContain("t('edit')");
    expect(dialog).toContain("t('cancel')");
    expect(dialog).toContain("t('save')");
  });

  it('locales: admin.leave.editLeaveYearTitle present in all 6', () => {
    const localeDir = join(root, 'messages');
    const locales = readdirSync(localeDir).filter((f) => f.endsWith('.json'));
    expect(locales.length).toBe(6);
    for (const file of locales) {
      const leave = JSON.parse(readFileSync(join(localeDir, file), 'utf8')).admin?.leave;
      expect(leave?.editLeaveYearTitle, `${file} missing admin.leave.editLeaveYearTitle`).toBeTruthy();
      expect(typeof leave.editLeaveYearTitle).toBe('string');
      expect(leave.editLeaveYearTitle.length).toBeGreaterThan(0);
    }
  });
});
