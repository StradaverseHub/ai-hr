/**
 * M08 — the shipped native approvals list and decision screen (mobile/lib/approval-decision.tsx, over the shipped
 * paged list), with only native views, transport, navigation and identity injected. The server's rules are tested
 * in test/mobile-v2-approvals.test.ts; this file pins what the screens do with its answers: native rows open the
 * detail and read-only kinds open the web, a decision runs only after a confirmation that repeats it, a rejection
 * needs a reason, per-date choice sends the approved dates, a lost answer is retried with the SAME reference, and a
 * refusal reloads the task and says why.
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
import * as v2tasks from '../lib/mobile-api/v2/tasks';
import * as v2claims from '../lib/mobile-api/v2/claims';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type Ports = Record<string, unknown>;
type Loaded = Record<string, any>;
function load(path: string, ports: Ports): Loaded {
  const module = { exports: {} as Loaded };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, AbortController, Date, Error, require: (id: string) => { if (id in ports) return ports[id]; throw new Error('Missing port ' + id + ' for ' + path); } });
  return module.exports;
}
const item = (over: Record<string, unknown> = {}) => ({ id: ID, kind: 'leave', subject: { name: 'Aisyah', code: null }, createdAt: '2026-10-28T01:00:00.000Z', nativeDecision: true, webPath: null, ...over });
const leaveTask = (over: Record<string, unknown> = {}) => ({ outcome: 'found', task: {
  kind: 'leave', id: ID, subject: { name: 'Aisyah', code: 'E001' }, createdAt: '2026-10-28T01:00:00.000Z', reasonRequiredToReject: true,
  leaveType: 'Annual', startDate: '2026-11-02', endDate: '2026-11-04', days: 3, durationType: 'full_day', fromTime: null, toTime: null, hours: null,
  employeeReason: 'Family trip', hasDocument: false, dates: [], expected: { stepIndex: 0 },
  teamCover: [{ name: 'Badrul', dates: [{ date: '2026-11-03', status: 'pending' }] }], ...over,
} });
const perDate = () => leaveTask({ expected: { stepIndex: null }, dates: [
  { date: '2026-11-02', days: 1, status: 'pending' }, { date: '2026-11-03', days: 1, status: 'pending' }, { date: '2026-11-04', days: 1, status: 'pending' }] });

function fixture(copy: { t?: (k: string, v?: Record<string, unknown>) => string; fmtDays?: (n: number | null) => string } = {}) {
  let seq = 0;
  const apiGetPage = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ items: [item()], nextCursor: null }));
  const apiGetV2 = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => leaveTask());
  const apiPostV2 = vi.fn<(...a: unknown[]) => Promise<unknown>>();
  const push = vi.fn(), back = vi.fn(), alert = vi.fn(), signOut = vi.fn(), openURL = vi.fn(async () => true);
  const View = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Text = ({ children, accessibilityRole }: { children?: React.ReactNode; accessibilityRole?: string }) => <span role={accessibilityRole === 'alert' ? 'alert' : undefined}>{children}</span>;
  const native = {
    View, Text, Alert: { alert }, Linking: { openURL },
    Pressable: (p: { disabled?: boolean; accessibilityRole?: string; accessibilityLabel?: string; accessibilityState?: { checked?: boolean }; onPress?: () => void; children?: React.ReactNode }) =>
      <button disabled={p.disabled} role={p.accessibilityRole ?? 'button'} aria-label={p.accessibilityLabel} aria-checked={p.accessibilityState?.checked} onClick={p.onPress}>{p.children}</button>,
    TextInput: (p: { accessibilityLabel?: string; value: string; onChangeText: (v: string) => void }) => <input aria-label={p.accessibilityLabel} value={p.value} onChange={(e) => p.onChangeText(e.target.value)} />,
    RefreshControl: (p: { onRefresh: () => void }) => <button onClick={p.onRefresh}>pull</button>,
    FlatList: (p: { refreshControl: React.ReactNode; ListHeaderComponent: React.ReactNode; ListEmptyComponent: React.ReactNode; ListFooterComponent: React.ReactNode; data: unknown[]; keyExtractor: (i: unknown) => string; renderItem: (a: { item: unknown }) => React.ReactNode }) =>
      <div>{p.refreshControl}{p.ListHeaderComponent}{p.data.length ? p.data.map((i) => <div key={p.keyExtractor(i)}>{p.renderItem({ item: i })}</div>) : p.ListEmptyComponent}{p.ListFooterComponent}</div>,
  };
  const ui = {fmtMoney:(v:string)=>v,InfoNote:({short,detail}:any)=><span><span>{short}</span><span>{detail}</span></span>,HeaderBack:()=><button aria-label="back">‹</button>,ListRow:({label,value,onPress}:any)=><button aria-label={value?`${label}, ${value}`:label} onClick={onPress}>{label}{value?`: ${value}`:''}</button>,
    Button: (p: { disabled?: boolean; onPress: () => void; title: string }) => <button disabled={p.disabled} onClick={p.onPress}>{p.title}</button>,
    Card: View, Muted: Text, Title: Text, Row: ({ label, value }: { label: string; value: string }) => <p>{label}: {value}</p>,
    Screen: ({ children, onRefresh }: { children?: React.ReactNode; onRefresh?: () => void }) => <div><button onClick={onRefresh}>refresh</button>{children}</div>,
    LoadState: (p: { error: Error | null; hasData: boolean; loading: boolean; onRetry: () => void }) => p.error ? <div>{'error:' + p.error.name}{p.hasData && ' staleData'}<button onClick={p.onRetry}>retry-load</button></div> : p.loading ? <span role="progressbar" /> : null,
    fmtDays: copy.fmtDays ?? ((n: unknown) => (n == null ? '—' : String(n))),
  };
  const t = copy.t ?? ((k: string, v?: Record<string, unknown>) => (v ? `${k} ${Object.values(v).join('|')}` : k));
  const base: Ports = {
    react: React, 'react/jsx-runtime': jsx, 'react-native': native, './ui': ui, './errors': errors,
    './auth': { authGeneration: () => 1, assertAuthGeneration: () => {} },
    './config': { config: { apiUrl: 'https://hr.test' }, identityNamespace: () => 'company' },
    './i18n': { appLocale: () => 'en', intlLocale: () => 'en-MY', t },
  };
  const api = { apiGetPage, apiGetV2, apiPostV2, v2Page: (path: string) => ({ kind: 'page', path, schema: null }) };
  const paged = load('mobile/lib/paged-list.tsx', { ...base, './api': api });
  // M11 (D12): the claim pieces are exercised in test/mobile-claims.dom.test.tsx; inert here.
  const claimParts = { ClaimAnswers: () => null, ReceiptLink: () => null, claimMoney: (a: string | null, c: string | null) => [c, a].filter(Boolean).join(' ') };
  const screens = load('mobile/lib/approval-decision.tsx', {
    ...base, './api': api, './paged-list': paged, '../../lib/mobile-api/v2/tasks': v2tasks,
    './claim-parts': claimParts, '../../lib/mobile-api/v2/claims': v2claims,
    'react-native-safe-area-context': { SafeAreaView: View }, 'expo-router': { router: { push, back } },
    'expo-crypto': { randomUUID: () => `${String(++seq).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb` },
    './design': { DesignText: Text, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'dark') }) },
    './session': { useSession: () => ({ employmentId: 'own', signOut }) },
  });
  /** Press the confirming (second) button of the Nth alert. */
  const confirm = async (index = 0) => { const buttons = alert.mock.calls[index][2] as { onPress?: () => void }[]; await act(async () => { buttons[1].onPress?.(); }); };
  const posted = (n = 0) => apiPostV2.mock.calls[n] as [string, unknown, Record<string, unknown>];
  // Object.assign keeps the loaded module's index signature (an object spread drops it).
  return Object.assign({} as Loaded, screens, { apiGetPage, apiGetV2, apiPostV2, push, alert, openURL, signOut, confirm, posted });
}
afterEach(cleanup);

