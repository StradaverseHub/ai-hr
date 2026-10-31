import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from 'next-intl';
import { pageState, parsePageQuery } from '../lib/pagination';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) => createTranslator({ locale: 'en', messages: JSON.parse(readFileSync('messages/en.json', 'utf8')), namespace: namespace as never }),
}));
import { Pager } from '../components/pager';

const all = pageState(parsePageQuery({ size: 'all' }), 2001, 2000);
const personalHint = 'Choose a numbered page size to see the remaining credits.';

describe('Personal earned-credit ceiling guidance', () => {
  it('keeps the default Reports guidance for existing callers', async () => {
    const html = renderToStaticMarkup(await Pager({ state: all, basePath: '/admin/example' }));
    expect(html).toContain('Showing the first 2,000 of 2,001 rows.');
    expect(html).toContain('Use Reports → Export for the complete set.');
  });
  it('guides the employee back to numbered pages without claiming access to Reports', async () => {
    const html = renderToStaticMarkup(await Pager({ state: all, basePath: '/leave/credit-details', truncatedHint: personalHint }));
    expect(html).toContain('Showing the first 2,000 of 2,001 rows.');
    expect(html).toContain(personalHint);
    expect(html).not.toContain('Reports');
    expect(html).toContain('value="25"');
    expect(html).toContain('value="200"');
    const page = readFileSync('app/(app)/leave/credit-details/page.tsx', 'utf8');
    expect(page).toContain("truncatedHint={t('truncatedHint')}");
  });
  it('still prefers an actual complete-set export and omits warnings on complete pages', async () => {
    const withExport = renderToStaticMarkup(await Pager({ state: all, basePath: '/admin/example', exportHref: '/admin/example/export', truncatedHint: personalHint }));
    expect(withExport).toContain('href="/admin/example/export"');
    expect(withExport).not.toContain(personalHint);
    const complete = renderToStaticMarkup(await Pager({ state: pageState(parsePageQuery(), 25, 25), basePath: '/leave/credit-details', truncatedHint: personalHint }));
    expect(complete).not.toContain(personalHint);
    expect(complete).not.toContain('Showing the first');
  });
  it('has nonempty employee-specific guidance in all six locales', () => {
    for (const locale of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const messages = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'));
      const translate = createTranslator({ locale, messages, namespace: 'leaveCreditDetails' });
      expect(translate('truncatedHint')).toBe(messages.leaveCreditDetails.truncatedHint);
      expect(messages.leaveCreditDetails.truncatedHint.trim()).not.toBe('');
    }
  });
});
