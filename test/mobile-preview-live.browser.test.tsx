import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { MobilePreviewData } from '../components/mobile-preview/types';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import '../app/globals.css';

vi.mock('next/navigation', () => {
  const useRouter = () => ({ refresh: vi.fn() });
  return { useRouter, default: { useRouter } };
});
const { MobileApp } = await import('../components/mobile-preview/mobile-app');
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const ready = <T,>(data: T) => ({ status: 'ready' as const, data });
const data = (): MobilePreviewData => ({
  today: '2026-10-08', leaveHistoryHref: '/leave/history', loadedAt: '2026-10-08T00:54:00Z',
  person: { name: 'Synthetic Viewer', employeeCode: 'TEST-1' },
  employment: { id: 'own-employment', company: 'Synthetic Employer', department: 'Test Department', position: 'Test Role' },
  clock: ready({ date: '2026-10-08', clockedIn: true, shiftStart: '09:00', shiftEnd: '18:00', events: [{ direction: 'in', time: '08:54' }] }),
  leave: ready(Array.from({ length: 9 }, (_, i) => ({ id: `leave-${i}`, name: `Configured leave ${i}`, available: i === 0 ? null : 11.5,
    balance: null, taken: 1, pending: 0.5, takenOnly: i === 8, sharedWith: i === 1 ? ['Configured leave 2'] : [],
    canRequest: true, notice: i === 0 ? 'statusNotGenerated' : null, cycleStart: '2026-01-01', cycleEnd: '2026-12-31' }))),
  requests: ready({ total: 1, items: [{ id: 'own-request', type: 'Configured leave 1', from: '2026-10-12', to: '2026-10-13', status: 'approved', partial: true }] }),
  claims: ready([{ id: 'own-claim', type: 'Synthetic claim', date: '2026-10-02', status: 'pending', amount: '28.00' }]),
  team: ready([{ employmentId: 'authorized-report', name: 'Synthetic Report', dates: [{ date: '2026-10-08', status: 'approved', session: 'AM' }] }]),
  tasks: ready([{ id: 'assigned-task', kind: 'leave', subject: 'Synthetic Report', href: '/approvals' }]),
  inbox: ready([{ id: 'update', title: 'Own update', body: 'Own body', href: 'https://example.test/private', read: false, createdAt: '2026-10-08T00:54:00Z' }]),
  payslips: ready([{ id: 'own-slip', company: 'Synthetic Employer', period: '2026-09' }]),
});
const messages = { en, ms, zh, ta, th, vi: viMessages };
function mount(d = data(), locale: keyof typeof messages = 'en') {
  return render(<NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="Asia/Kuala_Lumpur"><div style={{ width: 320, maxWidth: '100%' }}><MobileApp data={d} /></div></NextIntlClientProvider>);
}
function assertFits(container: HTMLElement) {
  const phone = container.querySelector('[aria-busy]') as HTMLElement;
  expect(phone.clientWidth).toBeGreaterThan(250);
  expect(phone.scrollWidth).toBeLessThanOrEqual(phone.clientWidth + 1);
  for (const el of phone.querySelectorAll('button,a')) {
    const rect = el.getBoundingClientRect();
    expect(rect.right).toBeLessThanOrEqual(phone.getBoundingClientRect().right + 1);
    expect(rect.left).toBeGreaterThanOrEqual(phone.getBoundingClientRect().left - 1);
  }
}
describe('Live Monolith in a real browser', () => {
  it('holds navigation and task links while a real punch is waiting for its server receipt', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(r => { resolve = r; });
    vi.spyOn(navigator.geolocation, 'getCurrentPosition').mockImplementation(success => success({ coords: { latitude: 3.15, longitude: 101.71, accuracy: 8 } } as GeolocationPosition));
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => options?.method === 'POST' ? pending : Promise.resolve(Response.json({ attendancePhotoSetting: 'not_required', locationValid: true }))));
    const ui = mount();
    fireEvent.click(ui.getByRole('button', { name: 'Finish my workday' }));
    fireEvent.click(ui.getByRole('button', { name: 'Confirm clock-out with a tap' }));
    await ui.findByText('Waiting for server confirmation…');
    expect(ui.getByRole('button', { name: 'Requests' }).hasAttribute('disabled')).toBe(true);
    expect(ui.getByRole('button', { name: 'Refresh data' }).hasAttribute('disabled')).toBe(true);
    expect(ui.getByRole('link', { name: /Synthetic Report Approve/ }).closest('[inert]')).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Requests' }));
    expect(ui.queryByText('Leave Request Status')).toBeNull();
    resolve(Response.json({ receipt: { id: 'saved-out', direction: 'out', date: '2026-10-08', recordedAt: '2026-10-08T10:02:00Z' } }));
    await ui.findByText('Confirmed by the server');
    expect(ui.getByRole('button', { name: 'Requests' }).hasAttribute('disabled')).toBe(false);
    expect(ui.getByRole('link', { name: /Synthetic Report Approve/ }).closest('[inert]')).toBeNull();
  });
  it('keeps both themes, all configured leave types, hidden figures and shared pools readable at 320px', () => {
    const ui = mount();
    fireEvent.click(ui.getByRole('button', { name: /Plan time off/ }));
    expect(ui.getAllByRole('button', { name: /Configured leave/ })).toHaveLength(9);
    assertFits(ui.container);
    fireEvent.click(ui.getByRole('button', { name: 'Light mode' }));
    assertFits(ui.container);
    fireEvent.click(ui.getByRole('button', { name: /Configured leave 0/ }));
    expect(ui.getByText('Not yet generated')).toBeTruthy();
    expect(ui.getByRole('link', { name: 'Request leave' }).getAttribute('href')).toBe('/leave?apply=1&applyType=leave-0');
    assertFits(ui.container);
  });
  it('opens existing guarded commands and keeps pending/approved and unread/workflow states distinct', () => {
    const ui = mount();
    fireEvent.click(ui.getByRole('button', { name: 'Finish my workday' }));
    expect(ui.getByRole('slider', { name: 'Slide to confirm OUT' })).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Keep working' }));
    fireEvent.click(ui.getByRole('button', { name: /Who’s away/ }));
    expect(ui.getByText('1 on approved leave')).toBeTruthy();
    expect(ui.getByText('0 with pending requests')).toBeTruthy();
    const person = ui.getByRole('button', { name: /Synthetic Report/ });
    expect(person.textContent).toContain('Approved · AM');
    expect(person.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(person); expect(person.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(ui.getByRole('button', { name: 'Inbox' }));
    expect(ui.queryByRole('link', { name: 'Open record' })).toBeNull(); // external stored href refused
    expect(ui.getByText(/Unread/)).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Requests' }));
    expect(ui.getByText(/Partially approved/)).toBeTruthy();
    expect(ui.getByText(/(?:MYR|RM).*28/)).toBeTruthy();
  });
  it('renders the disabled/unavailable/no-employment states without invented personal records', () => {
    const d = data(); d.employment = null; d.person = { name: null, employeeCode: null };
    d.clock = d.leave = d.requests = d.claims = d.inbox = d.payslips = { status: 'disabled' };
    d.team = { status: 'disabled' }; d.tasks = { status: 'unavailable' };
    const ui = mount(d);
    expect(ui.getByText('No active employment linked.')).toBeTruthy();
    expect(ui.getByText('Unable to load this section. Refresh to try again.')).toBeTruthy();
    expect(ui.queryByRole('button', { name: /Who’s away/ })).toBeNull();
    expect(ui.queryByRole('button', { name: 'Clock' })).toBeNull();
    expect(ui.container.textContent).not.toContain('Synthetic');
  });
  for (const locale of Object.keys(messages) as (keyof typeof messages)[]) it(`renders the complete navigation and notices in ${locale}`, () => {
    const errors: string[] = [];
    const onError = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));
    const ui = mount(data(), locale), m = messages[locale].mobilePreview;
    fireEvent.click(ui.getByRole('button', { name: m.live.requests }));
    fireEvent.click(ui.getByRole('button', { name: m.live.me }));
    fireEvent.click(ui.getByRole('checkbox', { name: m.live.largerText }));
    fireEvent.click(ui.getByRole('button', { name: m.live.home }));
    fireEvent.click(ui.getByRole('button', { name: m.gesture.finishAction }));
    expect(ui.getByRole('slider', { name: m.gesture.slideOut })).toBeTruthy();
    assertFits(ui.container);
    fireEvent.click(ui.getByRole('button', { name: m.gesture.keepWorking }));
    fireEvent.click(ui.getByRole('button', { name: new RegExp(m.live.planLeave) }));
    fireEvent.click(ui.getByRole('button', { name: /Configured leave 0/ }));
    assertFits(ui.container);
    expect(errors).toEqual([]);
    onError.mockRestore();
  });
});
