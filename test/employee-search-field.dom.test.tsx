/**
 * The shared employee search FIELD, rendered (r179 W1).
 *
 * This is a rendering test rather than a source scan because every claim the two board items make about
 * this control is a claim about behaviour: that picking a person does NOT leave the page, that the value
 * rides the SAME GET form as the other filters, and that the raw typing does not. A source assertion can
 * see the hidden input exists; only a render can see what `new FormData(form)` actually carries after a
 * reader types four characters and presses Enter.
 *
 * Scope note: jsdom applies no CSS and computes no layout, so nothing here says anything about how the
 * popover sits over the filter row. What it pins is the form contract and the keyboard.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EmployeeSearchField, type EmployeeSearchOption } from '../components/employee-search-field';

const labels = {
  placeholder: 'Search by Employee ID or name',
  ariaLabel: 'Search employee',
  resultsLabel: 'Employee search results',
  noMatches: 'No matching employee',
  clear: 'Clear employee',
};

const people: EmployeeSearchOption[] = [
  { value: 'e1', name: 'Aisha Rahman', employeeCode: 'EMP-0008', secondary: 'Alpha Sdn Bhd · Finance' },
  { value: 'e2', name: 'Bala Krishnan', employeeCode: 'EMP-0081', secondary: 'Alpha Sdn Bhd · Ops' },
  { value: 'e3', name: 'Chan Wei Ming', employeeCode: 'CTR-0002', secondary: 'Beta Sdn Bhd' },
  { value: 'e4', name: 'Rahman Bin Yusof', employeeCode: null, secondary: null },
];

/**
 * The real shape both consumers use: the field sits INSIDE the existing GET filter form, beside the other
 * filters and one Apply button. `onSubmit` is intercepted because jsdom implements no navigation — the
 * spy is what tells us whether Enter picked a row or applied the filters.
 */
function renderField(props: Partial<React.ComponentProps<typeof EmployeeSearchField>> = {}) {
  const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
  const view = render(
    <form method="GET" onSubmit={onSubmit}>
      <EmployeeSearchField name="emp" employees={people} labels={labels} {...props} />
      <input aria-label="From" name="from" defaultValue="2026-08-01" />
      <button type="submit">Apply</button>
    </form>,
  );
  const form = view.container.querySelector('form') as HTMLFormElement;
  const hidden = () => view.container.querySelector('input[name="emp"][type="hidden"]') as HTMLInputElement;
  const box = () => screen.getByRole('combobox');
  return { ...view, form, hidden, box, onSubmit };
}

describe('EmployeeSearchField · the GET form contract', () => {
  it('starts empty and posts nothing under its field name', () => {
    const { hidden, form } = renderField();
    expect(hidden()).toBeInTheDocument();
    expect(hidden().value).toBe('');
    expect(new FormData(form).get('emp')).toBe('');
  });

  it('the VISIBLE box carries no name, so raw typing never reaches the address bar', async () => {
    const { box, form } = renderField();
    await userEvent.type(box(), 'rahm');
    expect(box()).not.toHaveAttribute('name');
    // Only the two real filters are in the payload; nothing anonymous rides along.
    expect([...new FormData(form).keys()].sort()).toEqual(['emp', 'from']);
  });

  it('picking a result posts that value alongside the other filters', async () => {
    const { box, hidden, form } = renderField();
    await userEvent.type(box(), '0081');
    await userEvent.click(screen.getByRole('option', { name: /EMP-0081/ }));
    expect(hidden().value).toBe('e2');
    const fd = new FormData(form);
    expect(fd.get('emp')).toBe('e2');
    expect(fd.get('from')).toBe('2026-08-01');
    // …and the box now reads back the house "ID left of name" label it was picked by.
    expect(box()).toHaveValue('EMP-0081 · Bala Krishnan');
  });

  it('pre-selects the value already in the address bar', () => {
    const { hidden, box } = renderField({ value: 'e3' });
    expect(hidden().value).toBe('e3');
    expect(box()).toHaveValue('CTR-0002 · Chan Wei Ming');
  });

  it('drops a value that is not in the scoped list rather than carrying it forward', () => {
    const { hidden, box } = renderField({ value: 'someone-elses-company' });
    expect(hidden().value).toBe('');
    expect(box()).toHaveValue('');
  });
});

