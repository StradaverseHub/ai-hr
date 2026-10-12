import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '../app/globals.css';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { CurrentLedger } from '../components/current-ledger';
import { Card, CardHeader, CardTitle } from '../components/ui/card';
import { StackedTable, StackedHead, StackedTh, StackedBody, StackedRow, StackedTd } from '../components/ui/stacked-table';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

const html = document.documentElement;
afterEach(async () => {
  cleanup();
  html.removeAttribute('data-ui-theme');
  html.classList.remove('dark');
  document.body.style.width = '';
  await page.viewport(1280, 720);
});
for (const dark of [false, true]) {
  for (const width of [390, 1440]) {
    describe(`Current at ${width}px, dark=${dark}`, () => {
      it('paints shared components and keeps narrow ledger records contained and labelled', async () => {
        await page.viewport(width, 900);
        html.setAttribute('data-ui-theme', 'current');
        html.classList.toggle('dark', dark);
        document.body.style.width = `${width}px`;
        render(<main style={{ padding: 16 }}>
          <Card>
            <CardHeader><CardTitle>People</CardTitle></CardHeader>
            <div className="p-4"><label>Name<Input defaultValue="Aina Noor" /></label><Button>Save record</Button></div>
            <StackedTable label="Employees">
              <StackedHead><StackedTh>Employee</StackedTh><StackedTh>Department</StackedTh></StackedHead>
              <StackedBody><StackedRow><StackedTd label="Employee" role="title">Aina Noor</StackedTd><StackedTd label="Department">Operations</StackedTd></StackedRow></StackedBody>
            </StackedTable>
          </Card>
        </main>);
        const table = screen.getByRole('table', { name: 'Employees' });
        const card = document.querySelector('[data-ui-card]')!;
        expect(getComputedStyle(card).backgroundColor).toBe(dark ? 'rgb(40, 28, 52)' : 'rgb(48, 33, 60)');
        expect(getComputedStyle(document.querySelector('[data-ui-card-header]')!).backgroundColor).toBe('rgb(150, 120, 195)');
        expect(getComputedStyle(screen.getByRole('button', { name: 'Save record' })).color).toBe('rgb(43, 51, 32)');
        expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Aina Noor');
        const row = table.querySelector('tbody tr')!;
        expect(getComputedStyle(row).display).toBe(width === 390 ? 'grid' : 'table-row');
        if (width === 390) {
          expect(getComputedStyle(table.querySelector('td[data-label="Department"]')!, '::before').content).toContain('Department');
        }
        expect(table.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      });
    });
  }
}

// The Ledger is a distinct record workspace, not table paint. Inspect its actual responsive geometry.

for (const width of [390, 1440]) {
  it(`keeps the selected-record inspector and list usable at ${width}px`, async () => {
    await page.viewport(width, 900);
    html.setAttribute('data-ui-theme', 'current');
    document.body.style.width = `${width}px`;
    render(<NextIntlClientProvider locale="en" messages={messages}><main style={{ padding: 16 }}>
      <CurrentLedger label="Personnel" records={['Aina', 'Ryan'].map((title, i) => ({
        key: String(i), title, subtitle: 'Operations', reference: `EMP-000${i}`,
        status: 'Active', href: `/personnel/${i}`, actions: null,
        fields: [{ label: 'Company', value: 'A very long authorized company name that should wrap instead of widening the screen' }],
      }))}><table aria-label="Original table"><tbody><tr><td>Original table</td></tr></tbody></table></CurrentLedger>
    </main></NextIntlClientProvider>);
    const workspace = document.querySelector('[data-current-ledger]')!;
    expect(workspace.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    const inspector = screen.getByRole('complementary', { name: 'Selected record' });
    expect(inspector.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    const columns = getComputedStyle(workspace).gridTemplateColumns.split(' ');
    expect(columns).toHaveLength(width === 390 ? 1 : 2);
    const caption = document.querySelector('.current-ledger-caption')!;
    const firstEntry = document.querySelector('.current-ledger-entry')!;
    expect(firstEntry.getBoundingClientRect().top - caption.getBoundingClientRect().bottom).toBeLessThan(4);
    fireEvent.click(screen.getByRole('button', { name: /Ryan/ }));
    expect(screen.getByRole('heading', { name: 'Ryan' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByRole('table', { name: 'Original table' })).toBeVisible();
  });
}
