/**
 * The first rendering test in this repo (carried debt item 1 — there was no DOM runner until r93).
 *
 * It covers the fc776376 fix that source assertions could only describe indirectly: that the rows-per-page
 * control ACTUALLY APPEARS on a small list. showPager() used to hide the whole bar at 25 rows or fewer,
 * which is nearly every list on this tenant, and that is why the reporter said pagination did not exist.
 * test/pagination.test.ts pins showPager() returning true; only this pins that a reader SEES a control.
 *
 * Scope note, so nobody mistakes this for more coverage than it is: jsdom applies no CSS and computes no
 * layout. It cannot see a Tailwind emission-order bug like 4dbe04c6 — that needs the real browser project
 * (vitest.browser.config.ts). What this catches is rendering and interaction logic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { pageState, parsePageQuery } from '../lib/pagination';
import { ClientPager } from '../components/client-pager';

// The address bar, stubbed. replace() is recorded rather than performed — asserting the URL the pager
// asks for is the whole contract; actually navigating is Next's job, not this component's.
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
      <ClientPager state={state} />
    </NextIntlClientProvider>,
  );
}

describe('ClientPager', () => {
  // The actual reported bug: 23 employees, 36 leave requests, 47 payslips — all under the old threshold,
  // so the reader saw nothing at all and reported that pagination had not been built.
  it('shows the rows-per-page control on a list that fits on one page', () => {
    renderPager(5, 5);
    expect(screen.getByLabelText('Rows')).toBeInTheDocument();
    expect(screen.getByText('1–5 of 5')).toBeInTheDocument();
  });

  it('reports an honest empty range rather than hiding', () => {
    renderPager(0, 0);
    expect(screen.getByLabelText('Rows')).toBeInTheDocument();
    expect(screen.getByText('0 of 0')).toBeInTheDocument();
  });

  it('offers every page size plus All', () => {
    renderPager(5, 5);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['25', '50', '100', '200', 'All']);
  });

  // One render per test. cleanup() runs afterEach, not between renders inside a test, so two renders in
  // one test leave both pagers in the document and getByRole fails on "found multiple elements".
  it('disables both steps on a single page', () => {
    renderPager(5, 5);
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
  });

  it('enables Next when there is another page', () => {
    renderPager(312, 25);
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled();
  });

  it('asks for the next page without dropping the filters already in the address', async () => {
    renderPager(312, 25, 'q=lee&status=active');
    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(replace).toHaveBeenCalledTimes(1);
    const [href, opts] = replace.mock.calls[0];
    expect(href).toContain('q=lee');
    expect(href).toContain('status=active');
    expect(href).toContain('page=1');
    // scroll:false — paging should not throw the reader back to the top of a long table.
    expect(opts).toEqual({ scroll: false });
  });

  // Page 4 of 25-row pages is meaningless once the page is 200 rows, and landing past the end would show
  // an empty table — so a size change restarts at the first page, and page= leaves the address entirely.
  it('restarts at the first page when the size changes', async () => {
    renderPager(312, 25, 'page=3');
    await userEvent.selectOptions(screen.getByLabelText('Rows'), '100');
    const [href] = replace.mock.calls[0];
    expect(href).toContain('size=100');
    expect(href).not.toContain('page=');
  });

  it('says so on screen when All truncates at the ceiling', () => {
    renderPager(5000, 2000, 'size=all');
    expect(screen.getByText(/Showing the first 2,000 of 5,000 rows/)).toBeInTheDocument();
  });
});

/**
 * 9da61c86 — "keep the page size you pick, so you do not reset it every time you open the screen".
 *
 * Per SCREEN, in localStorage rather than in the address, and applied only on a BARE arrival. The address
 * is what a shared link carries, so a link must open on the view its SENDER was looking at — not on the
 * view the recipient last chose for themselves.
 */
describe('ClientPager remembers the rows-per-page for its screen', () => {
  const renderRemembering = (sp = '') => {
    search = sp;
    replace.mockClear();
    const state = pageState(parsePageQuery(Object.fromEntries(new URLSearchParams(sp))), 312, 25);
    return render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ClientPager state={state} rememberAs="a-screen" />
      </NextIntlClientProvider>,
    );
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('writes the choice down when the reader changes it', async () => {
    renderRemembering();
    await userEvent.selectOptions(screen.getByLabelText('Rows'), '100');
    expect(window.localStorage.getItem('pager.size.a-screen')).toBe('100');
  });

  it('applies it on the next bare arrival', () => {
    window.localStorage.setItem('pager.size.a-screen', '100');
    renderRemembering();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toContain('size=100');
  });

  // The link someone sent wins. It carries a page and a size, and rewriting either would show its
  // recipient a different set of rows from the one its sender was describing.
  it('leaves a link that already names a page or a size alone', () => {
    window.localStorage.setItem('pager.size.a-screen', '100');
    renderRemembering('page=3');
    expect(replace).not.toHaveBeenCalled();
    renderRemembering('size=50');
    expect(replace).not.toHaveBeenCalled();
  });

  it('ignores a stored value that is not an offered size', () => {
    window.localStorage.setItem('pager.size.a-screen', '10000');
    renderRemembering();
    expect(replace).not.toHaveBeenCalled();
  });

  // A screen that does not ask to be remembered must not read or write anyone else's setting.
  it('does nothing at all without a screen key', () => {
    window.localStorage.setItem('pager.size.a-screen', '100');
    renderPager(312, 25);
    expect(replace).not.toHaveBeenCalled();
  });
});
