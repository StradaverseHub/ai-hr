import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { YearSelect } from '../app/analytics/YearSelect';
import '../app/globals.css';

afterEach(cleanup);

it('keeps the leave-year picker fully visible in a narrow localized toolbar', () => {
  const screen = render(
    <form style={{ width: 106 }}>
      <YearSelect label="Năm nghỉ phép" name="year" selected={2026} years={[2026, 2025]} />
    </form>,
  );
  const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Năm nghỉ phép' });
  const label = select.labels![0];
  const range = document.createRange();
  range.selectNodeContents(label.firstChild!);
  const title = range.getBoundingClientRect();
  const control = select.getBoundingClientRect();
  const bounds = label.getBoundingClientRect();

  expect(control.top).toBeGreaterThanOrEqual(title.bottom);
  expect(control.left).toBeGreaterThanOrEqual(bounds.left);
  expect(control.right).toBeLessThanOrEqual(bounds.right);
  expect(select.value).toBe('2026');
});
