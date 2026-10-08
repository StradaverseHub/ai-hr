/**
 * r429 (f6819e19) — THE BREAKS TABLE, MEASURED IN A REAL ENGINE (Chromium with the app's compiled
 * Tailwind). jsdom computes no layout and applies no container query, and D6's promise is a layout
 * promise: on a 390px phone the table becomes labelled blocks (components/ui/stacked-table.tsx), nothing
 * scrolls the page sideways, and a row's refusal message (StatusWord, signal tone) sits readably under its
 * row rather than being clipped or pushed off-screen.
 *
 * Mirrors test/r427-label-value-layout.browser.test.tsx's method: mount the REAL island
 * (components/shift-time-fields.tsx) inside a page column of the given width with the shell's 16px
 * gutters, in both themes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import '../app/globals.css';
import en from '../messages/en.json';
import { ShiftTimeFields } from '../components/shift-time-fields';

const html = document.documentElement;
const setTheme = (theme: 'monolith' | 'classic') => html.setAttribute('data-ui-theme', theme);
afterEach(() => {
  cleanup();
  html.removeAttribute('data-ui-theme');
});

const rect = (el: Element) => el.getBoundingClientRect();
const fits = (el: Element, right: number, msg: string) => expect(rect(el).right, msg).toBeLessThanOrEqual(right);

/** Four rows: one ordinary, one FLEXIBLE with its own minutes box, one that OVERLAPS the first (so a
 *  refusal message renders), and one half-filled (another, shorter message). Exercises the widest real
 *  combination of controls the table can show in one render. */
function Screen() {
  return (
    <div data-testid="page" style={{ boxSizing: 'border-box', padding: '0 16px' }}>
      <ShiftTimeFields
        defaultStart="09:00"
        defaultEnd="18:00"
        defaultBreaks={[
          { start: '12:00', end: '13:00', flexible: true, flexibleMinutes: '45' },
          { start: '12:30', end: '13:15' }, // overlaps the row above
          { start: '15:00', end: '' }, // half-filled
          { start: '16:00', end: '16:15', paid: true },
        ]}
      />
    </div>
  );
}

function mount(width: number, theme: 'monolith' | 'classic') {
  setTheme(theme);
  document.body.style.margin = '0';
  document.body.style.width = `${width}px`;
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <Screen />
    </NextIntlClientProvider>,
  );
  const page = screen.getByTestId('page');
  expect(rect(page).width).toBe(width);
  return page;
}

for (const theme of ['monolith', 'classic'] as const) {
  for (const width of [390, 1440]) {
    const narrow = width === 390;
    describe(`${theme} at ${width}px — the Breaks table`, () => {
      it('nothing passes the content edge: no section, table, row, cell or message overflows', () => {
        const page = mount(width, theme);
        const right = rect(page).right - 16 + 0.5;
        expect(document.body.scrollWidth, 'document does not scroll sideways').toBeLessThanOrEqual(width);
        const boxes = page.querySelectorAll('[data-section-card], [data-stacked-table], td, [data-status-word]');
        expect(boxes.length).toBeGreaterThan(10);
        for (const el of boxes) if (rect(el).width > 0) fits(el, right, `${el.tagName} ${el.textContent?.slice(0, 24)}`);
      });

      it(
        narrow
          ? 'the table becomes labelled blocks: header hidden, each visible cell prints its column name'
          : 'the table is an ordinary table with a visible header',
        () => {
          const page = mount(width, theme);
          const table = page.querySelector('[data-stacked-table] table')!;
          expect(table.getAttribute('role')).toBe('table');
          const rows = [...table.querySelectorAll('tbody tr[role="row"]')];
          expect(rows.length).toBeGreaterThanOrEqual(4);
          if (narrow) {
            expect(rect(table.querySelector('thead')!).width).toBeLessThanOrEqual(1);
            for (const r of rows) expect(getComputedStyle(r).display).toBe('grid');
          } else {
            expect(rect(table.querySelector('thead')!).height).toBeGreaterThan(15);
            for (const r of rows) expect(getComputedStyle(r).display).toBe('table-row');
          }
        },
      );

      it('the overlap refusal names both rows and fits inside the table, in signal tone', () => {
        const page = mount(width, theme);
        const words = [...page.querySelectorAll('[data-status-word="signal"]')];
        expect(words.length, 'at least the overlap and the half-filled row each raise one').toBeGreaterThanOrEqual(2);
        const overlap = words.find((w) => /overlaps/i.test(w.textContent ?? ''));
        expect(overlap, 'the overlap message is on screen').toBeTruthy();
        expect(overlap!.textContent).toContain('Break 2');
        expect(overlap!.textContent).toContain('Break 1');
        const right = rect(page).right - 16 + 0.5;
        fits(overlap!, right, 'overlap message');
      });

      it('the half-filled row is named too, and the banner counts every row needing a fix', () => {
        const page = mount(width, theme);
        const banner = page.querySelector('[role="alert"]');
        expect(banner?.textContent).toMatch(/\d+ break row/i);
        const half = [...page.querySelectorAll('[data-status-word="signal"]')].find((w) => /needs an end time/i.test(w.textContent ?? ''));
        expect(half?.textContent).toContain('Break 3');
      });

      it('the Flexible row shows its own minutes box beside the tick', () => {
        const page = mount(width, theme);
        const minutesBox = screen.getByLabelText(en.roster.breakRowMinutes) as HTMLInputElement;
        expect(minutesBox.value).toBe('45');
        const right = rect(page).right - 16 + 0.5;
        fits(minutesBox, right, 'flexible minutes box');
      });
    });
  }
}
