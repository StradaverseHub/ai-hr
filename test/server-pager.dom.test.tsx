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

import { pageState, parsePageQuery } from '../lib/pagination';

const current = vi.hoisted(() => ({ locale: 'en', messages: {} as Record<string, unknown> }));

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

async function renderPager(locale: string, messages: Record<string, unknown>, page: number, total: number) {
  current.locale = locale;
  current.messages = messages;
  const q = parsePageQuery({ page: String(page) });
  const shown = Math.max(0, Math.min(25, total - q.offset));
  const el = await Pager({ basePath: '/admin/pay-components', params: { q: 'lee' }, state: pageState(q, total, shown) });
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
});