describe('EmployeeSearchField · what it searches', () => {
  it('finds a partial name and shows the second line', async () => {
    const { box } = renderField();
    await userEvent.type(box(), 'rahman');
    const rows = screen.getAllByRole('option').map((o) => o.textContent);
    // starts-with beats contains — the same ranking the Personnel switcher uses.
    expect(rows[0]).toContain('Rahman Bin Yusof');
    expect(rows[1]).toContain('EMP-0008 · Aisha Rahman');
    expect(screen.getByText('Alpha Sdn Bhd · Finance')).toBeInTheDocument();
  });

  it('an Employee ID typed without its dash still finds the person', async () => {
    const { box, hidden } = renderField();
    await userEvent.type(box(), 'emp0008');
    const rows = screen.getAllByRole('option');
    expect(rows).toHaveLength(1);
    await userEvent.click(rows[0]);
    expect(hidden().value).toBe('e1');
  });

  it('says so when nothing matches, instead of showing an empty box', async () => {
    const { box } = renderField();
    await userEvent.type(box(), 'zzzz');
    expect(screen.getByText('No matching employee')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('caps the list — a company of 2,000 does not become 2,000 rows', async () => {
    const many: EmployeeSearchOption[] = Array.from({ length: 40 }, (_, i) => ({
      value: `x${i}`,
      name: `Ali Number ${i}`,
      employeeCode: `EMP-${String(i).padStart(4, '0')}`,
    }));
    const { box } = renderField({ employees: many });
    await userEvent.type(box(), 'ali');
    expect(screen.getAllByRole('option')).toHaveLength(8);
  });

  it('honours a caller-supplied cap', async () => {
    const { box } = renderField({ cap: 2 });
    await userEvent.type(box(), 'a');
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });
});

describe('EmployeeSearchField · keyboard, and the two meanings of Enter', () => {
  it('Enter PICKS the highlighted row and does not apply the filters', async () => {
    const { box, hidden, onSubmit } = renderField();
    await userEvent.type(box(), 'emp-00');
    await userEvent.keyboard('{Enter}');
    expect(hidden().value).toBe('e1');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('a second Enter, with the list closed, applies the filters', async () => {
    const { box, hidden, onSubmit } = renderField();
    await userEvent.type(box(), 'emp-00');
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(hidden().value).toBe('e1');
  });

  it('the arrow keys move the highlight, and Enter takes what is highlighted', async () => {
    const { box, hidden } = renderField();
    await userEvent.type(box(), 'emp-00');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(hidden().value).toBe('e2');
  });

  it('Escape closes the list without choosing and without applying', async () => {
    const { box, hidden, onSubmit } = renderField();
    await userEvent.type(box(), 'emp-00');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(hidden().value).toBe('');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('EmployeeSearchField · the box never shows something it will not submit', () => {
  it('typing over a committed choice un-commits it', async () => {
    const { box, hidden } = renderField({ value: 'e1' });
    expect(hidden().value).toBe('e1');
    await userEvent.type(box(), 'x');
    expect(hidden().value).toBe('');
  });

  it('leaving the field without picking anything snaps the text back', async () => {
    const { box, hidden } = renderField();
    await userEvent.type(box(), 'rahm');
    await userEvent.click(screen.getByLabelText('From'));
    expect(hidden().value).toBe('');
    expect(box()).toHaveValue('');
  });

  it('leaving the field after picking keeps the committed label', async () => {
    const { box, hidden } = renderField();
    await userEvent.type(box(), '0081');
    await userEvent.click(screen.getByRole('option', { name: /EMP-0081/ }));
    await userEvent.click(screen.getByLabelText('From'));
    expect(hidden().value).toBe('e2');
    expect(box()).toHaveValue('EMP-0081 · Bala Krishnan');
  });

  it('the clear button returns the field to "every employee"', async () => {
    const { box, hidden, onSubmit } = renderField({ value: 'e1' });
    await userEvent.click(screen.getByRole('button', { name: 'Clear employee' }));
    expect(hidden().value).toBe('');
    expect(box()).toHaveValue('');
    // It is a type="button": clearing a filter must not apply the form.
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
