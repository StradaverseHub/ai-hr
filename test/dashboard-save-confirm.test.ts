/**
 * Feedback 31b46dcc — "Dashboard Customization - Save Changes Confirmation Popup".
 *
 * The R39 dashboard customizer's Save Changes now goes through a Radix AlertDialog confirmation:
 *  - the real save() only fires from AlertDialog.Action (Confirm Save), never on the trigger click
 *  - AlertDialog.Cancel (Discard Changes) reverts via the existing cancel() (baseline + exit customize)
 *  - the confirmation title/labels are i18n keys present across all 6 locales
 *
 * The repo has no jsdom/RTL harness (vitest runs node-env DB tests), so this asserts the wiring at
 * source level (the same style as dashboard-onboarding-removal.test.ts) plus full i18n coverage.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const customizer = readFileSync(join(root, 'components/dashboard-customizer.tsx'), 'utf8');

describe('dashboard save-confirm dialog (31b46dcc)', () => {
  it('imports the Radix AlertDialog', () => {
    expect(customizer).toMatch(/@radix-ui\/react-alert-dialog/);
  });

  it('gates Save behind the dialog: the Save Changes trigger no longer calls save() directly', () => {
    // The trigger button must NOT have an onClick={save}. Locate the trigger's Save button.
    const triggerBlock = customizer.slice(
      customizer.indexOf('AlertDialog.Trigger'),
      customizer.indexOf('AlertDialog.Portal'),
    );
    expect(triggerBlock).toMatch(/saveChanges/);
    expect(triggerBlock).not.toMatch(/onClick=\{save\}/);
  });

  it('Confirm Save (AlertDialog.Action) calls the real save() handler', () => {
    const actionBlock = customizer.slice(
      customizer.indexOf('AlertDialog.Action'),
      customizer.indexOf('</AlertDialog.Action>'),
    );
    expect(actionBlock).toMatch(/onClick=\{save\}/);
    expect(actionBlock).toMatch(/saveConfirmConfirm/);
  });

  it('Discard Changes (AlertDialog.Cancel) reverts via the existing cancel() handler', () => {
    const cancelBlock = customizer.slice(
      customizer.indexOf('AlertDialog.Cancel'),
      customizer.indexOf('</AlertDialog.Cancel>'),
    );
    expect(cancelBlock).toMatch(/onClick=\{cancel\}/);
    expect(cancelBlock).toMatch(/saveConfirmDiscard/);
  });

  it('the confirm title uses the saveConfirmTitle key', () => {
    expect(customizer).toMatch(/t\('saveConfirmTitle'\)/);
  });

  it('save() still keeps startTransition + saveAction + setBaseline + setCustomizing intact', () => {
    const save = customizer.slice(customizer.indexOf('const save ='), customizer.indexOf('const reset ='));
    expect(save).toMatch(/startTransition/);
    // 578a2fcf: the save payload widened from an order array to { selected, order }.
    expect(save).toMatch(/await saveAction\(\{ selected: next, order: next \}\)/);
    expect(save).toMatch(/setBaseline\(next\)/);
    expect(save).toMatch(/setCustomizing\(false\)/);
  });

  it('all three confirm keys exist in every locale', () => {
    const localeDir = join(root, 'messages');
    const locales = readdirSync(localeDir).filter((f) => f.endsWith('.json'));
    expect(locales.length).toBe(6);
    for (const file of locales) {
      const dash = JSON.parse(readFileSync(join(localeDir, file), 'utf8')).dashboard;
      for (const key of ['saveConfirmTitle', 'saveConfirmConfirm', 'saveConfirmDiscard']) {
        expect(dash?.[key], `${file} missing dashboard.${key}`).toBeTruthy();
        expect(typeof dash[key]).toBe('string');
        expect(dash[key].length).toBeGreaterThan(0);
      }
    }
  });
});
