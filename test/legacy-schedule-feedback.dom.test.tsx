import React from 'react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';

const state = vi.hoisted(() => ({
  pathname: '/admin/attendance/schedule', params: new URLSearchParams(),
  router: {replace: vi.fn()}, requireAdmin: vi.fn(), success: vi.fn(), error: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname, useSearchParams: () => state.params,
  useRouter: () => state.router,
  redirect: (url: string) => {throw new Error('REDIRECT:'+url);},
}));
vi.mock('../lib/authz', () => ({requireAdmin: state.requireAdmin}));
vi.mock('../lib/scope', () => ({scopedAdmin: async () => ({s: {}, scopeIds: []})}));
vi.mock('../core/read', () => ({allowedCompanies: async () => []}));
vi.mock('next-intl/server', () => ({getTranslations: async () => (key: string) => key}));
vi.mock('../components/attendance-settings-navigation', () => ({AttendanceSettingsNavigation: () => null}));
vi.mock('../app/(app)/admin/attendance-policy/registered-devices-card', () => ({RegisteredDevicesCard: () => null}));
vi.mock('sonner', () => ({toast: {success: state.success, error: state.error}}));

import {LegacyScheduleAnchor} from '../components/legacy-schedule-anchor';
import {ToastFromQuery} from '../components/ui/toast-trigger';
import OldWorkSchedulePage from '../app/(app)/admin/attendance-policy/schedule/page';
import RegisteredDevicesPage from '../app/(app)/admin/attendance/settings/registered-devices/page';
import {
  hasPendingLegacyScheduleRedirect, legacyScheduleAnchorRedirect, legacyWorkScheduleRedirect, legacyScheduleDestinationHash,
} from '../lib/legacy-schedule-redirect';

function location(path: string, query: string, hash: string) {
  state.pathname = path;
  state.params = new URLSearchParams(query);
  window.history.replaceState({}, '', path+(query?'?'+query:'')+hash);
}
function shell(children: React.ReactNode) {
  return <NextIntlClientProvider locale="en" messages={en}>{children}</NextIntlClientProvider>;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.requireAdmin.mockResolvedValue({});
  location('/admin/attendance/schedule', '', '');
});

