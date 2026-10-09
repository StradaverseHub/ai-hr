import { NextIntlClientProvider } from 'next-intl';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_DESIGN, type MobileBuilderState } from '../lib/mobile-design';
import type { MobilePreviewData } from '../components/mobile-preview/types';
import '../app/globals.css';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viMessages from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../app/mobile-preview/actions', () => ({ changeMobileDesignAction: vi.fn() }));
const { MobileBuilder } = await import('../components/mobile-preview/mobile-builder');
const { changeMobileDesignAction } = await import('../app/mobile-preview/actions');
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(changeMobileDesignAction).mockReset(); });
const data: MobilePreviewData = {
  today: '2026-10-10', loadedAt: '2026-10-10T01:00:00Z', leaveHistoryHref: '/leave', person: { name: 'Test Viewer', employeeCode: 'TEST' },
  employment: { id: 'own', company: 'Test Company', department: null, position: null },
  clock: { status: 'ready', data: { date: '2026-10-10', clockedIn: false, shiftStart: null, shiftEnd: null, events: [] } },
  leave: { status: 'ready', data: Array.from({ length: 6 }, (_, n) => ({ id: String(n), name: `Leave ${n}`, available: n, balance: n, taken: 0, pending: 0, takenOnly: false, sharedWith: [], canRequest: true, notice: null, cycleStart: '2026-01-01', cycleEnd: '2026-12-31' })) },
  requests: { status: 'ready', data: { items: [], total: 0 } }, claims: { status: 'disabled' }, team: { status: 'disabled' }, tasks: { status: 'ready', data: [] }, inbox: { status: 'disabled' }, payslips: { status: 'disabled' },
};
const state = (): MobileBuilderState => ({ tenantName: 'Test Tenant', draft: structuredClone(DEFAULT_MOBILE_DESIGN), draftRevision: 0, releases: [] });
const catalogues = { en, ms, zh, vi: viMessages, th, ta };
function mount(initial = state(), locale: keyof typeof catalogues = 'en', width = 1200) {
  return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} timeZone="Asia/Kuala_Lumpur"><div style={{ width, maxWidth: '100%' }}><MobileBuilder data={data} initial={initial} /></div></NextIntlClientProvider>);
}
describe('tenant mobile builder in a real browser', () => {
  it('changes presentation immediately and keeps draft/published gestures free of HR writes', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const location = vi.spyOn(navigator.geolocation, 'getCurrentPosition').mockImplementation(success => success({ coords: { latitude: 3.15, longitude: 101.71, accuracy: 8 } } as GeolocationPosition));
    const camera = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(new Error('Preview must not request a camera'));
    const ui = mount();
    fireEvent.change(ui.getByRole('textbox', { name: 'App brand name' }), { target: { value: 'Tenant Studio' } });
    expect(ui.getByText('Tenant Studio')).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Publish' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(ui.getByRole('button', { name: 'Cobalt' }));
    const phone = ui.container.querySelector('[data-appearance]') as HTMLElement;
    expect(phone.style.getPropertyValue('--brand-button')).toBe('#91b5ff');
    fireEvent.click(ui.getByRole('button', { name: 'Light' })); expect(phone.dataset.appearance).toBe('light');
    fireEvent.click(ui.getByRole('button', { name: 'Clock in with a tap' }));
    expect(ui.getByText('Gesture preview complete. No attendance was recorded.')).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Published' }));
    expect(ui.queryByText('Tenant Studio')).toBeNull();
    fireEvent.click(ui.getByRole('button', { name: 'Clock in with a tap' }));
    expect(location).not.toHaveBeenCalled(); expect(camera).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(changeMobileDesignAction).not.toHaveBeenCalled();
  });
  it('keeps unsaved edits when leaving through a client navigation is cancelled', () => {
    const ui = mount();
    fireEvent.change(ui.getByRole('textbox', { name: 'App brand name' }), { target: { value: 'Keep my edits' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const link = document.createElement('a'); link.href = '/dashboard'; document.body.append(link);
    try { expect(fireEvent.click(link)).toBe(false); expect(confirm).toHaveBeenCalledTimes(1); expect(ui.getByText('Keep my edits')).toBeTruthy(); }
    finally { link.remove(); }
  });
  it('requires saved changes and an explicit tenant publish confirmation, then preserves history', async () => {
    const ui = mount();
    fireEvent.change(ui.getByRole('textbox', { name: 'App brand name' }), { target: { value: 'Saved Brand' } });
    const saved = { ...state(), draftRevision: 1, draft: { ...DEFAULT_MOBILE_DESIGN, brandName: 'Saved Brand' } };
    vi.mocked(changeMobileDesignAction).mockResolvedValueOnce({ ok: true, state: saved });
    fireEvent.click(ui.getByRole('button', { name: 'Save draft' }));
    await ui.findByText('Draft saved. Employees still see the published version.');
    fireEvent.click(ui.getByRole('button', { name: 'Publish' }));
    expect(changeMobileDesignAction).toHaveBeenCalledTimes(1);
    vi.mocked(changeMobileDesignAction).mockResolvedValueOnce({ ok: true, state: { ...saved, draftRevision: 2, releases: [{ revision: 1, config: saved.draft, publishedAt: '2026-10-10T02:00:00Z' }] } });
    fireEvent.click(ui.getByRole('button', { name: 'Publish for this tenant' }));
    await ui.findByText('Published for this tenant.');
    expect(changeMobileDesignAction).toHaveBeenLastCalledWith('publish', 1, undefined);
    fireEvent.click(ui.getByRole('button', { name: 'Versions' })); expect(ui.getByText('Version 1')).toBeTruthy();
  });
  it('preserves an unsaved draft on conflict and keeps every leave type in either layout', async () => {
    const ui = mount();
    fireEvent.click(ui.getByRole('button', { name: 'Move Leave up' }));
    expect([...ui.container.querySelectorAll('[data-home-section]')].map(e => e.getAttribute('data-home-section'))).toEqual(['clock', 'leave', 'tasks', 'team']);
    vi.mocked(changeMobileDesignAction).mockResolvedValueOnce({ ok: false, error: 'conflict' });
    fireEvent.click(ui.getByRole('button', { name: 'Save draft' }));
    await ui.findByText('This draft changed in another session. Reload before continuing.');
    expect(ui.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Leave' }));
    expect(ui.getAllByRole('button', { name: /^Leave \d/ })).toHaveLength(6);
    fireEvent.change(ui.getByRole('combobox', { name: 'Leave balances' }), { target: { value: 'list' } });
    expect(ui.getAllByRole('button', { name: /^Leave \d/ })).toHaveLength(6);
  });
  for (const locale of Object.keys(catalogues) as (keyof typeof catalogues)[]) it(`renders the builder at 390px in ${locale}`, () => {
    const ui = mount(state(), locale, 390);
    expect(ui.getByRole('heading', { name: catalogues[locale].mobilePreview.builder.title })).toBeTruthy();
    const phone = ui.container.querySelector('[aria-busy]') as HTMLElement;
    expect(ui.container.scrollWidth).toBeLessThanOrEqual(ui.container.clientWidth + 1);
    expect(phone.clientWidth).toBeGreaterThan(280); expect(phone.scrollWidth).toBeLessThanOrEqual(phone.clientWidth + 1);
    expect(ui.container.textContent).not.toContain('mobilePreview.builder.');
  });
});