describe('approvals list', () => {
  it('a native kind opens its detail; a read-only kind shows an Open on web chip that opens the company origin', async () => {
    const f = fixture();
    f.apiGetPage.mockResolvedValueOnce({ items: [
      item(),
      // A resignation is read-only in the app.
      item({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'resignation', subject: { name: 'Chong', code: null }, nativeDecision: false, webPath: '/approvals?category=resignation&task=resignation&requestId=cccccccc-cccc-4ccc-8ccc-cccccccccccc#row' }),
    ], nextCursor: null });
    render(<f.ApprovalsScreen />);
    await screen.findByText('task_resignation');
    expect((f.apiGetPage.mock.calls[0][0] as { path: string }).path).toBe('v2/tasks');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'task_leave · Aisyah' }));
    expect(f.push).toHaveBeenCalledWith({ pathname: '/approvals/[kind]/[id]', params: { kind: 'leave', id: ID } });
    fireEvent.click(screen.getByRole('link', { name: 'openOnWeb: task_resignation · Chong' }));
    expect(f.openURL).toHaveBeenCalledWith('https://hr.test/approvals?category=resignation&task=resignation&requestId=cccccccc-cccc-4ccc-8ccc-cccccccccccc#row');
    expect(f.push).toHaveBeenCalledTimes(1);
    expect(f.apiPostV2).not.toHaveBeenCalled();
  });

  it('a claim approval is listed with its summary but opens on the web — no native detail, even though the server marks it native', async () => {
    const f = fixture();
    const sum = { label: 'Meals', from: '2026-10-20', to: '2026-10-20', days: null, amount: '42.50', currency: 'MYR' };
    // The server still sends claims as native (older installed apps decide them), so it sends no web path.
    const claim = item({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'claim', nativeDecision: true, webPath: null, summary: sum });
    expect(v2tasks.TaskItemV2.safeParse(claim).success).toBe(true);
    f.apiGetPage.mockResolvedValueOnce({ items: [claim], nextCursor: null });
    render(<f.ApprovalsScreen />);
    await screen.findByText('Meals · 2026-10-20 · MYR 42.50');
    expect(screen.queryByRole('button', { name: /^task_claim/ })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'openOnWeb: task_claim · Aisyah · Meals · 2026-10-20 · MYR 42.50' }));
    expect(f.openURL).toHaveBeenCalledWith('https://hr.test/approvals');
    expect(f.push).not.toHaveBeenCalled();
    expect(f.apiGetV2).not.toHaveBeenCalled();
  });

  it('never builds a path or a web URL from anything but a native kind, a UUID and a relative path', () => {
    const f = fixture();
    expect(() => f.taskPath('profile', ID)).toThrow();
    // Claims left the app (declutter round): no native claim detail or receipt path is ever built.
    expect(() => f.taskPath('claim', ID)).toThrow();
    expect(() => f.taskPath('claim', ID, 'document')).toThrow();
    expect(f.taskPath('leave', ID, 'decision')).toBe(`v2/tasks/leave/${ID}/decision`);
    expect(() => f.taskPath('leave', '../me')).toThrow();
    expect(f.taskPath('attendance', ID.toUpperCase(), 'decision')).toBe(`v2/tasks/attendance/${ID}/decision`);
    expect(f.webUrl('//evil.test/x')).toBeNull();
    expect(f.webUrl('https://evil.test')).toBeNull();
    expect(f.webUrl('/notices/x')).toBe('https://hr.test/notices/x');
  });
});

