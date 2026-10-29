/** ADR-0161 — System Configuration › Mobile app renders only re-verified data, in every locale. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';
vi.mock('next/image', () => ({ default: ({ unoptimized: _unoptimized, ...props }: Record<string, unknown>) => <img {...props}/> }));
import { MobileSetupPanel, type MobileSetupPanelView } from '../app/admin/settings/mobile-app/setup-panel';

afterEach(cleanup);
const catalogues = { en, ms, ta, th, vi: viMessages, zh };
const show = (node: ReactNode, locale: keyof typeof catalogues = 'en') => render(
  <NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error => { throw error; }}>{node}</NextIntlClientProvider>);
const LINK = 'https://hr.example.test/login/mobile-setup#setup=eyJrZXlJZCI6ImsifQ';
const QR = 'data:image/png;base64,iVBORw0KGgo=';
const ready: Extract<MobileSetupPanelView, { state: 'ready' }> = {
  state: 'ready', link: LINK, qr: QR, organization: 'acme-co', name: 'Acme 人事',
  expires: '28 October 2027', expiresSoon: false,
};

describe('Mobile app setup panel', () => {
  it('shows the link, QR, workplace, organization code, expiry and install steps, with no warning', () => {
    show(<MobileSetupPanel view={ready}/>);
    expect(screen.getByText(LINK)).toBeTruthy();
    expect(screen.getByRole('img', { name: en.mobileAppSetup.qrAlt })).toHaveAttribute('src', QR);
    for (const text of ['acme-co', 'Acme 人事', '28 October 2027', en.mobileAppSetup.stepInstall, en.mobileAppSetup.stepOpen, en.mobileAppSetup.stepConfirm])
      expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(en.mobileAppSetup.unavailable)).toBeNull();
  });
  it('warns inside the renewal window with the expiry date', () => {
    show(<MobileSetupPanel view={{ ...ready, expiresSoon: true } as MobileSetupPanelView}/>);
    expect(screen.getByRole('alert').textContent).toBe(en.mobileAppSetup.expiresSoon.replace('{date}', '28 October 2027'));
  });
  it('keeps the link usable when the QR could not be drawn', () => {
    show(<MobileSetupPanel view={{ ...ready, qr: null } as MobileSetupPanelView}/>);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(LINK)).toBeTruthy();
  });
  it('shows only the plain ask-your-provider state when nothing re-verified', () => {
    show(<MobileSetupPanel view={{ state: 'unavailable' }}/>);
    expect(screen.getByRole('status').textContent).toBe(en.mobileAppSetup.unavailable);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText(/mobile-setup#setup=/)).toBeNull();
    expect(screen.queryByText(en.mobileAppSetup.organizationCode)).toBeNull();
  });
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders every state without a missing or malformed message in %s', locale => {
    const copy = catalogues[locale].mobileAppSetup;
    const { unmount } = show(<MobileSetupPanel view={{ ...ready, expiresSoon: true } as MobileSetupPanelView}/>, locale);
    expect(screen.getByRole('alert').textContent).toContain('28 October 2027');
    expect(screen.getByText(copy.stepConfirm)).toBeTruthy();
    unmount();
    show(<MobileSetupPanel view={{ state: 'unavailable' }}/>, locale);
    expect(screen.getByRole('status').textContent).toBe(copy.unavailable);
    expect(Object.keys(copy).sort()).toEqual(Object.keys(en.mobileAppSetup).sort());
    expect(typeof catalogues[locale].nav.mobileWorkplaceSetup).toBe('string');
  });
});