describe('legacy Schedule feedback forwarding', () => {
  it.each([
    ['#company-policy-settings', '/admin/attendance/settings/company-policy'],
    ['#work-schedule-overtime', '/admin/attendance/settings/work-schedule-overtime'],
    ['#overtime-rates', '/admin/attendance/settings/work-schedule-overtime'],
    ['#backup-shift-coverage', '/admin/attendance/settings/work-schedule-overtime'],
    ['#registered-devices', '/admin/attendance/settings/registered-devices'],
  ])('keeps bounded feedback and supported %s at its canonical destination', (hash, target) => {
    const params = new URLSearchParams();
    params.append('error', '拒绝 & + #?');
    params.append('error', 'ignored second duplicate');
    params.append('toast', 'Saved / 已保存');
    for (const key of ['target', 'returnTo', 'token', 'companyId', 'policy']) params.set(key, 'https://evil.example/');
    const redirected = new URL(legacyScheduleAnchorRedirect(hash, params)!, 'https://local.example');
    expect(redirected.origin).toBe('https://local.example');
    expect(redirected.pathname).toBe(target);
    expect(redirected.hash).toBe(hash);
    expect(legacyScheduleDestinationHash(target, hash)).toBe(hash);
    expect(legacyScheduleDestinationHash('/unrelated', hash)).toBe('');
    expect([...redirected.searchParams]).toEqual([['error', '拒绝 & + #?'], ['toast', 'Saved / 已保存']]);
    expect(redirected.href).toContain('%26');
  });

  it('does not navigate for unknown/malicious anchors and drops invalid feedback deterministically', () => {
    for (const hash of ['', '#__proto__', '#constructor', '#https://evil.example', '#registered-devices?target=evil']) {
      expect(legacyScheduleAnchorRedirect(hash, {error: 'Refused'})).toBeNull();
    }
    for (const value of ['', '   ', 'x'.repeat(1025), 'bad\nmessage', 'bad\u0000message']) {
      expect(legacyWorkScheduleRedirect({error: value})).toBe('/admin/attendance/settings/work-schedule-overtime#work-schedule-overtime');
    }
    expect(new URL(legacyWorkScheduleRedirect({error: ['first', 'second'], toast: 'x'.repeat(1024)}), 'https://local.example').searchParams.get('error')).toBe('first');
    expect(legacyWorkScheduleRedirect(Object.create({error:'inherited'}))).not.toContain('?');
  });

  it.each([false, true])('forwards before feedback is consumed, irrespective of effect order (toast first=%s)', async toastFirst => {
    const params = new URLSearchParams({error:'Device revocation refused & retained',toast:'Saved + checked'});
    location('/admin/attendance/schedule', params.toString(), '#registered-devices');
    render(shell(toastFirst ? <><ToastFromQuery/><LegacyScheduleAnchor/></> : <><LegacyScheduleAnchor/><ToastFromQuery/></>));
    const destination='/admin/attendance/settings/registered-devices?'+params.toString()+'#registered-devices';
    expect(state.router.replace).toHaveBeenCalledExactlyOnceWith(destination);
    expect(state.success).not.toHaveBeenCalled();
    expect(state.error).not.toHaveBeenCalled();
    cleanup();
    location('/admin/attendance/settings/registered-devices', params.toString(), '#registered-devices');
    // Render the actual destination and its real ErrorBanner, alongside the root query consumer.
    const page=await RegisteredDevicesPage({searchParams:Promise.resolve({error:params.get('error')!})});
    render(shell(<>{page}<ToastFromQuery/></>));
    expect(screen.getByText('Device revocation refused & retained')).toBeVisible();
    expect(state.success).toHaveBeenCalledExactlyOnceWith('Saved + checked');
    expect(state.error).toHaveBeenCalledExactlyOnceWith('Device revocation refused & retained');
    expect(state.router.replace).toHaveBeenLastCalledWith('/admin/attendance/settings/registered-devices#registered-devices', {scroll:false});
    expect(state.router.replace).toHaveBeenCalledTimes(2);
    cleanup();
    location('/admin/attendance/settings/registered-devices', '', '#registered-devices');
    render(shell(<ToastFromQuery/>));
    expect(state.error).toHaveBeenCalledTimes(1);
    expect(state.success).toHaveBeenCalledTimes(1);
    expect(state.router.replace).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['/admin/attendance/schedule', '#unknown'],
    ['/unrelated', '#registered-devices'],
    ['/admin/attendance/schedule/new', '#registered-devices'],
  ])('preserves ordinary feedback consumption on %s %s', (path, hash) => {
    location(path, 'toast=Saved', hash);
    expect(hasPendingLegacyScheduleRedirect(path, hash)).toBe(false);
    render(shell(<ToastFromQuery/>));
    expect(state.success).toHaveBeenCalledExactlyOnceWith('Saved');
    expect(state.router.replace).toHaveBeenCalledExactlyOnceWith(path, {scroll:false});
  });

  it('server alias guards first, forwards allowlisted query feedback and keeps its established default anchor', async () => {
    await expect(OldWorkSchedulePage({searchParams:Promise.resolve({error:['first & error','second'],toast:'Saved + done',target:'https://evil.example'})})).rejects.toThrow('REDIRECT:/admin/attendance/settings/work-schedule-overtime?error=first+%26+error&toast=Saved+%2B+done#work-schedule-overtime');
    expect(state.requireAdmin).toHaveBeenCalledOnce();
    await expect(OldWorkSchedulePage()).rejects.toThrow('REDIRECT:/admin/attendance/settings/work-schedule-overtime#work-schedule-overtime');
    state.requireAdmin.mockRejectedValueOnce(new Error('Forbidden'));
    const then=vi.fn();
    await expect(OldWorkSchedulePage({searchParams:{then} as unknown as Promise<Record<string,string>>})).rejects.toThrow('Forbidden');
    expect(then).not.toHaveBeenCalled();
  });
});