describe('approval detail', () => {
  it('shows who and what, the team cover and the confirm hint; approve runs only after a confirmation that repeats it', async () => {
    const f = fixture();
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    await screen.findByText('Aisyah · E001');
    expect(f.apiGetV2.mock.calls[0][0]).toBe(`v2/tasks/leave/${ID}`);
    expect(screen.getByText('approvalLeaveSummary Annual|leaveDateSpan 2026-11-02|2026-11-04|3')).toBeTruthy();
    expect(screen.getByText('approvalTeamCoverLine Badrul|approvalTeamPendingDate 2026-11-03')).toBeTruthy();
    expect(screen.getByText('approvalConfirmHint')).toBeTruthy();
    fireEvent.click(screen.getByText('approvalApprove'));
    expect(f.alert).toHaveBeenCalledTimes(1);
    expect(String(f.alert.mock.calls[0][1])).toContain('Aisyah|approvalLeaveSummary Annual');
    expect(f.apiPostV2).not.toHaveBeenCalled();
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'accepted', status: 'pending_next_step' });
    await f.confirm();
    await screen.findByText('approvalDoneNext');
    const [path, , body] = f.posted();
    expect(path).toBe(`v2/tasks/leave/${ID}/decision`);
    expect(body).toEqual({ requestId: expect.stringMatching(/-bbbb-/), decision: 'approve', expected: { stepIndex: 0 } });
  });

  it('a rejection needs a reason, and the confirmation repeats it', async () => {
    const f = fixture();
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    await screen.findByText('Aisyah · E001');
    expect(screen.getByText('approvalReject')).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'approvalReason' }), { target: { value: '   ' } });
    expect(screen.getByText('approvalReject')).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'approvalReason' }), { target: { value: ' Short staffed ' } });
    fireEvent.click(screen.getByText('approvalReject'));
    expect(String(f.alert.mock.calls[0][1])).toContain('Short staffed');
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'accepted', status: 'rejected' });
    await f.confirm();
    await screen.findByText('approvalDoneRejected');
    expect(f.posted()[2]).toEqual({ requestId: expect.any(String), decision: 'reject', reason: 'Short staffed', expected: { stepIndex: 0 } });
  });

  it('per-date: every pending date starts checked; unchecking one needs a reason and sends only the approved dates', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValue(perDate());
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    await screen.findByRole('checkbox', { name: '2026-11-03' });
    expect(screen.getAllByRole('checkbox').every((c) => c.getAttribute('aria-checked') === 'true')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: '2026-11-03' }));
    expect(screen.getByText('approvalApprove')).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'approvalReason' }), { target: { value: 'Stock take' } });
    fireEvent.click(screen.getByText('approvalApprove'));
    expect(String(f.alert.mock.calls[0][1])).toBe('approvalConfirmPartial Aisyah|2026-11-02, 2026-11-04|2026-11-03|Stock take');
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'accepted', status: 'approved' });
    await f.confirm();
    await screen.findByText('approvalDoneApproved');
    expect(f.posted()[2]).toEqual({ requestId: expect.any(String), decision: 'approve', dates: ['2026-11-02', '2026-11-04'], reason: 'Stock take', expected: { stepIndex: null } });
  });

  it('a lost answer is retried with the SAME reference; a 4xx is an error, never “uncertain”', async () => {
    const f = fixture();
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    fireEvent.click(await screen.findByText('approvalApprove'));
    f.apiPostV2.mockRejectedValueOnce(new errors.UnavailableError());
    await f.confirm();
    await screen.findByText('approvalUncertain');
    expect(screen.queryByText('approvalApprove')).toBeNull();
    const body = f.posted()[2];
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'accepted', status: 'approved' });
    fireEvent.click(screen.getByText('approvalRetry'));
    await screen.findByText('approvalDoneApproved');
    expect(f.apiPostV2).toHaveBeenCalledTimes(2);
    expect(f.posted(1)[2]).toEqual(body);

    const g = fixture();
    render(<g.ApprovalDetailScreen kind="leave" id={ID} />);
    fireEvent.click((await screen.findAllByText('approvalApprove')).at(-1)!);
    g.apiPostV2.mockRejectedValueOnce(new errors.RequestRejectedError(400));
    await g.confirm();
    await screen.findByText('genericError');
    expect(screen.queryByText('approvalUncertain')).toBeNull();
  });

  it('a refusal reloads the task and says why; the reloaded expected step is what the next decision sends', async () => {
    const f = fixture();
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    fireEvent.click(await screen.findByText('approvalApprove'));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'refused', code: 'stale_step' });
    f.apiGetV2.mockResolvedValueOnce(leaveTask({ expected: { stepIndex: 1 } }));
    await f.confirm();
    await screen.findByText('approvalRefusalStale');
    await waitFor(() => expect(f.apiGetV2).toHaveBeenCalledTimes(2));
    // While the reload is in flight the copy is not fresh, so the decision waits for it.
    await waitFor(() => expect(screen.getByText('approvalApprove')).not.toBeDisabled());
    fireEvent.click(screen.getByText('approvalApprove'));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'accepted', status: 'approved' });
    await f.confirm(1);
    await screen.findByText('approvalDoneApproved');
    expect(f.posted(1)[2]).toMatchObject({ expected: { stepIndex: 1 } });
    expect(f.posted(1)[2].requestId).not.toBe(f.posted(0)[2].requestId);
  });

  it('a task that is not the caller’s shows the refusal and no decision', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce({ outcome: 'refused', code: 'self_approval' });
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    await screen.findByText('approvalRefusalSelf');
    expect(screen.queryByText('approvalApprove')).toBeNull();
    expect(screen.queryByText('approvalReject')).toBeNull();
  });

  it('a cancellation asks no reason (the kernel records none); a stale copy offers no decision', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce({ outcome: 'found', task: {
      kind: 'leaveCancellation', id: ID, subject: { name: 'Aisyah', code: null }, createdAt: '2026-10-28T01:00:00.000Z', reasonRequiredToReject: false,
      leaveType: 'Annual', originalStart: '2026-11-02', originalEnd: '2026-11-04', cancelDates: ['2026-11-04'], requestedDays: 1, employeeReason: null, expected: { stepIndex: null },
    } });
    render(<f.ApprovalDetailScreen kind="leaveCancellation" id={ID} />);
    await screen.findByText('approvalCancellationSummary Annual|2026-11-04|1');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('approvalReject')).not.toBeDisabled();
    f.apiGetV2.mockRejectedValueOnce(new errors.NetworkUnavailableError());
    fireEvent.click(screen.getByText('refresh'));
    await screen.findByText(/staleData/);
    expect(screen.getByText('approvalReject')).toBeDisabled();
    expect(screen.getByText('approvalApprove')).toBeDisabled();
    expect(screen.getByText('approvalOnline')).toBeTruthy();
    expect(f.alert).not.toHaveBeenCalled();
  });
});

