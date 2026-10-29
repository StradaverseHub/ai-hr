/**
 * M13 (D14) — the shipped native profile screens (mobile/lib/profile.tsx, mobile/lib/profile-edit.tsx), with only
 * native views, transport, navigation and identity injected. The server's rules are tested in
 * test/mobile-v2-profile.test.ts; this file pins what the screens do with its answers: only editable fields take
 * input, only CHANGED fields are sent, each with the baseline captured when it was first edited, a send happens only
 * after a confirmation, a lost answer is retried with the SAME reference, a stale refusal drops exactly those edits,
 * offline offers no command, web-only parts open on the company's own origin, and request status renders as sent.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_DESIGN, mobilePalette } from '../lib/mobile-design';
import * as errors from '../mobile/lib/errors';
import * as v2profile from '../lib/mobile-api/v2/profile';

function load(path: string, ports: Record<string, unknown>) {
  const module = { exports: {} as any };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, AbortController, Date, Error, Intl, require: (id: string) => { if (id in ports) return ports[id]; throw new Error('Missing port ' + id + ' for ' + path); } });
  return module.exports;
}
const field = (over: Record<string, unknown> = {}) => ({
  fieldId: 'f.phone', label: 'Mobile phone', section: 'contact', kind: 'phone', value: null, valueLabel: null, baseline: 'sha256:phone',
  editable: true, readOnlyReason: null, applies: 'immediately', required: false, options: null, pending: false, ...over,
});
const FIELDS = () => [
  field(),
  field({ fieldId: 'f.pref', label: 'Preferred name', section: 'personal', kind: 'text', value: 'Old', baseline: 'sha256:pref', applies: 'after_approval', pending: true }),
  field({ fieldId: 'f.first', label: 'First name', section: 'personal', kind: 'text', value: 'Ali', baseline: 'sha256:first', editable: false, readOnlyReason: 'field_closed', applies: 'after_approval' }),
  field({ fieldId: 'f.gender', label: 'Gender', section: 'personal', kind: 'choice', value: 'male', valueLabel: 'Male', baseline: 'sha256:gender', applies: 'after_approval', options: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }] }),
  field({ fieldId: 'f.home', label: 'Home phone', kind: 'phone', value: '031', baseline: 'sha256:home', applies: 'after_approval' }),
];
const found = (fields = FIELDS(), web: Record<string, string | null> = {}) => ({ outcome: 'found', workspace: {
  employmentId: 'own-emp', fields, web: { addresses: '/me?tab=profile&employmentId=own-emp', family: null, bankStatutory: '/me?tab=bankStatutory&employmentId=own-emp', requests: '/me?tab=others&employmentId=own-emp', ...web },
} });

function fixture() {
  let seq = 0;
  const store = { answers: {} as Record<string, { data: unknown; error: Error | null; loading: boolean }>, listeners: new Set<() => void>() };
  const reload = vi.fn();
  const set = (path: string, value: { data?: unknown; error?: Error | null; loading?: boolean }) => {
    const empty = { data: null as unknown, error: null as Error | null, loading: false };
    store.answers[path] = { ...empty, ...store.answers[path], ...value };
    act(() => { store.listeners.forEach((l) => l()); });
  };
  function useApiV2(path: string) {
    const [, force] = React.useState(0);
    React.useEffect(() => { const l = () => force((n) => n + 1); store.listeners.add(l); return () => { store.listeners.delete(l); }; }, []);
    const a = store.answers[path] ?? { data: null, error: null, loading: true };
    return { ...a, reload: () => reload(path) };
  }
  const apiPostV2 = vi.fn<(...a: any[]) => Promise<any>>();
  const push = vi.fn(), back = vi.fn(), alert = vi.fn(), openURL = vi.fn(async () => true), signOut = vi.fn();
  const View = ({ children, accessibilityLabel }: any) => <div aria-label={accessibilityLabel}>{children}</div>;
  const Text = ({ children, accessibilityRole }: any) => <span role={accessibilityRole === 'alert' ? 'alert' : undefined}>{children}</span>;
  const native = {
    View, Text, Alert: { alert }, Linking: { openURL }, Platform: { OS: 'ios' },
    Pressable: (p: any) => <button disabled={p.disabled} role={p.accessibilityRole ?? 'button'} aria-label={p.accessibilityLabel} aria-checked={p.accessibilityState?.checked} onClick={p.onPress}>{p.children}</button>,
    TextInput: (p: any) => <input aria-label={p.accessibilityLabel} disabled={p.editable === false} value={p.value} onChange={(e) => p.onChangeText(e.target.value)} />,
  };
  const ui = {
    Button: (p: any) => <button disabled={p.disabled} aria-label={p.accessibilityLabel} onClick={p.onPress}>{p.title}</button>,
    Card: View, Muted: Text, Title: Text, SectionLabel: Text, Row: ({ label, value }: any) => <p>{label}: {value}</p>,
    Screen: ({ children, onRefresh }: any) => <div><button onClick={onRefresh}>refresh</button>{children}</div>,
    LoadState: (p: any) => p.error ? <div>{'error:' + p.error.name}{p.hasData && ' staleData'}</div> : p.loading ? <span role="progressbar" /> : null,
  };
  const t = (k: string, v?: Record<string, unknown>) => (v ? `${k} ${Object.values(v).join('|')}` : k);
  const base = {
    react: React, 'react/jsx-runtime': jsx, 'react-native': native, './ui': ui, './errors': errors,
    './auth': { authGeneration: () => 1, assertAuthGeneration: () => {} },
    './config': { config: { apiUrl: 'https://hr.test' }, identityNamespace: () => 'company' },
    './i18n': { appLocale: () => 'en', intlLocale: () => 'en-MY', t },
    './api': { useApiV2, apiPostV2, useApi: () => ({ data: null, error: null, loading: false, reload: () => {} }) },
    './session': { useSession: () => ({ employmentId: 'own-emp', signOut }) },
    './design': { DesignText: Text, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'dark') }) },
    'expo-router': { router: { push, back } },
    '../../lib/mobile-api/v2/profile': v2profile,
  };
  const profile = load('mobile/lib/profile.tsx', base);
  const edit = load('mobile/lib/profile-edit.tsx', {
    ...base, './profile': profile,
    'expo-crypto': { randomUUID: () => `${String(++seq).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb` },
    '@react-native-community/datetimepicker': { default: () => null, DateTimePickerAndroid: { open: vi.fn() } },
  });
  const confirm = async (index = 0) => { const buttons = alert.mock.calls[index][2]; await act(async () => { buttons[1].onPress(); }); };
  return { ...profile, ...edit, set, reload, apiPostV2, push, alert, openURL, confirm };
}
afterEach(cleanup);

describe('my profile', () => {
  it('shows the server’s values and pending note, links to the edit form, and opens web-only parts on the company origin', async () => {
    const f = fixture();
    render(<f.ProfileScreen />);
    f.set('v2/profile', { data: found() });
    // Each field reads as one line to assistive technology: its label, its value and any pending change.
    expect(screen.getByLabelText(/^Mobile phone: profileNotRecorded/)).toBeTruthy();
    expect(screen.getByLabelText(/^Gender: Male/)).toBeTruthy();
    // The pending change is marked on its row, and once at the top of the profile.
    expect(screen.getAllByLabelText(/\. profilePendingNote$/)).toHaveLength(1);
    expect(screen.getAllByText('profilePendingNote')).toHaveLength(2);
    fireEvent.click(screen.getByText('profileRequestChange'));
    expect(f.push).toHaveBeenCalledWith('/profile/edit');
    fireEvent.click(screen.getByText('profileRequestsOpen'));
    expect(f.push).toHaveBeenCalledWith('/profile/requests');
    fireEvent.click(screen.getByText('profileWebAddresses'));
    expect(f.openURL).toHaveBeenCalledWith('https://hr.test/me?tab=profile&employmentId=own-emp');
    expect(screen.queryByText('profileWebFamily')).toBeNull();
    expect(f.apiPostV2).not.toHaveBeenCalled();
  });

  it('fields sharing a label are told apart: grouped under the web section titles, qualified wherever read out of the group', async () => {
    const contact = { key: 'Contact and permanent address', title: 'Contact & address' };
    const corr = { key: 'Correspondence address', title: 'Correspondence address' };
    const grouped = () => [
      field({ fieldId: 'f.pref', label: 'Preferred name', section: 'personal', kind: 'text', value: 'Old', baseline: 'sha256:pref', group: { key: 'Personal details', title: 'Personal details' } }),
      field({ fieldId: 'f.phone', label: 'Mobile Phone Number', value: '0121', group: contact }),
      field({ fieldId: 'f.cphone', label: 'Mobile Phone Number', value: '0999', baseline: 'sha256:cphone', applies: 'after_approval', group: corr }),
    ];
    for (const x of grouped()) expect(v2profile.ProfileFieldV2.safeParse(x).success).toBe(true);
    const f = fixture();
    const { container, unmount } = render(<f.ProfileScreen />);
    f.set('v2/profile', { data: found(grouped()) });
    const text = container.textContent!;
    const order = ['Personal details', 'Preferred nameOld', 'Contact & address', 'Mobile Phone Number0121', 'Correspondence address', 'Mobile Phone Number0999'].map((x) => text.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(screen.queryByText('profileContact')).toBeNull();
    unmount();

    const g = fixture();
    render(<g.ProfileEditScreen />);
    g.set('v2/profile', { data: found(grouped()) });
    // Two inputs, two distinct accessible names; a label no other field shares stays as it is.
    fireEvent.change(screen.getByRole('textbox', { name: 'Mobile Phone Number — Correspondence address' }), { target: { value: '0888' } });
    expect(screen.getByRole('textbox', { name: 'Mobile Phone Number — Contact & address' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Preferred name' })).toBeTruthy();
    fireEvent.click(screen.getByText('profileReview'));
    expect(g.alert.mock.calls[0][1]).toBe('profileConfirmLine Mobile Phone Number — Correspondence address|0999|0888|profileAppliesApproval');
    g.apiPostV2.mockResolvedValueOnce({ outcome: 'submitted', saved: [], waiting: ['f.cphone'], requestId: null });
    await g.confirm();
    expect((await screen.findByRole('alert')).textContent).toBe('profileSentForApproval Mobile Phone Number — Correspondence address');
  });

  it('a server without groups still renders the coarse sections, personal first', () => {
    const f = fixture();
    const { container } = render(<f.ProfileScreen />);
    f.set('v2/profile', { data: found() });
    const text = container.textContent!;
    expect(text.indexOf('profilePersonal')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('profilePersonal')).toBeLessThan(text.indexOf('profileContact'));
    expect(text.indexOf('profileContact')).toBeLessThan(text.indexOf('Mobile phoneprofileNotRecorded'));
  });

  it('a server path that is not relative is never opened', () => {
    const f = fixture();
    expect(f.profileWebUrl('//evil.example/x')).toBeNull();
    expect(f.profileWebUrl('https://evil.example/x')).toBeNull();
    expect(f.profileWebUrl('/me?tab=family')).toBe('https://hr.test/me?tab=family');
  });

  it('not found shows that, and no way to edit', () => {
    const f = fixture();
    render(<f.ProfileScreen />);
    f.set('v2/profile', { data: { outcome: 'refused', code: 'not_found' } });
    expect(screen.getByText('profileNotFound')).toBeTruthy();
    expect(screen.queryByText('profileRequestChange')).toBeNull();
  });
});

describe('request a change', () => {
  it('only editable fields take input; only CHANGED fields are sent, after confirmation, with the baseline captured at first edit', async () => {
    const f = fixture();
    render(<f.ProfileEditScreen />);
    f.set('v2/profile', { data: found() });
    // Read-only: shown with its reason, no input.
    expect(screen.getByText('First name: Ali')).toBeTruthy();
    expect(screen.getByText('profileReadOnlyField')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'First name' })).toBeNull();
    expect(screen.getByText('profileReview')).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Mobile phone' }), { target: { value: '0123' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Preferred name' }), { target: { value: 'New' } });
    fireEvent.click(screen.getByText('Male'));
    fireEvent.click(screen.getByRole('radio', { name: 'Female' }));
    // The server's baseline moves after the edits began (a refresh): the edits keep the one they were made against.
    f.set('v2/profile', { data: found(FIELDS().map((x) => (x.fieldId === 'f.phone' ? { ...x, baseline: 'sha256:phone-v2' } : x))) });
    fireEvent.click(screen.getByText('profileReview'));
    expect(f.alert).toHaveBeenCalledTimes(1);
    expect(f.alert.mock.calls[0][1]).toContain('profileConfirmLine Mobile phone|profileNotRecorded|0123|profileAppliesNow');
    expect(f.apiPostV2).not.toHaveBeenCalled();
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'submitted', saved: ['f.phone'], waiting: ['f.pref', 'f.gender'], requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
    await f.confirm();
    const [path, schema, body, params] = f.apiPostV2.mock.calls[0];
    expect(path).toBe('v2/profile/changes');
    expect(schema).toBe(v2profile.ProfileChangeResult);
    expect(params).toEqual({ employmentId: 'own-emp' });
    expect(body).toEqual({ requestId: expect.stringMatching(/-bbbb-/), changes: [
      { fieldId: 'f.phone', before: 'sha256:phone', value: '0123' },
      { fieldId: 'f.pref', before: 'sha256:pref', value: 'New' },
      { fieldId: 'f.gender', before: 'sha256:gender', value: 'female' },
    ] });
    expect(v2profile.ProfileChangeCommand.safeParse(body).success).toBe(true);
    expect((await screen.findByRole('alert')).textContent).toContain('profileSavedNow Mobile phone');
    expect(screen.getByRole('alert').textContent).toContain('profileSentForApproval Preferred name, Gender');
    expect(f.reload).toHaveBeenCalledWith('v2/profile');
  });

  it('clearing a field sends null; undoing an edit sends nothing for it', async () => {
    const f = fixture();
    render(<f.ProfileEditScreen />);
    f.set('v2/profile', { data: found() });
    // An empty field has nothing to clear.
    expect(screen.queryByRole('button', { name: 'profileClear: Mobile phone' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'profileClear: Preferred name' }));
    fireEvent.click(screen.getByRole('button', { name: 'profileClear: Home phone' }));
    fireEvent.click(screen.getByRole('button', { name: 'profileUndo: Home phone' }));
    fireEvent.click(screen.getByText('profileReview'));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'submitted', saved: [], waiting: ['f.pref'], requestId: null });
    await f.confirm();
    expect(f.apiPostV2.mock.calls[0][2].changes).toEqual([{ fieldId: 'f.pref', before: 'sha256:pref', value: null }]);
  });

  it('nothing changed: no confirmation and no send', () => {
    const f = fixture();
    render(<f.ProfileEditScreen />);
    f.set('v2/profile', { data: found() });
    fireEvent.change(screen.getByRole('textbox', { name: 'Preferred name' }), { target: { value: 'New' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Preferred name' }), { target: { value: 'Old' } });
    expect(screen.getByText('profileReview')).toBeDisabled();
    expect(f.alert).not.toHaveBeenCalled();
    expect(f.apiPostV2).not.toHaveBeenCalled();
  });

  it('a lost answer is retried with the SAME reference; a 4xx is an error, never uncertain', async () => {
    const f = fixture();
    render(<f.ProfileEditScreen />);
    f.set('v2/profile', { data: found() });
    fireEvent.change(screen.getByRole('textbox', { name: 'Mobile phone' }), { target: { value: '0123' } });
    fireEvent.click(screen.getByText('profileReview'));
    f.apiPostV2.mockRejectedValueOnce(new errors.UnavailableError());
    await f.confirm();
    await screen.findByText('profileUncertain');
    const body = f.apiPostV2.mock.calls[0][2];
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'submitted', saved: ['f.phone'], waiting: [], requestId: null });
    fireEvent.click(screen.getByText('profileRetry'));
    await screen.findByText(/profileSavedNow/);
    expect(f.apiPostV2).toHaveBeenCalledTimes(2);
    expect(f.apiPostV2.mock.calls[1][2]).toEqual(body);

    fireEvent.change(screen.getByRole('textbox', { name: 'Mobile phone' }), { target: { value: '0456' } });
    fireEvent.click(screen.getByText('profileReview'));
    f.apiPostV2.mockRejectedValueOnce(new errors.RequestRejectedError(400));
    await f.confirm(1);
    await screen.findByText('genericError');
    expect(screen.queryByText('profileUncertain')).toBeNull();
  });

  it('a stale refusal drops exactly the stale edits and says so; other refusals keep the edits', async () => {
    const f = fixture();
    render(<f.ProfileEditScreen />);
    f.set('v2/profile', { data: found() });
    fireEvent.change(screen.getByRole('textbox', { name: 'Mobile phone' }), { target: { value: '0123' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Preferred name' }), { target: { value: 'New' } });
    fireEvent.click(screen.getByText('profileReview'));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'refused', code: 'stale', fieldIds: ['f.pref'] });
    await f.confirm();
    expect((await screen.findByRole('alert')).textContent).toBe('profileRefusalStale Preferred name');
    expect((screen.getByRole('textbox', { name: 'Preferred name' }) as HTMLInputElement).value).toBe('Old');
    expect((screen.getByRole('textbox', { name: 'Mobile phone' }) as HTMLInputElement).value).toBe('0123');
    fireEvent.click(screen.getByText('profileReview'));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'refused', code: 'invalid', fieldIds: ['f.phone'] });
    await f.confirm(1);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('profileRefusalInvalid Mobile phone'));
    expect((screen.getByRole('textbox', { name: 'Mobile phone' }) as HTMLInputElement).value).toBe('0123');
    expect(f.apiPostV2.mock.calls[1][2].changes).toEqual([{ fieldId: 'f.phone', before: 'sha256:phone', value: '0123' }]);
  });

  it('offline: the form says it needs a connection and offers no command', () => {
    const f = fixture();
    render(<f.ProfileEditScreen />);
    f.set('v2/profile', { data: found(), error: new errors.NetworkUnavailableError() });
    expect(screen.getByText('profileNeedsConnection')).toBeTruthy();
    expect(screen.getByText(/staleData/)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Mobile phone' })).toBeDisabled();
    expect(screen.getByText('profileReview')).toBeDisabled();
    expect(f.alert).not.toHaveBeenCalled();
  });
});

describe('my change requests', () => {
  const request = (over: Record<string, unknown> = {}) => ({
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', status: 'rejected', submittedAt: '2026-10-01T02:00:00.000Z', decidedAt: '2026-10-02T02:00:00.000Z',
    decisionReason: 'Does not match the IC', lines: [{ key: 'f.pref', fieldId: 'f.pref', label: 'Preferred name', proposed: 'Ali', current: 'Not recorded', recordKind: null, newRecord: false }], ...over,
  });
  it('renders status, what was asked, today’s value and the reviewer’s note as sent', () => {
    const f = fixture();
    render(<f.ProfileRequestsScreen />);
    f.set('v2/profile/requests', { data: { outcome: 'found', requests: { items: [request(), request({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', status: 'pending', decidedAt: null, decisionReason: null, lines: [] })], truncated: true, web: '/me?tab=others' } } });
    expect(screen.getByText('profileStatusRejected')).toBeTruthy();
    expect(screen.getByText('profileStatusPending')).toBeTruthy();
    expect(screen.getByText('profileLineChange Preferred name|Ali')).toBeTruthy();
    expect(screen.getByText('profileLineCurrent Not recorded')).toBeTruthy();
    expect(screen.getByText('profileDecisionReason Does not match the IC')).toBeTruthy();
    expect(screen.getByText('profileRequestsTruncated')).toBeTruthy();
    fireEvent.click(screen.getByText('profileWebRequests'));
    expect(f.openURL).toHaveBeenCalledWith('https://hr.test/me?tab=others');
  });
  it('a policy that hides request history says so', () => {
    const f = fixture();
    render(<f.ProfileRequestsScreen />);
    f.set('v2/profile/requests', { data: { outcome: 'found', requests: { items: [], truncated: false, web: null } } });
    expect(screen.getByText('profileRequestsHidden')).toBeTruthy();
    expect(screen.queryByText('profileRequestsEmpty')).toBeNull();
  });
});
