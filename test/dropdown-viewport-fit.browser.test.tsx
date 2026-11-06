/**
 * A DROPDOWN TALLER THAN THE WINDOW MUST SCROLL, NOT RUN OFF THE SCREEN.
 *
 * The report: the topbar's company picker listed every company in one column with no height limit, so with
 * a long company list the bottom of it ran past the window. The app's <body> is `h-dvh overflow-hidden`
 * and only <main> scrolls, so anything the topbar or a `position: fixed` panel draws below the fold can
 * never be scrolled into view — the companies down there simply could not be reached.
 *
 * The same shape was audited across every floating panel. The ones that could escape the window were the
 * three topbar menus (company, account, language), the payroll run row's ⋯ menu (fixed, opened downward
 * from the last rows) and the anchored panel (fixed). Each is opened here in a deliberately SHORT window,
 * in real Chromium with the real compiled Tailwind, because jsdom computes no layout and cannot see this.
 *
 * The in-page dropdowns (filter panel, multi-select, searchable list, …) had the second failure: opened DOWN
 * near the bottom of <main>, or inside a box that clips overflow, their lower half was cut off. They now go
 * through components/ui/fit-to-view.ts, and the last block opens them in exactly those two places.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { act, cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { enWithAiCentre as en } from './helpers/ai-centre-messages';
import '../app/globals.css';

// Server actions import the database and next/headers at module load; nothing here submits a form.
vi.mock('@/app/scope-actions', () => ({ setCompanyScope: async () => {} }));
vi.mock('@/app/i18n-actions', () => ({ setLocale: async () => {} }));
vi.mock('@/app/auth-actions', () => ({ logoutAction: async () => {} }));
vi.mock('@/app/ui-theme-actions', () => ({ setUiTheme: async () => ({ ok: true }) }));

const { CompanySwitcher } = await import('../components/company-switcher');
const { UserMenu } = await import('../components/user-menu');
const { LanguageSwitcher } = await import('../components/language-switcher');
const { PayrollRowActions } = await import('../app/payroll/row-actions');
const { AnchoredPanel, useAnchoredPanel } = await import('../components/ui/anchored-panel');
const { FilterPanel } = await import('../components/filter-panel');
const { MultiSelectPopover } = await import('../components/ui/multi-select-popover');
const { Combobox } = await import('../components/ui/combobox');

const SHORT = { width: 1280, height: 520 };

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={en as never} onError={() => {}}>
      {/* The app shell's own body rule: the window itself never scrolls. */}
      <div className="h-dvh overflow-hidden p-4">{ui}</div>
    </NextIntlClientProvider>,
  );

/** The panel is fully inside the window — nothing of it hangs below or above the fold. */
function expectOnScreen(el: Element, what: string) {
  const r = el.getBoundingClientRect();
  expect(r.height, `${what} rendered with no height`).toBeGreaterThan(0);
  expect(r.top, `${what} starts above the window`).toBeGreaterThanOrEqual(0);
  expect(r.bottom, `${what} runs past the bottom of the window`).toBeLessThanOrEqual(window.innerHeight);
}

/**
 * Resize the window and let the resize land. Chromium delivers the `resize` event a frame or two after
 * page.viewport() resolves, and the payroll row menu (correctly) closes on any resize — opening it before
 * the event arrives would measure a menu the harness itself is about to shut.
 */
async function viewport(width: number, height: number) {
  await page.viewport(width, height);
  await new Promise((r) => setTimeout(r, 100));
}

afterEach(() => cleanup());