/**
 * The SHIPPED catalogue (mobile/lib/i18n.ts) with ui.tsx's fmtDays semantics: the defect lived in the contract between
 * a template ("{days} days") and a value that already carries its unit ("5 days"), which a key-echoing `t` cannot see.
 */
function realCopy(language: 'en' | 'ms') {
  const i18n = load('mobile/lib/i18n.ts', {
    'expo-localization': { getLocales: () => [{ languageCode: language }] },
    // No language chosen in Settings: the phone's language decides, as before. The four other catalogues are not read here.
    './preferences': { APP_LOCALES: ['en', 'ms', 'zh', 'ta', 'th', 'vi'], displayPrefs: () => ({ appearance: 'auto', language: 'auto' }) },
    './locales/zh': { default: {} }, './locales/ta': { default: {} }, './locales/th': { default: {} }, './locales/vi': { default: {} },
  });
  const t = i18n.t as (k: string, v?: Record<string, unknown>) => string;
  const fmtDays = (n: number | null) => (n == null ? '—' : t(n === 1 ? 'day' : 'days', { n: String(Math.round(n * 100) / 100) }));
  return { t, fmtDays };
}

describe('approval wording (real catalogue)', () => {
  const hospital = (over: Record<string, unknown> = {}) => leaveTask({ leaveType: 'Hospitalization Leave', startDate: '2026-11-02', endDate: '2026-11-06', days: 5, teamCover: null, ...over });

  for (const language of ['en', 'ms'] as const) {
    it(`a ${language} leave line names the days once`, async () => {
      const copy = realCopy(language);
      const f = fixture(copy);
      const line = f.taskLine(hospital().task);
      expect(line).toBe(`Hospitalization Leave · ${copy.t('leaveDateSpan', { from: '2026-11-02', to: '2026-11-06' })} · ${copy.fmtDays(5)}`);
      expect(line).not.toMatch(/(days|hari)\s+(days|hari)/);
      const cancel = f.taskLine({ kind: 'leaveCancellation', id: ID, subject: { name: 'A', code: null }, createdAt: '2026-10-28T01:00:00.000Z', reasonRequiredToReject: false,
        leaveType: 'Annual', originalStart: '2026-11-02', originalEnd: '2026-11-04', cancelDates: ['2026-11-04'], requestedDays: 1, employeeReason: null, expected: { stepIndex: null } });
      expect(cancel).not.toMatch(/(day|days|hari)\s+(day|days|hari)/);
      expect(cancel.endsWith(copy.fmtDays(1))).toBe(true);
    });
  }

  it('a half day says which half, as the web approver’s duration label does', () => {
    const copy = realCopy('en');
    const f = fixture(copy);
    expect(f.taskLine(hospital({ startDate: '2026-11-02', endDate: '2026-11-02', days: 0.5, durationType: 'half_day_pm' }).task)).toBe(`Hospitalization Leave · 2026-11-02 · 0.5 days · ${copy.t('halfPM')}`);
    expect(f.taskLine(hospital().task)).not.toContain(copy.t('halfAM'));
  });

  it('per-date: each date shows its own days (the web breakdown’s Days column)', async () => {
    const copy = realCopy('en');
    const f = fixture(copy);
    f.apiGetV2.mockResolvedValue(leaveTask({ expected: { stepIndex: null }, teamCover: null, dates: [
      { date: '2026-11-02', days: 1, status: 'pending' }, { date: '2026-11-03', days: 0.5, status: 'pending' }] }));
    render(<f.ApprovalDetailScreen kind="leave" id={ID} />);
    await screen.findByRole('checkbox', { name: '2026-11-03' });
    expect(screen.getByText(`2026-11-02 · ${copy.fmtDays(1)}`)).toBeTruthy();
    expect(screen.getByText(`2026-11-03 · ${copy.fmtDays(0.5)}`)).toBeTruthy();
  });
});

