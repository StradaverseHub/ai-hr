/**
 * Feedback 8bf6dfa1 — Import Payroll History entry point relocated from the /payroll list header
 * (operational surface) into the Payroll > Transactions hub (admin data-maintenance grouping).
 *
 * The import feature itself (upload/validation/admin gating/audit event) is untouched — this guards
 * the NAVIGATION contract only, in the same DB-free static-source style as personnel-links.test.ts:
 *   1. the /payroll list header no longer links to the import,
 *   2. the Transactions hub is the (only) entry point,
 *   3. the import page's back link follows the user back to the hub,
 *   4. admin gating holds at both the hub and the destination.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

describe('Import Payroll History relocation (feedback 8bf6dfa1)', () => {
  it('the /payroll list header no longer links to /payroll/history-import', () => {
    const src = read('app/payroll/page.tsx');
    expect(src.includes("'/payroll/history-import'")).toBe(false);
    expect(src.includes('"/payroll/history-import"')).toBe(false);
  });

  it('the Transactions hub renders a card linking to /payroll/history-import', () => {
    const src = read('app/payroll/transactions/page.tsx');
    expect(src.includes('/payroll/history-import')).toBe(true);
    expect(src.includes("t('hub.importHistoryTitle')")).toBe(true);
  });

  it('the import page back link returns to the Transactions hub', () => {
    const src = read('app/payroll/history-import/page.tsx');
    expect(src.includes("'/payroll/transactions'")).toBe(true);
  });

  it('admin gating holds at both the hub and the import page', () => {
    expect(read('app/payroll/transactions/page.tsx').includes('requireAdmin')).toBe(true);
    expect(read('app/payroll/history-import/page.tsx').includes('requireAdmin')).toBe(true);
  });
});
