import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 390f6363: the Payroll tab of the company panel must no longer render the
// payroll-cycle cross-link (it duplicated navigation to /admin/payroll-cycle,
// which owns its own nav entry). This is a UI-only removal — assert on source.
const src = readFileSync(
  join(__dirname, '..', 'components', 'company-panel.tsx'),
  'utf8',
);

describe('company-panel Payroll tab — payroll-cycle cross-link removed', () => {
  it('no longer references the payroll-cycle cross-link i18n keys', () => {
    expect(src).not.toContain('payrollCycleCrossLink');
  });

  it('no longer links to the /admin/payroll-cycle page from the panel', () => {
    expect(src).not.toContain('/admin/payroll-cycle');
  });

  it('keeps the CrossLinkTab helper definition (used by other tabs)', () => {
    expect(src).toContain('function CrossLinkTab(');
  });

  it('retains the statutory identity + bank disbursement payroll forms', () => {
    // statutory identity form fields
    expect(src).toContain("t('bankProfileSave')");
    expect(src).toContain("t('bankProfilesHint')");
    // the Payroll tab container still closes correctly
    expect(src).toContain('{/* end Payroll tab */}');
  });
});
