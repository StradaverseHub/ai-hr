/**
 * 9da61c86 — the SERVER pager renders its new chrome, in every locale.
 *
 * WHY THIS EXISTS SEPARATELY FROM test/client-pager.dom.test.tsx. The product has two renderings of one
 * pager: components/client-pager.tsx draws buttons in the browser (the grids), and components/pager.tsx
 * draws links on the server (the twenty server-rendered lists, including the six this item swept in). Only
 * the client one had a render test. This item added First, Last and a numbered strip to BOTH, and three
 * new message keys with them — and a missing key paints MISSING_MESSAGE while the page still returns 200,
 * passes tsc and passes the suite (standing order 6). So the server half is rendered here too.
 *
 * HOW YOU RENDER AN ASYNC SERVER COMPONENT IN JSDOM: you await it. `Pager` returns JSX once its
 * translations resolve, so the test awaits the call and renders the result. `getTranslations` is stubbed
 * with next-intl's own createTranslator over the real message catalogue — the same ICU formatter the
 * server uses — so an unresolved key throws here exactly as it would log there. `next/link` is stubbed to
 * a plain anchor: outside a Next render there is no router for it to talk to, and what is under test is
 * the pager's markup, not Next's navigation.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { keysetPageState, pageState, parseKeysetPageQuery, parsePageQuery } from '../lib/pagination';
import { resolveUiTheme, type UiTheme } from '../lib/ui-theme';

const current = vi.hoisted(() => ({ locale: 'en', messages: {} as Record<string, unknown>, theme: 'classic' as UiTheme }));
vi.mock('../lib/ui-theme-server', () => ({ currentUiTheme: async () => current.theme }));

vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale: current.locale,
        messages: current.messages,
        namespace,
        // Throwing rather than logging: an unresolved key must fail the test, not paint its own key path.
        onError: (e: unknown) => {
          throw e;
        },
      }),
  };
});

// The rows-per-page control inside the server pager is the one client island in it, and it asks for the
// router the moment it renders. Nothing here clicks it; it only has to mount.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Imported AFTER the mocks so the component picks them up.
const { Pager } = await import('../components/pager');

async function renderPager(locale: string, messages: Record<string, unknown>, page: number, total: number, theme: UiTheme = 'classic', maxPageSize?:number) {
  current.locale = locale;
  current.messages = messages;
  current.theme = theme;
  const q = parsePageQuery({ page: String(page) });
  const shown = Math.max(0, Math.min(25, total - q.offset));
  const el = await Pager({ basePath: '/admin/pay-components', params: { q: 'lee' }, maxPageSize, state: pageState(q, total, shown) });
  return render(el);
}

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

describe('the server pager', () => {
  it('caps rich aggregate choices while preserving the shared pager default sizes',async()=>{
    const first=await renderPager('en',en as unknown as Record<string,unknown>,0,500,'classic',100);
    expect(screen.getAllByRole('option').map(option=>option.getAttribute('value'))).toEqual(['25','50','100']);
    expect(screen.getByText('Next →').closest('a')).toHaveAttribute('href',expect.stringContaining('page=1'));
    first.unmount();
    await renderPager('en',en as unknown as Record<string,unknown>,0,500);
    expect(screen.getAllByRole('option').map(option=>option.getAttribute('value'))).toEqual(['25','50','100','200','all']);
  });

  it('gives independently paged sources distinct labelled size controls',async()=>{
    await renderPager('en',en as unknown as Record<string,unknown>,0,500);
    await renderPager('en',en as unknown as Record<string,unknown>,0,500);
    const controls=screen.getAllByRole('combobox',{name:en.pagination.rowsPerPage});
    expect(controls).toHaveLength(2);expect(controls[0].id).not.toBe(controls[1].id);
  });

  it('offers first / previous / a window of page numbers / next / last', async () => {
    await renderPager('en', en as unknown as Record<string, unknown>, 6, 328);
    expect(screen.getByText('« First')).toBeInTheDocument();
    expect(screen.getByText('Last »')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Page 5' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Page 9' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Page 1' })).not.toBeInTheDocument();
    expect(screen.getByText('7', { selector: '[aria-current="page"]' })).toBeInTheDocument();
    expect(screen.getByText('151–175 of 328')).toBeInTheDocument();
  });

  it('keeps the filters already in the address on every step and every number', async () => {
    await renderPager('en', en as unknown as Record<string, unknown>, 6, 328);
    const last = screen.getByText('Last »').closest('a')!;
    expect(last).toHaveAttribute('href', expect.stringContaining('q=lee'));
    // 328 rows at 25 a page is 14 pages, so the last one is index 13.
    expect(last).toHaveAttribute('href', expect.stringContaining('page=13'));
    expect(screen.getByRole('link', { name: 'Page 5' })).toHaveAttribute(
      'href',
      expect.stringContaining('page=4'),
    );
  });

  // First and Previous are dead on page one, and they render as text rather than links — the same shape
  // the pager has always used for a step you cannot take.
  it('renders the unreachable ends as text, not links', async () => {
    await renderPager('en', en as unknown as Record<string, unknown>, 0, 20);
    for (const label of ['« First', '← Previous', 'Next →', 'Last »']) {
      expect(screen.getByText(label).tagName).toBe('SPAN');
    }
    // One page: the rows-per-page control and the counter still show, the numbers do not.
    expect(screen.getByText('1–20 of 20')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Page / })).not.toBeInTheDocument();
  });

  it.each(LOCALES)('%s resolves every string the bar renders', async (locale, messages) => {
    const { container } = await renderPager(locale, messages as unknown as Record<string, unknown>, 6, 328);
    const bar = screen.getByText('7', { selector: '[aria-current="page"]' }).parentElement!;
    // Four steps and four reachable numbers, whatever the words are.
    expect(within(bar).getAllByRole('link')).toHaveLength(8);
    expect(container.textContent).not.toContain('pagination.');
  });

  it.each(LOCALES)('%s renders compact controls for the default Atelier theme', async (locale, messages) => {
    const { container } = await renderPager(locale, messages as unknown as Record<string, unknown>, 6, 328, resolveUiTheme(undefined));
    const bar = container.querySelector('[data-ui-pager-compact]')!;
    expect(bar).toBeInTheDocument();
    expect(within(bar as HTMLElement).getAllByRole('link')).toHaveLength(2);
    expect(screen.getByRole('link', { name: messages.pagination.previousPage })).toHaveAttribute('href', expect.stringContaining('page=5'));
    expect(screen.getByRole('link', { name: messages.pagination.nextPage })).toHaveAttribute('href', expect.stringContaining('page=7'));
    expect(screen.getByText('151–175 / 328')).toBeInTheDocument();
    expect(bar.querySelector('[aria-current="page"]')).toBeNull();
    expect(container.textContent).not.toContain('pagination.');
  });

  it('disables compact previous/next controls when the default theme has only one page', async () => {
    await renderPager('en', en as unknown as Record<string, unknown>, 0, 20, resolveUiTheme(undefined));
    expect(screen.getByRole('button', { name: en.pagination.previousPage })).toBeDisabled();
    expect(screen.getByRole('button', { name: en.pagination.nextPage })).toBeDisabled();
    expect(screen.getByText('1–20 / 20')).toBeInTheDocument();
  });
});

// ADR 0181 Phase 4 — a keyset list: cursors instead of page numbers, "1,000+" and "Count exactly".
const FIRST_ROW = '0b6f1d1e-3c55-4c6a-9a43-0d2f0c6f1a01';
const LAST_ROW = '7d1e9b2a-5f0c-4e8b-8a7d-2b9c4e1f3a02';
async function renderKeysetPager(locale: string, messages: Record<string, unknown>, sp: Record<string, string>, total: { count: number; capped: boolean }, theme: UiTheme = 'classic') {
  current.locale = locale;
  current.messages = messages;
  current.theme = theme;
  const q = parseKeysetPageQuery(sp);
  const anchored = q.after !== undefined || q.before !== undefined || q.last;
  const state = keysetPageState(q, { total, hasPrev: anchored, hasNext: !q.last, anchorFound: true },
    Array.from({ length: 25 }, (_, i) => (i === 0 ? FIRST_ROW : i === 24 ? LAST_ROW : `row-${i}`)));
  return render(await Pager({ basePath: '/personnel', params: { q: 'lee' }, state }));
}

describe('the server pager on a keyset list', () => {
  it('steps by cursor, offers no numbers, and says "1,000+" with an exact-count action', async () => {
    await renderKeysetPager('en', en as unknown as Record<string, unknown>, { page: '2', after: FIRST_ROW }, { count: 1000, capped: true });
    expect(screen.getByText('51–75 of 1,000+')).toBeInTheDocument();
    const next = screen.getByText('Next →').closest('a')!;
    expect(next.getAttribute('href')).toBe(`/personnel?q=lee&page=3&size=25&after=${LAST_ROW}`);
    const previous = screen.getByText('← Previous').closest('a')!;
    expect(previous.getAttribute('href')).toBe(`/personnel?q=lee&page=1&size=25&before=${FIRST_ROW}`);
    expect(screen.getByText('« First').closest('a')!.getAttribute('href')).toBe('/personnel?q=lee&size=25');
    // Last needs the final page's position, which a capped total does not give.
    expect(screen.getByText('Last »').tagName).toBe('SPAN');
    expect(screen.queryByRole('link', { name: /^Page / })).not.toBeInTheDocument();
    expect(screen.getByText('Count exactly').closest('a')!.getAttribute('href'))
      .toBe(`/personnel?q=lee&page=2&size=25&after=${FIRST_ROW}&count=exact`);
    // No row's name or other value travels in any link: only identifiers and paging words.
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href')).not.toMatch(/name|email|code/i);
  });

  it('keeps "Count exactly" on every step once asked, and offers Last on an exact total', async () => {
    await renderKeysetPager('en', en as unknown as Record<string, unknown>, { page: '1', after: FIRST_ROW, count: 'exact' }, { count: 1234, capped: false });
    expect(screen.getByText('26–50 of 1,234')).toBeInTheDocument();
    expect(screen.queryByText('Count exactly')).not.toBeInTheDocument();
    expect(screen.getByText('Next →').closest('a')!.getAttribute('href')).toContain('count=exact');
    // From page 1 Previous is simply the first page.
    expect(screen.getByText('← Previous').closest('a')!.getAttribute('href')).toBe('/personnel?q=lee&size=25&count=exact');
    expect(screen.getByText('Last »').closest('a')!.getAttribute('href')).toBe('/personnel?q=lee&page=49&size=25&last=1&count=exact');
  });

  it.each(LOCALES)('%s resolves the capped strings in both themes', async (locale, messages) => {
    for (const theme of ['classic', resolveUiTheme(undefined)] as UiTheme[]) {
      const { container, unmount } = await renderKeysetPager(locale, messages as unknown as Record<string, unknown>, { page: '2', after: FIRST_ROW }, { count: 1000, capped: true }, theme);
      expect(container.textContent).not.toContain('pagination.');
      expect(container.querySelector('[data-pager-count-exactly]')).not.toBeNull();
      unmount();
    }
  });
});
