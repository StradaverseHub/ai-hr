import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '../app/globals.css';
import { Card, CardHeader, CardTitle } from '../components/ui/card';
import { StackedTable, StackedHead, StackedTh, StackedBody, StackedRow, StackedTd } from '../components/ui/stacked-table';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

const html = document.documentElement;
afterEach(() => {
  cleanup();
  html.removeAttribute('data-ui-theme');
  html.classList.remove('dark');
  document.body.style.width = '';
});
for (const dark of [false, true]) {
  for (const width of [390, 1440]) {
    describe(`Current at ${width}px, dark=${dark}`, () => {
      it('paints shared components and keeps narrow ledger records contained and labelled', () => {
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
