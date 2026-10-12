import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { AttendanceClockData } from '../components/attendance-clock-data';
afterEach(cleanup);
const row = (id: string, time: string, removed = false) => ({ id, punchAt: time, direction: 'in' as const, method: 'web' as const, captureId: 'capture-' + id, photoAvailable: true, lat: 3, lng: 101, voidedAt: removed ? '2026-07-16T00:00:00Z' : null, voidedBy: removed ? 'HR reviewer' : null, voidReason: removed ? 'Wrong clocking' : null, importRun: null, importFile: null });
function mount(rows: ReturnType<typeof row>[]) {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  return render(<NextIntlClientProvider locale="en" messages={messages}><AttendanceClockData data={{ baseline: 'baseline', rows }} employmentId="worker" date="2026-07-15" action={vi.fn()}/></NextIntlClientProvider>);
}
const copy = messages.attendance.clockData;
describe('clock-data editing and retained evidence', () => {
  it('stages a removal without erasing the raw original or its evidence', () => {
    const { container } = mount([row('a', '08:00:00')]);
    fireEvent.click(screen.getByRole('button', { name: copy.edit }));
    fireEvent.click(screen.getByRole('button', { name: copy.remove }));
    const payload = JSON.parse((container.querySelector('[name="clockChanges"]') as HTMLInputElement).value);
    expect(payload.entries).toEqual([]);
    expect(payload.baseline).toBe('baseline');
    fireEvent.click(screen.getByRole('button', { name: copy.raw }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('08:00:00')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: copy.photo }).getAttribute('href')).toBe('/api/attendance/photo/capture-a');
    expect(dialog.querySelector('input')).toBeNull();
  });
  it('restores the original identity into the proposed set with a required reason', () => {
    const { container } = mount([row('a', '08:00:00', true)]);
    fireEvent.click(screen.getByRole('button', { name: copy.raw }));
    expect(screen.getByText(/HR reviewer/)).toBeTruthy();
    expect(screen.getByText(/Wrong clocking/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.restore }));
    const payload = JSON.parse((container.querySelector('[name="clockChanges"]') as HTMLInputElement).value);
    expect(payload.entries).toEqual([{ id: 'a', punchAt: '08:00:00', direction: 'in' }]);
    expect((screen.getByRole('textbox', { name: copy.reason }) as HTMLTextAreaElement).required).toBe(true);
  });
  it('refuses a duplicate restoration before any submission', () => {
    const { container } = mount([row('a', '08:00:00'), row('b', '08:00:00', true)]);
    fireEvent.click(screen.getByRole('button', { name: copy.raw }));
    fireEvent.click(screen.getByRole('button', { name: copy.restore }));
    expect(screen.getByRole('alert').textContent).toBe(copy.duplicate);
    expect(JSON.parse((container.querySelector('[name="clockChanges"]') as HTMLInputElement).value).entries).toHaveLength(1);
  });
});
