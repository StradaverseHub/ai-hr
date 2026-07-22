/**
 * Advanced Leave Year Rules dialog (cluster 37088a65) + trigger visibility (e31d2b67).
 *
 * The shared bottom-of-page "Advanced leave year rules" panel is GONE from the Application Rules page;
 * each DRAFT leave-year row now opens its own dialog, pinned to that row's year by a hidden input. The
 * repo has no jsdom/RTL harness (vitest runs node-env DB tests), so this asserts the wiring at source
 * level, in the style of dashboard-save-confirm.test.ts:
 *  - the dialog is a Radix Dialog whose hidden year input comes from the `year` prop with NO fallback
 *    (the wrong-year save risk the old shared dropdown carried);
 *  - the dead `ruleSubmitted` tri-state marker is gone everywhere (the action computes enabled purely
 *    from the `enable` checkbox's presence);
 *  - the page has no advanced disclosure / effective-year select left, and renders the dialog only in
 *    the draft branch (e31d2b67's "visible trigger" is the dialog's Open button on each draft row);
 *  - amount `required` is BOUND TO STATE (an unconditional required would block the disable path);
 *  - locale parity for the removed + added keys across all 6 locales.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const dialog = readFileSync(join(root, 'components/leave/leave-year-rule-dialog.tsx'), 'utf8');
const page = readFileSync(join(root, 'app/admin/leave/application-rules/page.tsx'), 'utf8');
const actions = readFileSync(join(root, 'app/admin/actions.ts'), 'utf8');

describe('leave-year rule dialog (37088a65)', () => {
  it('is a Radix Dialog', () => {
    expect(dialog).toMatch(/@radix-ui\/react-dialog/);
  });

  it('pins the save to the clicked row: hidden year input from the year prop, no fallback anywhere', () => {
    expect(dialog).toContain('<input type="hidden" name="year" value={year} />');
    // No module-level / page-default year computation or fallback in the dialog file.
    expect(dialog).not.toMatch(/defaultNewYear|new Date\(|getUTCFullYear/);
    expect(dialog).not.toMatch(/year\s*\?\?/);
    // And no year dropdown — the year is fixed, not chosen.
    expect(dialog).not.toMatch(/<select[^>]*name="year"/);
  });

  it('the dead ruleSubmitted marker is gone from the dialog, the page and the actions', () => {
    expect(dialog).not.toContain('ruleSubmitted');
    expect(page).not.toContain('ruleSubmitted');
    expect(actions).not.toContain('ruleSubmitted');
  });

  it('the page no longer carries the in-page advanced disclosure or the effective-year select', () => {
    expect(page).not.toContain('effectiveLeaveYearLabel');
    expect(page).not.toContain('<details');
    expect(page).not.toContain('<summary');
  });

  it('the page renders the dialog inside the draft branch only (matching the lifecycle Open button)', () => {
    const draftBranch = page.slice(page.indexOf("cfg.status === 'draft' && ("), page.indexOf("cfg.status === 'open' && ("));
    expect(draftBranch).toContain('LeaveYearRuleDialog');
    // Exactly one render site on the page (the draft branch).
    expect(page.match(/<LeaveYearRuleDialog/g)).toHaveLength(1);
  });

  it('feedback 4f4d9cff — row order: Advance Rules dialog, then Start, then Edit (form-attribute wired), then Delete', () => {
    // The Edit button posts the row's date form from OUTSIDE it via the `form` attribute
    // (same pattern as the per-row edit forms in app/admin/holidays/page.tsx).
    expect(page).toContain('id={`ly-edit-${cfg.year}`}');
    expect(page).toContain('form={`ly-edit-${cfg.year}`}');
    // Within the row block, the render order is: dialog trigger → draft lifecycle (Start) form → Edit → Delete.
    const row = page.slice(page.indexOf('leaveYearConfigs.map((cfg)'), page.indexOf('Create / configure'));
    const dialogIdx = row.indexOf('<LeaveYearRuleDialog');
    const startIdx = row.indexOf('name="status" value="open"');
    const editIdx = row.indexOf('form={`ly-edit-${cfg.year}`}');
    const deleteIdx = row.indexOf('deleteLeaveYearAction');
    expect(dialogIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(dialogIdx);
    expect(editIdx).toBeGreaterThan(startIdx);
    expect(deleteIdx).toBeGreaterThan(editIdx);
  });

  it('amount `required` is bound to the enable checkbox state, never unconditional', () => {
    expect(dialog).toContain('required={enabled}');
    expect(dialog).toMatch(/useState\(current\.openingRuleEnabled\)/);
    // No bare `required` attribute anywhere in the JSX.
    expect(dialog).not.toMatch(/\srequired[\s>]/);
    expect(dialog).not.toContain('required={true}');
  });

  it('reuses existing keys: trigger + title stem, description, computed-date line, cancel/save', () => {
    for (const key of ['leaveYearAdvancedTitle', 'openingRuleHelp', 'openingRuleSummary']) {
      expect(dialog).toContain(`t('${key}'`);
    }
    expect(dialog).toContain("t('cancel')");
    expect(dialog).toContain("t('save')");
  });

  it('locales: effectiveLeaveYearLabel removed and the three new keys present in all 6', () => {
    const localeDir = join(root, 'messages');
    const locales = readdirSync(localeDir).filter((f) => f.endsWith('.json'));
    expect(locales.length).toBe(6);
    for (const file of locales) {
      const leave = JSON.parse(readFileSync(join(localeDir, file), 'utf8')).admin?.leave;
      expect(leave?.effectiveLeaveYearLabel, `${file} still has admin.leave.effectiveLeaveYearLabel`).toBeUndefined();
      for (const key of ['deleteLeaveYearBlockedRequests', 'deleteLeaveYearNotFound', 'leaveYearSavedToast']) {
        expect(leave?.[key], `${file} missing admin.leave.${key}`).toBeTruthy();
        expect(typeof leave[key]).toBe('string');
        expect(leave[key].length).toBeGreaterThan(0);
      }
    }
  });
});
