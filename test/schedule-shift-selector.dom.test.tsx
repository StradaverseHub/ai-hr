import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ScheduleShiftSelector } from '../components/schedule-shift-selector';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';

afterEach(cleanup);
const choices = Array.from({ length: 36 }, (_, index) => ({ id: `shift-${index}`, code: `S${String(index).padStart(2, '0')}`, name: index === 35 ? 'Night duty' : `Office ${index}`, available: true }));
const archived = { id: 'old', name: 'Old office', code: 'OLD', archived: true };
function mount(locale = 'en', messages = en) {
  return render(<NextIntlClientProvider locale={locale} messages={messages}><form aria-label="Shift selection">
    <ScheduleShiftSelector choices={[...choices, archived]} initialSelectedIds={['shift-0', 'old']} />
  </form></NextIntlClientProvider>);
}
function submitted() {
  return new FormData(screen.getByRole('form', { name: 'Shift selection' }) as HTMLFormElement).getAll('allowedShiftIds');
}

describe('Schedule Group shift selection', () => {
  it('searches code and name across more than thirty shifts without dropping hidden selections', () => {
    mount();
    expect(screen.getAllByRole('checkbox')).toHaveLength(36);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'night' } });
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: en.scheduleShiftSelection.selectMatching }));
    expect(submitted()).toEqual(['shift-0', 'old', 'shift-35']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'S00' } });
    expect(screen.getByRole('checkbox', { name: /Office 0/ })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /Night duty/ })).toBeNull();
    expect(submitted()).toContain('shift-35');
  });
  it('clears active selection globally while preserving archived references until explicitly removed', () => {
    mount();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'night' } });
    fireEvent.click(screen.getByRole('button', { name: en.scheduleShiftSelection.selectMatching }));
    fireEvent.click(screen.getByRole('button', { name: en.scheduleShiftSelection.clearActive }));
    expect(submitted()).toEqual(['old']);
    const history = screen.getByRole('region', { name: en.scheduleShiftSelection.historical });
    expect(within(history).getByText('OLD · Old office')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Old office/ })).toBeNull();
    fireEvent.click(within(history).getByRole('button', { name: /Old office/ }));
    expect(submitted()).toEqual([]);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: en.scheduleShiftSelection.selectMatching }));
    expect(submitted()).toHaveLength(36);
    expect(submitted()).not.toContain('old');
  });
  it('exposes a selected unavailable nonarchived reference without offering it as a new choice', () => {
    render(<NextIntlClientProvider locale="en" messages={en}><form aria-label="Shift selection"><ScheduleShiftSelector
      choices={[...choices, { id: 'unavailable', code: 'OTHER', name: 'Unavailable source', available: false }]}
      initialSelectedIds={['unavailable']} /></form></NextIntlClientProvider>);
    const history = screen.getByRole('region', { name: en.scheduleShiftSelection.historical });
    expect(within(history).getByText('OTHER · Unavailable source')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Unavailable source/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.scheduleShiftSelection.selectMatching }));
    expect(submitted()).toContain('unavailable');
    fireEvent.click(within(history).getByRole('button', { name: /Unavailable source/ }));
    expect(submitted()).not.toContain('unavailable');
    expect(screen.queryByRole('checkbox', { name: /Unavailable source/ })).toBeNull();
  });
  it('retains selections through an empty result and exposes explicit empty and disabled states', () => {
    mount();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'not a shift' } });
    expect(screen.getByText(en.scheduleShiftSelection.noMatches)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.scheduleShiftSelection.selectMatching })).toBeDisabled();
    expect(submitted()).toEqual(['shift-0', 'old']);
  });
  it.each(Object.entries({ en, ms, zh, ta, th, vi }))('renders translated selection controls and accessible active count in %s', (locale, messages) => {
    mount(locale, messages);
    expect(screen.getByRole('searchbox', { name: messages.scheduleShiftSelection.search })).toBeTruthy();
    expect(screen.getByRole('button', { name: messages.scheduleShiftSelection.clearActive })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('36');
    expect(screen.getByRole('group', { name: messages.scheduleShiftSelection.activeShifts }).tabIndex).toBe(0);
  });
});
