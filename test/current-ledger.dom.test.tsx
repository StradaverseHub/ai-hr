import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { CurrentLedger, type LedgerRecord } from '../components/current-ledger';

const record = (key: string, title: string): LedgerRecord => ({
  key, title, subtitle: 'Operations', reference: key, status: 'Active', href: `/personnel/${key}`,
  fields: [{ label: 'Company', value: `Company ${key}` }], actions: <button>Action {key}</button>,
});
const first = record('a', 'Aina'), second = record('b', 'Ryan');
const ui = (records = [first, second]) => <NextIntlClientProvider locale="en" messages={messages}>
  <CurrentLedger records={records} label="Personnel"><table aria-label="Original table"><tbody><tr><td>Original actions</td></tr></tbody></table></CurrentLedger>
</NextIntlClientProvider>;
afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-ui-theme'); });

it('selects a record in place and preserves its real destination and action nodes', () => {
  document.documentElement.setAttribute('data-ui-theme', 'current');
  render(ui());
  const inspector = () => screen.getByRole('complementary', { name: 'Selected record' });
  expect(within(inspector()).getByRole('heading', { name: 'Aina' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Ryan/ }));
  expect(within(inspector()).getByRole('heading', { name: 'Ryan' })).toBeVisible();
  expect(within(inspector()).getByRole('link', { name: /Open full record/ })).toHaveAttribute('href', '/personnel/b');
  expect(within(inspector()).getByRole('button', { name: 'Action b' })).toBeVisible();
  expect(screen.getByRole('button', { name: /Ryan/ })).toHaveAttribute('aria-pressed', 'true');
});

it('drops stale selection when the authorized page projection changes', () => {
  document.documentElement.setAttribute('data-ui-theme', 'current');
  const { rerender } = render(ui());
  fireEvent.click(screen.getByRole('button', { name: /Ryan/ }));
  rerender(ui([first]));
  expect(screen.queryByText('Ryan')).toBeNull();
  expect(screen.queryByText('Company b')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Aina' })).toBeVisible();
  rerender(ui([]));
  expect(screen.queryByRole('complementary')).toBeNull();
});

it('offers the original table and follows live theme changes', async () => {
  document.documentElement.setAttribute('data-ui-theme', 'current');
  render(ui());
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));
  expect(screen.getByRole('table', { name: 'Original table' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Ledger' }));
  expect(screen.getByRole('complementary')).toBeVisible();
  await act(async () => document.documentElement.setAttribute('data-ui-theme', 'classic'));
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(screen.getByRole('table', { name: 'Original table' })).toBeVisible();
});


it('prints the full original projection and returns to the selected ledger afterward', () => {
  document.documentElement.setAttribute('data-ui-theme', 'current');
  render(ui());
  fireEvent.click(screen.getByRole('button', { name: /Ryan/ }));
  fireEvent(window, new Event('beforeprint'));
  expect(screen.getByRole('table', { name: 'Original table' })).toBeVisible();
  expect(screen.queryByRole('complementary')).toBeNull();
  fireEvent(window, new Event('afterprint'));
  expect(screen.getByRole('heading', { name: 'Ryan' })).toBeVisible();
});
