/**
 * Transaction View's filter selects follow the value the server chose after a client navigation (24 Nov 2026).
 *
 * Staging: choosing Employee A in the employee panel showed that employee's 2026-12 row while History's Year / Month
 * still read the previous view's 2027 / 01 (a full reload showed 2026 / 12), so Apply filters would have asked for the
 * wrong month. The selects are uncontrolled (`defaultValue`) and a client navigation re-renders them in place; React
 * keeps the DOM's value. Re-rendering with a new default is exactly what that navigation does, so that is what this
 * file does, first with a plain select (the defect) and then with ResettingSelect (the fix).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ResettingSelect } from '../app/payroll/transaction-view/resetting-select';

const years = ['', '2027', '2026', '2025'];
const options = years.map((y) => <option key={y} value={y}>{y || 'All'}</option>);

describe('Transaction View filter selects after a client navigation', () => {
  it('reproduces the defect with a plain uncontrolled select', () => {
    const view = render(<select aria-label="Year" defaultValue="2027">{options}</select>);
    view.rerender(<select aria-label="Year" defaultValue="2026">{options}</select>);
    expect((view.getByLabelText('Year') as HTMLSelectElement).value).toBe('2027');
  });

  it('follows the new server value with ResettingSelect', () => {
    const view = render(<ResettingSelect aria-label="Year" name="year" defaultValue="2027">{options}</ResettingSelect>);
    view.rerender(<ResettingSelect aria-label="Year" name="year" defaultValue="2026">{options}</ResettingSelect>);
    const select = view.getByLabelText('Year') as HTMLSelectElement;
    expect(select.value).toBe('2026');
    expect(select.name).toBe('year');
    view.rerender(<ResettingSelect aria-label="Year" name="year" defaultValue="">{options}</ResettingSelect>);
    expect((view.getByLabelText('Year') as HTMLSelectElement).value).toBe('');
  });

  it('keeps what the user is choosing while the server value is unchanged', () => {
    const view = render(<ResettingSelect aria-label="Year" name="year" defaultValue="2027">{options}</ResettingSelect>);
    fireEvent.change(view.getByLabelText('Year'), { target: { value: '2025' } });
    view.rerender(<ResettingSelect aria-label="Year" name="year" defaultValue="2027">{options}</ResettingSelect>);
    expect((view.getByLabelText('Year') as HTMLSelectElement).value).toBe('2025');
  });

  it('is what the page renders for every server-defaulted filter select', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../app/payroll/transaction-view/page.tsx'), 'utf8');
    for (const name of ['payrollCycleId', 'companyId', 'year', 'month']) {
      expect(src, name).toMatch(new RegExp(`<ResettingSelect name="${name}" defaultValue=`));
      expect(src, name).not.toMatch(new RegExp(`<select name="${name}" defaultValue=`));
    }
    // History's year/month and the Transaction Detail grid's year.
    expect(src.match(/<ResettingSelect name="year" defaultValue=/g)).toHaveLength(2);
  });
});
