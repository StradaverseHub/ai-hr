/** ADR-0161 — the operator's mobile setup panel: status, Issue/Reissue and import, in every locale. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';
vi.mock('next/image', () => ({ default: ({ unoptimized: _unoptimized, ...props }: Record<string, unknown>) => <img {...props}/> }));
vi.mock('../app/operator/actions', () => ({ requestMobileSetupIssueAction: vi.fn(), importMobileSetupAction: vi.fn() }));
import { OperatorMobileSetupPanel, type OperatorMobileSetupView } from '../app/operator/mobile-setup-panel';

afterEach(cleanup);
const catalogues = { en, ms, ta, th, vi: viMessages, zh };
const copy = en.operatorMobileSetup;
const show = (view: OperatorMobileSetupView, locale: keyof typeof catalogues = 'en') => render(
  <NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error => { throw error; }}><OperatorMobileSetupPanel tenantId="00000000-0000-4000-8000-000000000001" view={view}/></NextIntlClientProvider>);
const LINK = 'https://hr.example.test/login/mobile-setup#setup=eyJrZXlJZCI6ImsifQ';
const none: OperatorMobileSetupView = {
  signs: true, state: 'none', reason: null, keyId: null, expires: null, expiresSoon: false, origin: null, organization: null,
  recorded: null, failure: null, link: null, qr: null, pending: false, requests: [],
};
const issued: OperatorMobileSetupView = {
  ...none, state: 'issued', keyId: 'aihr-test-2026-10', expires: '28 October 2027', origin: 'https://hr.example.test', organization: 'acme-co',
  recorded: '29 Oct 2026, 10:00 MYT', link: LINK, qr: 'data:image/png;base64,iVBORw0KGgo=',
  requests: [{ id: 'r1', action: 'issue', status: 'done', error: null, created: '29 Oct 2026, 09:59 MYT' }],
};
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('operator mobile setup panel', () => {
  it('offers Issue on a signing server when nothing is stored, and import always', () => {
    show(none);
    expect(screen.getByText(copy.state.none)).toBeTruthy();
    expect(button(copy.issue).disabled).toBe(false);
    expect(screen.getByText(copy.issueHelp)).toBeTruthy();
    const file = screen.getByLabelText(new RegExp(copy.importLabel.replace(/[()]/g, '\\$&'))) as HTMLInputElement;
    expect(file).toHaveAttribute('type', 'file');
    expect(file).toHaveAttribute('name', 'setupFile');
    const form = file.closest('form')!;
    expect(new FormData(form).get('tenantId')).toBe('00000000-0000-4000-8000-000000000001');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(copy.noRequests)).toBeTruthy();
  });
  it('refuses Issue on a server without the signing key and points to the import', () => {
    show({ ...none, signs: false });
    expect(button(copy.issue).disabled).toBe(true);
    expect(screen.getByText(copy.issueUnavailable)).toBeTruthy();
    expect(button(copy.import).disabled).toBe(false);
  });
  it('shows a usable setup: details, link, QR, Reissue and the request history', () => {
    show(issued);
    expect(screen.getByText(copy.state.issued)).toBeTruthy();
    for (const text of ['28 October 2027', 'aihr-test-2026-10', 'https://hr.example.test', 'acme-co', '29 Oct 2026, 10:00 MYT', LINK])
      expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByRole('img', { name: copy.qrAlt })).toHaveAttribute('src', issued.qr!);
    expect(button(copy.reissue).disabled).toBe(false);
    const history = screen.getByText(copy.history).parentElement!;
    expect(within(history).getByText(copy.action.issue)).toBeTruthy();
    expect(within(history).getByText(en.operator.status.done)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('explains an unusable stored setup and never shows its link', () => {
    show({ ...issued, state: 'invalid', reason: 'origin_mismatch', link: null, qr: null });
    expect(screen.getByRole('alert').textContent).toBe(copy.invalid.replace('{reason}', copy.reasons.origin_mismatch));
    expect(screen.queryByText(LINK)).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });
  it('warns inside the renewal window and reports the last failed attempt', () => {
    show({ ...issued, expiresSoon: true, failure: { reason: 'key_permissions', at: '29 Oct 2026, 08:00 MYT' } });
    expect(screen.getByRole('alert').textContent).toBe(copy.expiresSoon.replace('{date}', '28 October 2027'));
    expect(screen.getByText(copy.lastFailure.replace('{at}', '29 Oct 2026, 08:00 MYT').replace('{reason}', copy.reasons.key_permissions))).toBeTruthy();
  });
  it('locks both controls while a request is open and labels a refused request', () => {
    show({ ...issued, pending: true, requests: [
      { id: 'r2', action: 'import', status: 'pending', error: null, created: '29 Oct 2026, 11:00 MYT' },
      { id: 'r1', action: 'issue', status: 'failed', error: 'key_not_configured', created: '29 Oct 2026, 10:00 MYT' },
    ] });
    expect(screen.getByText(copy.pending)).toBeTruthy();
    expect(button(copy.reissue).disabled).toBe(true);
    expect(button(copy.import).disabled).toBe(true);
    expect(screen.getByText(copy.reasons.key_not_configured)).toBeTruthy();
    expect(screen.getAllByRole('listitem').map(item => item.textContent?.includes(copy.action.import))).toEqual([true, false]);
  });
  it('never renders a raw code for an unknown reason', () => {
    show({ ...none, requests: [{ id: 'r', action: 'issue', status: 'failed', error: 'future_code', created: 'x' }] });
    expect(screen.getByText(copy.reasons.unknown.replace('{code}', 'future_code'))).toBeTruthy();
  });
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders every state and every reason code in %s', locale => {
    const reasons = ['key_not_configured', 'key_path_invalid', 'key_unreadable', 'key_permissions', 'key_type', 'key_untrusted', 'anchor_validity',
      'hosting_invalid', 'profile_invalid', 'signing_unavailable', 'organization_unavailable', 'customer_unavailable', 'origin_unavailable',
      'unexpected', 'malformed', 'untrusted_key', 'bad_signature', 'invalid_profile', 'not_workplace', 'expired', 'not_yet_valid',
      'origin_mismatch', 'organization_mismatch'];
    const local = catalogues[locale].operatorMobileSetup as typeof copy & { reasons: Record<string, string> };
    for (const code of reasons) expect(typeof local.reasons[code], `${locale} ${code}`).toBe('string');
    for (const view of [none, { ...none, signs: false }, issued, { ...issued, state: 'imported' as const, expiresSoon: true },
      { ...issued, state: 'invalid' as const, reason: 'expired', link: null, failure: { reason: 'key_untrusted', at: 'x' }, pending: true,
        requests: reasons.map((code, i) => ({ id: String(i), action: 'issue' as const, status: 'failed' as const, error: code, created: 'x' })) }]) {
      const { unmount } = show(view, locale);
      expect(screen.getByText(local.title)).toBeTruthy();
      unmount();
    }
  });
});