describe('attendance correction: what was recorded', () => {
  const correction = (over: Record<string, unknown> = {}) => ({ outcome: 'found', task: {
    kind: 'attendance', id: ID, subject: { name: 'Aisyah', code: null }, createdAt: '2026-10-28T01:00:00.000Z', reasonRequiredToReject: true,
    application: 'correction', date: '2026-10-21', proposedCheckIn: '09:00', proposedCheckOut: '18:00', plannedStart: null, plannedEnd: null,
    requestedOtMinutes: null, dayType: null, employeeReason: 'Forgot', hasAttachment: false, expected: { stageIndex: 0, participantSlot: null }, ...over,
  } });

  it('shows the original clock times beside the proposal, read-only', async () => {
    const f = fixture();
    const body = correction({ original: { state: 'recorded', checkIn: '08:00', checkOut: '17:00' }, proposedPunches: null });
    expect(v2tasks.TaskDetailResult.safeParse(body).success).toBe(true);
    f.apiGetV2.mockResolvedValue(body);
    render(<f.ApprovalDetailScreen kind="attendance" id={ID} />);
    await screen.findByText('approvalOriginalHeading');
    expect(screen.getByText('approvalOriginalTimes 08:00|17:00')).toBeTruthy();
    expect(screen.getByText('approvalCorrectionLine 2026-10-21 · 09:00–18:00')).toBeTruthy();
    expect(screen.queryByText('approvalProposedHeading')).toBeNull();
  });

  it('says when there was no record or nothing was captured; lists proposed clockings', async () => {
    for (const [state, text] of [['no_record', 'approvalOriginalNoRecord'], ['not_captured', 'approvalOriginalNotCaptured']] as const) {
      const f = fixture();
      f.apiGetV2.mockResolvedValue(correction({ proposedCheckIn: null, proposedCheckOut: null, original: { state, checkIn: null, checkOut: null },
        proposedPunches: [{ at: '08:55', direction: 'in' }, { at: '18:05', direction: 'out' }] }));
      render(<f.ApprovalDetailScreen kind="attendance" id={ID} />);
      await screen.findByText(text);
      expect(screen.getByText('approvalPunchLine 08:55|approvalPunchIn')).toBeTruthy();
      expect(screen.getByText('approvalPunchLine 18:05|approvalPunchOut')).toBeTruthy();
      cleanup();
    }
  });

  it('an older server (no original) renders as before', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValue(correction());
    render(<f.ApprovalDetailScreen kind="attendance" id={ID} />);
    await screen.findByText('approvalCorrectionLine 2026-10-21 · 09:00–18:00');
    expect(screen.queryByText('approvalOriginalHeading')).toBeNull();
  });
});