describe('topbar menus stay inside a short window', () => {
  it('company picker: 40 companies scroll inside the panel and the last one can be reached', async () => {
    await viewport(SHORT.width, SHORT.height);
    const companies = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`,
      name: `COMPANY ${String(i + 1).padStart(2, '0')} SDN BHD`,
    }));
    const { container } = wrap(
      <div className="flex justify-end">
        <CompanySwitcher companies={companies} selected={['c0', 'c4']} />
      </div>,
    );
    await act(async () => (container.querySelector('[data-company-switcher]') as HTMLButtonElement).click());

    const form = container.querySelector('form') as HTMLFormElement;
    // Compare the scroll geometry after the panel's opening scale transition has settled.
    await Promise.all(form.getAnimations().map((animation) => animation.finished));
    expectOnScreen(form, 'the company panel');

    const labels = form.querySelectorAll('label');
    expect(labels, 'every company is still listed').toHaveLength(40);
    const list = labels[0].parentElement as HTMLElement;
    expect(list.scrollHeight, 'the list is taller than its box, so it must scroll').toBeGreaterThan(list.clientHeight);
    expect(getComputedStyle(list).overflowY).toBe('auto');

    // The heading and Select all stay put while the list scrolls under them.
    const selectAll = form.querySelector('button[type="button"]') as HTMLElement;
    const selectAllTop = selectAll.getBoundingClientRect().top;
    list.scrollTop = list.scrollHeight;
    const last = labels[39].getBoundingClientRect();
    const box = list.getBoundingClientRect();
    expect(last.bottom, 'the last company is reachable by scrolling the list').toBeLessThanOrEqual(box.bottom + 1);
    expect(last.top).toBeGreaterThanOrEqual(box.top - 1);
    expect(selectAll.getBoundingClientRect().top, 'Select all scrolled away with the list').toBe(selectAllTop);

    // A real pointer click must reach the open trigger, not the dismiss backdrop.
    await page.getByRole('button', { name: '2 companies', exact: true }).click();
    expect(container.querySelector('[data-company-switcher]')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('form')).toBeNull();
  });

  it('account menu fits the window and scrolls when it cannot', async () => {
    await viewport(SHORT.width, 320);
    const { container } = wrap(
      <div className="flex justify-end">
        <UserMenu name="Test Person" employeeCode="EMP-0001" employed canConfigureAccess canViewWorkforce />
      </div>,
    );
    await act(async () => (container.querySelector('button[aria-haspopup], button[aria-expanded]') as HTMLButtonElement).click());
    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    expectOnScreen(menu, 'the account menu');
    expect(getComputedStyle(menu).overflowY).toBe('auto');
  });

  it('language menu fits the window and scrolls when it cannot', async () => {
    await viewport(SHORT.width, 240);
    const { container } = wrap(
      <div className="flex justify-end">
        <LanguageSwitcher />
      </div>,
    );
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    const form = container.querySelector('form') as HTMLFormElement;
    expectOnScreen(form, 'the language menu');
    expect(form.scrollHeight, 'seven languages do not fit in 240px, so the menu must scroll').toBeGreaterThan(form.clientHeight);
  });
});

describe('fixed panels opened near the bottom of the window', () => {
  it('payroll row ⋯ menu opens upward from the last row instead of off the screen', async () => {
    await viewport(SHORT.width, SHORT.height);
    const { container } = wrap(
      <div className="flex h-full items-end justify-end">
        <PayrollRowActions moreLabel="More actions">
          <a href="#a">View</a>
          <a href="#b">Reset</a>
          <a href="#c">Close</a>
          <a href="#d">Reopen</a>
        </PayrollRowActions>
      </div>,
    );
    const trigger = container.querySelector('button[aria-label="More actions"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    expectOnScreen(menu, 'the row menu');
    expect(menu.getBoundingClientRect().bottom, 'the menu did not open upward').toBeLessThanOrEqual(
      trigger.getBoundingClientRect().top,
    );

    // Scrolling INSIDE the menu is reading it, not the row moving: it must stay open.
    await act(async () => menu.dispatchEvent(new Event('scroll')));
    expect(container.querySelector('[role="menu"]'), 'a scroll inside the menu closed it').not.toBeNull();
  });

  it('anchored panel taller than the room it has scrolls inside itself', async () => {
    await viewport(SHORT.width, SHORT.height);
    function Harness() {
      const [open, setOpen] = useState(false);
      const { at, anchorTo } = useAnchoredPanel({ open, onClose: () => setOpen(false) });
      return (
        <div className="flex h-full items-center justify-end">
          <button
            type="button"
            onClick={(e) => {
              anchorTo(e.currentTarget);
              setOpen(true);
            }}
          >
            View
          </button>
          {open && (
            <AnchoredPanel at={at} role="dialog">
              {Array.from({ length: 30 }, (_, i) => (
                <p key={i}>Line {i + 1}</p>
              ))}
            </AnchoredPanel>
          )}
        </div>
      );
    }
    const { container } = wrap(<Harness />);
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expectOnScreen(panel, 'the anchored panel');
    expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
  });
});

/** The panel is fully inside `box` — nothing of it is clipped by the box it opened in. */
function expectInside(el: Element, box: Element, what: string) {
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  expect(r.height, `${what} rendered with no height`).toBeGreaterThan(0);
  expect(r.top, `${what} is cut off at the top of its box`).toBeGreaterThanOrEqual(b.top);
  expect(r.bottom, `${what} is cut off at the bottom of its box`).toBeLessThanOrEqual(b.bottom);
}

/** The app's own scroller: the window is locked and only <main> scrolls (app/layout.tsx). */
const Main = ({ children }: { children: ReactNode }) => (
  <main data-testid="main" className="relative h-full overflow-y-auto">
    {children}
  </main>
);

describe('in-page dropdowns fit the part of the screen that can be seen', () => {
  const options = Array.from({ length: 30 }, (_, i) => ({ value: `s${i}`, label: `Status ${i + 1}` }));

  it('filter panel opened at the bottom of the page opens upwards and stays whole', async () => {
    await viewport(SHORT.width, SHORT.height);
    const { container } = wrap(
      <Main>
        <div className="flex h-full items-end justify-end pb-2">
          <FilterPanel
            action="/people"
            fields={[{ kind: 'multi', name: 'status', label: 'Status', ariaLabel: 'Status', options, removeAriaLabel: 'Remove' }]}
            values={{}}
            labels={{ filter: 'Filter', apply: 'Apply', clearAll: 'Clear all', activeCount: 'active' }}
          />
        </div>
      </Main>,
    );
    const trigger = container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expectInside(panel, container.querySelector('main') as HTMLElement, 'the filter panel');
    expect(panel.getBoundingClientRect().bottom, 'the filter panel did not open upwards').toBeLessThanOrEqual(
      trigger.getBoundingClientRect().top,
    );
    // The form (fields and Apply together) scrolls inside the panel, so Apply is always reachable.
    const apply = container.querySelector('button[type="submit"]') as HTMLElement;
    const scroller = panel.firstElementChild as HTMLElement;
    expect(scroller.scrollHeight, 'thirty statuses must scroll inside the panel').toBeGreaterThan(scroller.clientHeight);
    scroller.scrollTop = scroller.scrollHeight;
    expectInside(apply, panel, 'the Apply button, scrolled to');
  });

  it('multi-select inside a box that clips overflow shrinks to the box and scrolls', async () => {
    await viewport(SHORT.width, SHORT.height);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, name: `Employee ${i + 1}` }));
    const { container } = wrap(
      <Main>
        <div data-testid="card" className="mt-6 h-[22rem] overflow-hidden rounded-lg border p-4">
          <MultiSelectPopover
            label="Employees"
            allLabel="All employees"
            options={many}
            selected={new Set()}
            onChange={() => {}}
            searchPlaceholder="Search"
            selectAllLabel="Select all"
            clearAllLabel="Clear"
            selectedCount={(n) => `${n} selected`}
          />
        </div>
      </Main>,
    );
    await act(async () => (container.querySelector('button[aria-expanded]') as HTMLButtonElement).click());
    const card = container.querySelector('[data-testid="card"]') as HTMLElement;
    const search = container.querySelector('input[placeholder="Search"]') as HTMLElement;
    const panel = search.parentElement as HTMLElement;
    expectInside(panel, card, 'the multi-select panel');
    expectInside(search, card, 'the search box');
    const labels = panel.querySelectorAll('label');
    const list = labels[0].parentElement as HTMLElement;
    expect(list.scrollHeight, 'the options must scroll inside the panel').toBeGreaterThan(list.clientHeight);
  });

  it('searchable list at the bottom of the page opens upwards', async () => {
    await viewport(SHORT.width, SHORT.height);
    const { container } = wrap(
      <Main>
        <div className="flex h-full items-end pb-2">
          <div className="w-64">
            <Combobox
              value=""
              options={options}
              placeholder="Choose"
              searchPlaceholder="Search"
              noResultsLabel="None"
              legacySuffix="(old)"
            />
          </div>
        </div>
      </Main>,
    );
    const trigger = container.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    const panel = (container.querySelector('[role="listbox"]') as HTMLElement).parentElement as HTMLElement;
    expectInside(panel, container.querySelector('main') as HTMLElement, 'the searchable list');
    expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(trigger.getBoundingClientRect().top);
  });

  it('a dropdown with room below is left exactly as its classes draw it', async () => {
    await viewport(SHORT.width, SHORT.height);
    const { container } = wrap(
      <Main>
        <div className="w-64">
          <Combobox value="" options={options.slice(0, 3)} placeholder="Choose" searchPlaceholder="Search" noResultsLabel="None" legacySuffix="(old)" />
        </div>
      </Main>,
    );
    await act(async () => (container.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement).click());
    const panel = (container.querySelector('[role="listbox"]') as HTMLElement).parentElement as HTMLElement;
    expect(panel.getAttribute('style') ?? '', 'the hook wrote styles to a panel that already fitted').toBe('');
  });
});
