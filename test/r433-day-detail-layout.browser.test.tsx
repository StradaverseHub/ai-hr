/**
 * r433 (faca1cfb round 1) — THE ATTENDANCE DAY SCREEN'S NEW SECTIONS, MEASURED IN A REAL ENGINE (Chromium with
 * the app's compiled Tailwind) at 390px and 1280px. Every claim is a layout claim: the Employee Information
 * grid wraps a long name / company / position inside its column, and the Overtime rows (all eight, the
 * widest case) never push the page sideways. Mounts the REAL parts the page ships
 * (components/attendance-day-parts.tsx), inside a page column with the shell's 16px gutters.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import '../app/globals.css';
import en from '../messages/en.json';
import { DayField, DayFieldGrid, DayOvertimeRows } from '../components/attendance-day-parts';

afterEach(cleanup);
const rect = (el: Element) => el.getBoundingClientRect();

const LONG = 'Muhammad Aizuddin bin Abdul Rahman Al-Haj Ibrahim Sdn Bhd Kuala Lumpur Branch Office';
const UNBROKEN = 'X'.repeat(70);
const KEYS = ['lateness', 'earlyOut', 'flat', 'ot00', 'ot10', 'ot15', 'ot20', 'ot30'] as const;

function Screen() {
  return (
    <div data-testid="page" style={{ boxSizing: 'border-box', padding: '0 16px' }} className="space-y-4">
      <section data-testid="info">
        <DayFieldGrid>
          <DayField label="Name" value={LONG} />
          <DayField label="Employee ID" value={UNBROKEN} />
          <DayField label="Company" value={LONG} />
          <DayField label="Department" value={LONG} />
          <DayField label="Position" value={LONG} />
          <DayField label="Attendance date" value="Thursday, 9 October 2026" />
          <DayField label="Schedule group" value={LONG} />
        </DayFieldGrid>
      </section>
      <section data-testid="clockbreak">
        <DayFieldGrid cols={3}>
          <DayField label="Attendance date" value="Thursday, 9 October 2026" />
          <DayField label="Shift" value={`${UNBROKEN} · 08:00 to 17:00 · 8h 00m`} />
          <DayField label="Break time" value="1h 00m" />
        </DayFieldGrid>
      </section>
      <section data-testid="ot">
        <NextIntlClientProvider locale="en" messages={en as never}>
          <DayOvertimeRows
            items={KEYS.map((only) => ({ only, label: only === 'ot00' ? `OT 0.0 (unpaid) ${LONG}` : `Item ${only}` }))}
            figures={{
              lateMinutes: 3,
              earlyOutMinutes: 5,
              ot: { flat: 60, ot00: 30, ot10: 60, ot15: 120, ot20: 90, ot30: 45 },
              hasRow: true,
              explanation: { kind: 'unavailable', reason: 'no-trace' },
            }}
            itemHeading="Item"
            amountHeading="Amount"
            footnote="Only items that apply to this day are listed."
          />
        </NextIntlClientProvider>
      </section>
    </div>
  );
}

for (const width of [390, 1280]) {
  describe(`attendance day sections at ${width}px`, () => {
    const mount = () => {
      document.body.style.margin = '0';
      document.body.style.width = `${width}px`;
      render(<Screen />);
      const page = screen.getByTestId('page');
      expect(rect(page).width).toBe(width);
      return page;
    };

    it('nothing passes the content edge: no field, row or cell, and the document does not scroll sideways', () => {
      const page = mount();
      const right = rect(page).right - 16 + 0.5;
      expect(document.body.scrollWidth, 'document').toBeLessThanOrEqual(width);
      const boxes = page.querySelectorAll('[data-testid="info"] > div > div, [data-testid="clockbreak"] > div > div, [data-day-ot-table], [data-day-ot-table] th, [data-day-ot-table] td');
      expect(boxes.length, 'the guard measured something').toBeGreaterThan(30);
      for (const el of boxes) if (rect(el).width > 0) expect(rect(el).right, `${el.tagName} ${el.textContent?.slice(0, 24)}`).toBeLessThanOrEqual(right);
    });

    it('long values wrap inside their own column instead of overflowing it', () => {
      const page = mount();
      const values = [...page.querySelectorAll('[data-testid="info"] > div > div > div:last-child, [data-testid="clockbreak"] > div > div > div:last-child')];
      expect(values.length).toBe(10);
      for (const v of values) expect(v.scrollWidth, v.textContent ?? '').toBeLessThanOrEqual(v.clientWidth + 1);
      const company = values.find((v) => v.textContent === LONG)!;
      expect(rect(company).height, 'a long company wraps onto further lines').toBeGreaterThan(20);
    });

    it('all eight overtime rows render, one per item, each with its figure right-aligned beside it', () => {
      const page = mount();
      const rows = [...page.querySelectorAll('[data-day-ot-row]')];
      expect(rows.map((r) => r.getAttribute('data-day-ot-row'))).toEqual([...KEYS]);
      for (const r of rows) {
        const [label, figure] = [rect(r.children[0]), rect(r.children[1])];
        expect(figure.left, 'figure sits right of the label').toBeGreaterThanOrEqual(label.right - 1);
        expect(r.children[1].textContent).toMatch(/\d/);
      }
    });
  });
}
