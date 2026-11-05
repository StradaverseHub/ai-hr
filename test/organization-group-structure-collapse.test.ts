import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'app/admin/organization/page.tsx'), 'utf8');

describe('Organization company listing', () => {
  it('leads with Companies and keeps hierarchy data available to company rows', () => {
    expect(page.match(/<Card\b[^>]*>/)?.[0]).toContain('people-org-companies');
    expect(page).toContain('companyTree(s)');
    expect(page).toContain('selectCompanyRows(companies, parentBy');
    expect(page).not.toContain('<CompanyTree');
    expect(page).not.toContain("t('showGroupStructure')");
  });

  it('starts registration details collapsed and offers separate open and close labels', () => {
    const details = page.match(/(<details[^>]*>)([\s\S]*?)<\/details>/);
    expect(details).not.toBeNull();
    expect(details?.[1]).not.toMatch(/\sopen(?:[\s=>])/);
    expect(details?.[2]).toMatch(/<summary\b[\s\S]*?group-open:hidden[\s\S]*?viewDetails[\s\S]*?group-open:inline[\s\S]*?common\('close'\)/);
  });

  it('provides both controls in all six locales', () => {
    for (const locale of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const messages = JSON.parse(fs.readFileSync(path.join(root, 'messages', `${locale}.json`), 'utf8'));
      expect(messages.leave.viewDetails).toBeTruthy();
      expect(messages.common.close).toBeTruthy();
    }
  });
});
