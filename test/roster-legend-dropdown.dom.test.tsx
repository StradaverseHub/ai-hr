import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { RosterLegend } from '../components/roster-legend';
import en from '../messages/en.json';
afterEach(cleanup);
const entries = [
  ...Array.from({ length: 40 }, (_, i) => ({ value: `s${i}`, code: `S${i}`, name: `Shift ${i}`, hint: '09:00–18:00', className: 'bg-muted' })),
  { value: 'rest', code: 'RD', name: 'Rest day', hint: '', className: 'bg-muted' },
  { value: 'clear', code: 'Clear', name: 'Remove entry', hint: '', className: 'bg-background' },
  { value: null, code: 'OFF', name: 'Not scheduled', hint: '', className: 'bg-background' },
];
const mount = (onChoose?: (value: string) => void) => render(<NextIntlClientProvider locale="en" messages={en}><div style={{ overflow: 'hidden' }}><RosterLegend entries={entries} active="s0" onChoose={onChoose} /></div></NextIntlClientProvider>);
describe('compact roster legend', () => {
  it('portals outside clipping ancestors, searches a large library and selects the exact brush', async () => {
    const choose = vi.fn(), { container } = mount(choose);
    fireEvent.click(screen.getByRole('button', { name: 'Assign S0' }));
    const dialog = screen.getByRole('dialog', { name: 'Legend' });
    expect(container.contains(dialog)).toBe(false);
    const search = screen.getByRole('textbox', { name: en.roster.legendSearch });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: 'Shift 37' } });
    expect(screen.queryByRole('button', { name: /Shift 36/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Shift 37/ }));
    expect(choose).toHaveBeenCalledExactlyOnceWith('s37');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Assign S0' })).toHaveFocus());
  });
  it('preserves Rest/Clear and closes on Escape without changing the brush', async () => {
    const choose = vi.fn(); mount(choose);
    for (const [label, value] of [['RD Rest day','rest'],['Clear Remove entry','clear']]) {
      fireEvent.click(screen.getByRole('button', { name: 'Assign S0' }));
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(choose).toHaveBeenLastCalledWith(value);
    }
    choose.mockClear(); fireEvent.click(screen.getByRole('button', { name: 'Assign S0' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(choose).not.toHaveBeenCalled();
  });
  it('offers supervisors searchable information without assignment buttons', () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    const dialog = screen.getByRole('dialog', { name: 'Legend' });
    expect(dialog.querySelectorAll('button')).toHaveLength(1); // Close only; roster writers are absent.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'no matching shift' } });
    expect(screen.getByRole('status')).toHaveTextContent(en.roster.legendEmpty);
  });
});
