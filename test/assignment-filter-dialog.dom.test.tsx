import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FilterChips, FilterPanel, type FilterPanelProps } from '../components/filter-panel';

afterEach(cleanup);
const props: FilterPanelProps = {
  action: '/admin/attendance/schedule-assignment/bulk',
  fields: [
    { kind: 'search', name: 'q', label: 'Search', placeholder: 'Find employees', ariaLabel: 'Search', removeAriaLabel: 'Remove search' },
    { kind: 'multi', name: 'status', label: 'Status', ariaLabel: 'Status', removeAriaLabel: 'Remove status', options: [{ value: 'current', label: 'Current' }, { value: 'scheduled', label: 'Scheduled' }] },
  ],
  values: { q: '', status: ['current', 'scheduled'] },
  hidden: [['returnTo', '/admin/attendance/schedule-assignment?q=Sam']],
  labels: { filter: 'Filter', apply: 'Apply', clearAll: 'Clear all', activeCount: '1 filter' },
  dialog: { closeLabel: 'Close filters' },
};

describe('assignment filters remain usable above page content', () => {
  it('portals out of the clipping container and restores keyboard focus when dismissed', async () => {
    const { container } = render(<div style={{ overflow: 'hidden', isolation: 'isolate' }}><FilterPanel {...props} /></div>);
    const trigger = screen.getByRole('button', { name: /Filter/ });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Filter' });
    expect(container.contains(dialog)).toBe(false);
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('retains the native GET contract, repeated values, hidden context, edits and close control', () => {
    render(<FilterPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const search = screen.getByRole('textbox', { name: 'Search' });
    fireEvent.change(search, { target: { value: 'Sam' } });
    const form = search.closest('form')!;
    expect(form.method).toBe('get'); expect(form.getAttribute('action')).toBe(props.action);
    const data = new FormData(form);
    expect(data.get('q')).toBe('Sam'); expect(data.getAll('status')).toEqual(['current', 'scheduled']);
    expect(data.get('returnTo')).toBe('/admin/attendance/schedule-assignment?q=Sam');
    expect(screen.getByRole('link', { name: 'Clear all' })).toHaveAttribute('href', `${props.action}?returnTo=%2Fadmin%2Fattendance%2Fschedule-assignment%3Fq%3DSam`);
    fireEvent.click(screen.getByRole('button', { name: 'Close filters' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('dismisses Clear all and reopens with the newly applied values, dropping the abandoned draft', async () => {
    const { rerender } = render(<FilterPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'Unsaved search' } });
    const clear = screen.getByRole('link', { name: 'Clear all' });
    expect(clear).toHaveAttribute('href', `${props.action}?returnTo=%2Fadmin%2Fattendance%2Fschedule-assignment%3Fq%3DSam`);
    fireEvent.click(clear);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The route keeps the filter island mounted while supplying cleared searchParams.
    rerender(<FilterPanel {...props} values={{ q: '', status: [] }} />);
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveValue('');
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
  });

  it('does not count or show blank values as applied filters in either presentation', () => {
    const empty = { ...props, values: { q: '', status: [] }, labels: { ...props.labels, activeCount: '0 filters' } };
    render(<><FilterPanel {...empty} /><FilterChips {...empty} /></>);
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
    expect(screen.queryByText('0 filters')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Remove search' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Clear all' })).toBeNull();
  });
});
