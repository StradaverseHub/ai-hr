/**
 * Atelier's compact control-panel pager (components/client-pager.tsx, components/pager.tsx): rows-per-page,
 * "26–50 / 120", and one ‹ › pair. The classic layout is pinned by test/client-pager.dom.test.tsx; this pins
 * the compact one, which those tests never render. jsdom applies no CSS, so this covers markup and
 * interaction only — the placement on the filter row is app/atelier.css and is checked by a render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { pageState, parsePageQuery } from '../lib/pagination';
import { ClientPager } from '../components/client-pager';
import { UiThemeProvider } from '../components/ui-theme-context';

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));

function renderPager(total: number, shown: number, sp = '') {
  search = sp;
  replace.mockClear();
  const state = pageState(parsePageQuery(Object.fromEntries(new URLSearchParams(sp))), total, shown);
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <UiThemeProvider theme="atelier">
        <ClientPager state={state} />
      </UiThemeProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => document.documentElement.setAttribute('data-ui-theme', 'atelier'));
afterEach(() => document.documentElement.removeAttribute('data-ui-theme'));

describe('Atelier compact pager', () => {
  it('renders the compact layout, not the classic one', () => {
    const { container } = renderPager(120, 25, 'page=1');
    expect(container.querySelector('[data-ui-pager-compact]')).not.toBeNull();
    expect(screen.getByText('26–50 / 120')).toBeInTheDocument();
    // The classic strip's First/Last are not offered here.
    expect(screen.queryByRole('button', { name: 'First' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Last' })).toBeNull();
  });

  it('keeps the rows-per-page control labelled for assistive technology', () => {
    renderPager(120, 25);
    expect(screen.getByLabelText('Rows')).toBeInTheDocument();
  });

  it('disables ‹ on the first page and ‹ › at a one-page list', () => {
    renderPager(120, 25);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
    renderPager(5, 5);
    expect(screen.getAllByRole('button', { name: 'Previous page' }).at(-1)).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Next page' }).at(-1)).toBeDisabled();
  });

  it('‹ › ask for the neighbouring pages, keeping the other params', async () => {
    renderPager(120, 25, 'page=1&q=tan');
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(replace).toHaveBeenLastCalledWith('?page=2&q=tan', { scroll: false });
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    // Page 0 drops out of the address entirely, as in the classic pager.
    expect(replace).toHaveBeenLastCalledWith('?q=tan', { scroll: false });
  });

  it('the server pager carries the same compact branch', () => {
    const src = readFileSync(join(process.cwd(), 'components/pager.tsx'), 'utf8');
    const at = src.indexOf("if ((await currentUiTheme()) === 'atelier') {");
    expect(at).toBeGreaterThan(-1);
    const branch = src.slice(at, src.indexOf('return (\n    // `data-ui-pager`', at));
    expect(branch.length).toBeGreaterThan(600);
    expect(branch).toContain('data-ui-pager-compact');
    expect(branch).toContain("aria-label={t('previousPage')}");
    expect(branch).toContain("aria-label={t('nextPage')}");
    expect(branch).toContain('state.truncated');
  });
});