describe('list rows say which request', () => {
  it('two requests by one person read differently; a claim shows its amount; no summary, no extra line', async () => {
    const f = fixture();
    const sum = (over: Record<string, unknown>) => ({ label: null, from: null, to: null, days: null, amount: null, currency: null, ...over });
    const rows = [
      item({ summary: sum({ label: 'Annual', from: '2026-11-02', to: '2026-11-06', days: 5 }) }),
      item({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', summary: sum({ label: 'Annual', from: '2026-11-09', to: '2026-11-09', days: 1 }) }),
      item({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'claim', summary: sum({ label: 'Meals', from: '2026-10-20', to: '2026-10-20', amount: '42.50', currency: 'MYR' }) }),
      item({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 'attendance' }),
    ];
    for (const r of rows) expect(v2tasks.TaskItemV2.safeParse(r).success).toBe(true);
    f.apiGetPage.mockResolvedValueOnce({ items: rows, nextCursor: null });
    render(<f.ApprovalsScreen />);
    await screen.findByText('Annual · leaveDateSpan 2026-11-02|2026-11-06 · 5');
    expect(screen.getByText('Annual · 2026-11-09 · 1')).toBeTruthy();
    expect(screen.getByText('Meals · 2026-10-20 · MYR 42.50')).toBeTruthy();
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label')).filter((n): n is string => !!n && n.startsWith('task_'));
    expect(names).toContain('task_leave · Aisyah · Annual · leaveDateSpan 2026-11-02|2026-11-06 · 5');
    expect(names).toContain('task_leave · Aisyah · Annual · 2026-11-09 · 1');
    expect(names).toContain('task_attendance · Aisyah');
    expect(new Set(names).size).toBe(names.length);
  });
});
