import { describe, expect, it } from 'vitest';
import { approvalsReturnUrl } from '@/lib/approvals-categories';
import { exportFilename } from '@/lib/export-download';
import { navigationKind } from '@/lib/navigation-feedback';

describe('Atelier action feedback contracts', () => {
  it('keeps URL cleanup and hash changes out of the navigation progress line', () => {
    const current = new URL('https://hr.example/approvals?sort=newest&toast=Done&approvalSeal=1');
    expect(navigationKind(current, new URL('?sort=newest#leave', current))).toBeNull();
    expect(navigationKind(current, new URL('?sort=oldest', current))).toBe('filter');
    expect(navigationKind(current, new URL('/reports', current))).toBe('navigate');
  });

  it('keeps the filter context and requires a success message to carry an approval seal', () => {
    expect(approvalsReturnUrl({ category: 'leave', toast: 'Approved', approvalSeal: true }))
      .toBe('/approvals?category=leave&toast=Approved&approvalSeal=1');
    expect(approvalsReturnUrl({ error: 'Unavailable', approvalSeal: true }))
      .toBe('/approvals?error=Unavailable');
  });

  it('keeps UTF-8 export filenames and refuses responses without an attachment', () => {
    expect(exportFilename("attachment; filename=\"report.xlsx\"; filename*=UTF-8''R%C3%A9sum%C3%A9.xlsx"))
      .toBe('Résumé.xlsx');
    expect(exportFilename('attachment; filename="monthly report.csv"')).toBe('monthly report.csv');
    expect(exportFilename('inline; filename="sign-in.html"')).toBeNull();
    expect(exportFilename(null)).toBeNull();
  });
});
