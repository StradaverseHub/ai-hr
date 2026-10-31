/** The "Offline clocking" company settings card (Attendance › Schedule): the not-available state, disabled fields
 * without the draft columns, the stored values, the phones-offline and waiting counts, and the plain validation message a refused save
 * returns, in every locale the catalogue ships. The action is replaced; its own wiring is test/offline-claim-actions. */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';
const save = vi.hoisted(() => vi.fn());
vi.mock('../app/(app)/admin/attendance-policy/offline-clocking-actions', () => ({ saveOfflineClockingAction: save }));
import { OfflineClockingCard } from '../app/(app)/admin/attendance-policy/offline-clocking-card';
import type { OfflineClockingCompanySettings } from '../app/(app)/admin/attendance-policy/offline-clocking-data';

const company = (over: Partial<OfflineClockingCompanySettings> = {}): OfflineClockingCompanySettings => ({
  companyId: '5d2c1b0a-7e6f-4a3b-8c9d-0e1f2a3b4c5d', companyName: 'Fictional Sdn Bhd', available: true, columns: true, canEdit: true,
  enabled: false, maxProvenWindowSeconds: 900, waiting: 3, phonesOffline: 2, ...over,
});
const show = (companies: OfflineClockingCompanySettings[], messages: typeof en = en, locale = 'en') =>
  render(<NextIntlClientProvider locale={locale} messages={messages} onError={(error) => { throw error; }}><OfflineClockingCard companies={companies} /></NextIntlClientProvider>);
const L = en.offlineClocking.settings;

describe('OfflineClockingCard', () => {
  it('shows the stored setting with no status badge when offline clocking is available here', () => {
    show([company({ enabled: true, maxProvenWindowSeconds: 1800 })]);
    expect(screen.getByRole('heading', { name: L.title })).toBeVisible();
    expect(screen.getByText(L.description)).toBeVisible();
    expect(screen.queryByText(L.notAvailable)).toBeNull();
    expect(screen.getByRole('checkbox', { name: L.enable })).toBeChecked();
    expect(screen.getByRole('spinbutton', { name: L.thresholdLabel })).toHaveValue(30);
    expect(screen.getByText(L.help)).toBeVisible();
    expect(screen.getByText('2 phones offline now · 3 punches waiting for review')).toBeVisible();
    expect(screen.getByRole('button', { name: L.save })).toBeEnabled();
  });

  it('says "Not available on this server" and disables the fields without the draft columns', () => {
    show([company({ available: false, columns: false, waiting: null, phonesOffline: null })]);
    expect(screen.getByText(L.notAvailable)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: L.enable })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: L.thresholdLabel })).toBeDisabled();
    expect(screen.getByRole('button', { name: L.save })).toBeDisabled();
    expect(screen.queryByText(/waiting for review/)).toBeNull();
    expect(screen.queryByText(/offline now/)).toBeNull();
  });

  it('hides the phones part when the count is unavailable, and uses the singular for one', () => {
    const { unmount } = show([company({ phonesOffline: null })]);
    expect(screen.getByText('3 punches waiting for review')).toBeVisible();
    expect(screen.queryByText(/offline now/)).toBeNull();
    unmount();
    show([company({ phonesOffline: 1, waiting: 1 })]);
    expect(screen.getByText('1 phone offline now · 1 punch waiting for review')).toBeVisible();
  });

  it('shows zero phones offline rather than hiding a real zero', () => {
    show([company({ phonesOffline: 0, waiting: 0 })]);
    expect(screen.getByText('0 phones offline now · 0 punches waiting for review')).toBeVisible();
  });

  it('keeps the setting editable but badged when the columns exist and the deployment is not active', () => {
    show([company({ available: false })]);
    expect(screen.getByText(L.notAvailable)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: L.enable })).toBeEnabled();
  });

  it('shows the plain validation message a refused save returns, keeping what was typed', async () => {
    save.mockResolvedValueOnce({ ok: false, error: 'minutesRange' });
    show([company()]);
    const minutes = screen.getByRole('spinbutton', { name: L.thresholdLabel });
    fireEvent.change(minutes, { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('checkbox', { name: L.enable }));
    fireEvent.submit(minutes.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(L.errors.minutesRange);
    const posted = save.mock.calls[0][1] as FormData;
    expect(posted.get('maxProvenWindowMinutes')).toBe('2000');
    expect(posted.get('enabled')).toBe('on');
    expect(posted.get('companyId')).toBe(company().companyId);
    await waitFor(() => expect(minutes).toHaveValue(2000));
    expect(screen.getByRole('checkbox', { name: L.enable })).toBeChecked();
  });

  it('names each company when the viewer administers several', () => {
    show([company(), company({ companyId: '6e3d2c1b-8f7a-4b4c-9d0e-1f2a3b4c5d6e', companyName: 'Second Fictional Bhd', available: false })]);
    expect(screen.getByRole('heading', { name: 'Fictional Sdn Bhd' })).toBeVisible();
    const second = screen.getByRole('heading', { name: 'Second Fictional Bhd' }).closest('form')!;
    expect(within(second as HTMLElement).getByText(L.notAvailable)).toBeVisible();
  });

  for (const [locale, messages] of [['en', en], ['ms', ms], ['ta', ta], ['th', th], ['vi', viMessages], ['zh', zh]] as const) {
    it(`${locale}: renders every string of the card from the catalogue`, () => {
      show([company({ available: false })], messages as typeof en, locale);
      const t = createTranslator({ locale, messages: messages as typeof en, namespace: 'offlineClocking.settings' });
      expect(screen.getByRole('heading', { name: t('title') })).toBeVisible();
      expect(screen.getByText(t('notAvailable'))).toBeVisible();
      expect(screen.getByRole('checkbox', { name: t('enable') })).toBeVisible();
      expect(screen.getByText(`${t('phonesOffline', { count: 2 })} · ${t('waiting', { count: 3 })}`)).toBeVisible();
      expect(t('phonesOffline', { count: 2 })).toContain('2');
    });
  }
});
