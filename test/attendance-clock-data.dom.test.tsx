import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { AttendanceClockData } from '../components/attendance-clock-data';
afterEach(cleanup);
const row = (id: string, time: string, removed = false) => ({ id, punchAt: time, direction: 'in' as const, method: 'web' as const, captureId: 'capture-' + id, photoAvailable: true, clockSource: 'online' as const, effectiveAt: null, receivedAt: null, lat: 3, lng: 101, voidedAt: removed ? '2026-07-16T00:00:00Z' : null, voidedBy: removed ? 'HR reviewer' : null, voidReason: removed ? 'Wrong clocking' : null, importRun: null, importFile: null });
type Rows = Parameters<typeof AttendanceClockData>[0]['data']['rows'];
function mount(rows: Rows) {
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
  it('labels an offline clocking and shows when it was received, while online and edited rows keep their source', () => {
    // Derived from the clock: received an hour after the minute it happened, both in the past.
    const happened = Math.floor(Date.now() / 60000) * 60000 - 7200000, receivedAt = new Date(happened + 3600000).toISOString();
    const offline = { ...row('o', '08:05:00'), method: 'mobile_offline' as const, clockSource: 'offline' as const, effectiveAt: new Date(happened).toISOString(), receivedAt };
    const { container } = mount([row('a', '08:00:00'), offline]);
    const line = copy.received.replace('{datetime}', new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(receivedAt)));
    const sources = (table: Element) => Array.from(table.querySelectorAll('tbody tr')).map(tr => tr.querySelectorAll('td')[2])
      .map(td => [td.firstChild?.textContent ?? null, td.querySelector('p')?.textContent ?? null, td.querySelector('p')?.className ?? null]);
    const main = container.querySelector('form table')!, rawTable = container.querySelector('dialog table')!;
    expect(sources(main)).toEqual([[copy.web, null, null], [copy.offline, line, 'mt-1 max-w-sm text-xs text-muted-foreground']]);
    expect(sources(rawTable)).toEqual(sources(main));
    // An edited offline time is HR's proposal, not the offline record, so it carries no received line.
    fireEvent.click(screen.getByRole('button', { name: copy.edit }));
    fireEvent.change(container.querySelectorAll('form table input[type="time"]')[1], { target: { value: '08:06' } });
    expect(sources(main)[1]).toEqual([copy.admin, null, null]);
    expect(sources(rawTable)[1]).toEqual([copy.offline, line, 'mt-1 max-w-sm text-xs text-muted-foreground']);
  });
  it('refuses a duplicate restoration before any submission', () => {
    const { container } = mount([row('a', '08:00:00'), row('b', '08:00:00', true)]);
    fireEvent.click(screen.getByRole('button', { name: copy.raw }));
    fireEvent.click(screen.getByRole('button', { name: copy.restore }));
    expect(screen.getByRole('alert').textContent).toBe(copy.duplicate);
    expect(JSON.parse((container.querySelector('[name="clockChanges"]') as HTMLInputElement).value).entries).toHaveLength(1);
  });
});
