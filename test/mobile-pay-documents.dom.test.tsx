/**
 * M09 — the shipped native payslip and EA screens (mobile/lib/pay-documents.tsx, over the shipped paged list) and the
 * shipped protected-document custody (mobile/lib/protected-document.ts) on a fake file system, with only native
 * views, transport, navigation, the share sheet and identity injected. The server's rules are tested in
 * test/mobile-v2-documents.test.ts; this file pins what the app does with its answers.
 *
 * Pinned: the detail shows the server's rows exactly as supplied; a share asks first, opens nothing until the server
 * has acknowledged `confirmed`, downloads only then, records `completed` or `cancelled`, and deletes the temporary
 * file whichever way it ends; a document in an OS share survives the BACKGROUND sweep (Android) until the share
 * settles, but not the launch/logout/switch sweep; offline there is no content, only "Payslips need a connection".
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
import * as v2pay from '../lib/mobile-api/v2/pay';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EMP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CO1 = '11111111-1111-4111-8111-111111111111', CO2 = '22222222-2222-4222-8222-222222222222';
type Ports = Record<string, unknown>;
type Loaded = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function load(path: string, ports: Ports): Loaded {
  const module = { exports: {} as Loaded };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, AbortController, Date, Error, Intl, require: (id: string) => { if (id in ports) return ports[id]; throw new Error('Missing port ' + id + ' for ' + path); } });
  return module.exports;
}

/** A fake expo-file-system holding bytes in memory, with the folder listing the background sweep walks. */
function storage() {
  const files = new Map<string, Uint8Array>(), dirs = new Set<string>();
  const join = (parts: unknown[]) => parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
  class File {
    uri: string;
    constructor(...parts: unknown[]) { this.uri = join(parts); }
    get name() { return this.uri.slice(this.uri.lastIndexOf('/') + 1); }
    get exists() { return files.has(this.uri); }
    write(bytes: Uint8Array) { files.set(this.uri, bytes); }
    delete() { files.delete(this.uri); }
  }
  class Directory {
    uri: string;
    constructor(...parts: unknown[]) { this.uri = join(parts); }
    get exists() { return dirs.has(this.uri); }
    create() { dirs.add(this.uri); }
    delete() { dirs.delete(this.uri); for (const k of [...files.keys()]) if (k.startsWith(this.uri + '/')) files.delete(k); }
    list() { return [...files.keys()].filter((k) => k.startsWith(this.uri + '/')).map((k) => new File(k)); }
  }
  let n = 0;
  const documents = load('mobile/lib/protected-document.ts', {
    'expo-file-system': { Directory, File, Paths: { cache: 'cache' } },
    'expo-crypto': { randomUUID: () => `0000000${++n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` },
  });
  return { documents, files };
}

const pdfBytes = new TextEncoder().encode('%PDF-1.7 synthetic');
const indexItem = (over: Record<string, unknown> = {}) => ({ id: ID, employmentId: EMP, employeeCode: 'E001', companyId: CO1, company: 'Acme Sdn Bhd', period: '2026-09', cycleName: 'Monthly', runType: 'regular', runSeq: 1, ...over });
const found = () => ({ outcome: 'found', payslip: {
  id: ID, employmentId: EMP, employeeCode: 'E001', employee: 'Aisyah', company: 'Acme Sdn Bhd', period: '2026-09', periodLabel: 'September 2026', cycleLabel: 'Monthly', currency: 'MYR',
  sections: [
    { title: 'EARNINGS', rows: [{ label: 'Basic salary', quantity: null, sub: null, amount: '5432.10', text: null }, { label: 'Overtime', quantity: '10 hours', sub: 'MYR 36.045', amount: '360.45', text: null }], total: { label: 'Total earnings', amount: '5792.55' } },
    { title: 'DEDUCTIONS', rows: [{ label: 'PCB', quantity: null, sub: null, amount: '0.00', text: null }, { label: 'Other', quantity: null, sub: null, amount: null, text: '—' }], total: { label: 'Total deductions', amount: '1022.97' } },
  ],
  net: { label: 'Net pay', amount: '4769.58' },
} });

function fixture() {
  let seq = 0;
  const order: string[] = [];
  const fs = storage();
  const apiGetV2 = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => found());
  const apiPostV2 = vi.fn<(...a: unknown[]) => Promise<unknown>>(async (_path: unknown, _schema: unknown, body: unknown) => {
    const b = body as { stage: string; shareId: string };
    order.push(`post:${b.stage}`);
    return { outcome: 'recorded', shareId: b.shareId, stage: b.stage };
  });
  const apiDownload = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => {
    order.push('download');
    return { outcome: 'file', document: fs.documents.writeProtectedDocument(pdfBytes, 'application/pdf') };
  });
  const shareAsync = vi.fn<(uri: string) => Promise<void>>(async (uri: string) => { order.push(`share:${fs.files.has(uri) ? 'file' : 'missing'}`); });
  const isAvailableAsync = vi.fn(async () => true);
  const push = vi.fn(), back = vi.fn(), alert = vi.fn(), signOut = vi.fn();
  const View = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Text = ({ children, accessibilityRole }: { children?: React.ReactNode; accessibilityRole?: string }) => <span role={accessibilityRole === 'alert' ? 'alert' : undefined}>{children}</span>;
  const native = {
    View, Text, Alert: { alert },
    Pressable: (p: { accessibilityLabel?: string; onPress?: () => void; children?: React.ReactNode }) => <button aria-label={p.accessibilityLabel} onClick={p.onPress}>{p.children}</button>,
    RefreshControl: (p: { onRefresh: () => void }) => <button onClick={p.onRefresh}>pull</button>,
    FlatList: (p: { refreshControl: React.ReactNode; ListHeaderComponent: React.ReactNode; ListEmptyComponent: React.ReactNode; ListFooterComponent: React.ReactNode; data: unknown[]; keyExtractor: (i: unknown) => string; renderItem: (a: { item: unknown }) => React.ReactNode }) =>
      <div>{p.refreshControl}{p.ListHeaderComponent}{p.data.length ? p.data.map((i) => <div key={p.keyExtractor(i)}>{p.renderItem({ item: i })}</div>) : p.ListEmptyComponent}{p.ListFooterComponent}</div>,
  };
  const fmtMoney = (v: string) => { const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v); if (!m) return v; return `${m[1]}${m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${((m[3] ?? '') + '00').slice(0, 2)}`; };
  const ui = {InfoNote:({short,detail}:any)=><span><span>{short}</span><span>{detail}</span></span>,HeaderBack:()=><button aria-label="back">‹</button>,ListRow:({label,value,onPress}:any)=><button aria-label={value?`${label}, ${value}`:label} onClick={onPress}>{label}{value?`: ${value}`:''}</button>,
    Button: (p: { disabled?: boolean; onPress: () => void; title: string; accessibilityLabel?: string }) => <button disabled={p.disabled} aria-label={p.accessibilityLabel} onClick={p.onPress}>{p.title}</button>,
    Card: View, Muted: Text, Title: Text, Row: ({ label, value }: { label: string; value: string }) => <p>{label}: {value}</p>,
    Screen: ({ children, onRefresh }: { children?: React.ReactNode; onRefresh?: () => void }) => <div><button onClick={onRefresh}>refresh</button>{children}</div>,
    LoadState: (p: { error: Error | null; hasData: boolean; loading: boolean; onRetry: () => void }) => p.error ? <div>{'error:' + p.error.name}{p.hasData && ' staleData'}<button onClick={p.onRetry}>retry-load</button></div> : p.loading ? <span role="progressbar" /> : null,
    fmtMoney,
  };
  const t = (k: string, v?: Record<string, unknown>) => (v ? `${k} ${Object.values(v).join('|')}` : k);
  const base: Ports = {
    react: React, 'react/jsx-runtime': jsx, 'react-native': native, './ui': ui, './errors': errors,
    './auth': { authGeneration: () => 1, assertAuthGeneration: () => {} },
    './config': { config: { apiUrl: 'https://hr.test' }, identityNamespace: () => 'company' },
    './i18n': { appLocale: () => 'en', t },
  };
  const api = { apiGetV2, apiPostV2, apiDownload, apiGetPage: vi.fn(), v2Download: (path: string) => ({ kind: 'download', path, maxBytes: 10 * 1024 * 1024, types: ['application/pdf'] }) };
  const paged = load('mobile/lib/paged-list.tsx', { ...base, './api': api });
  const screens = load('mobile/lib/pay-documents.tsx', {
    ...base, './api': api, './paged-list': paged, './protected-document': fs.documents, '../../lib/mobile-api/v2/pay': v2pay,
    'react-native-safe-area-context': { SafeAreaView: View }, 'expo-router': { router: { push, back } },
    'expo-crypto': { randomUUID: () => `${String(++seq).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb` },
    'expo-sharing': { shareAsync, isAvailableAsync },
    './design': { DesignText: Text, TenantBrand: () => <span>tenant-brand</span>, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'dark') }) },
    './session': { useSession: () => ({ employmentId: EMP, signOut }) },
  });
  /** Press the confirming (second) button of the Nth alert. */
  const confirm = async (index = 0) => { const buttons = alert.mock.calls[index][2] as { onPress?: () => void }[]; await act(async () => { buttons[1].onPress?.(); }); };
  const dismiss = async (index = 0) => { const buttons = alert.mock.calls[index][2] as { onPress?: () => void }[]; await act(async () => { buttons[0].onPress?.(); }); };
  const bodies = () => apiPostV2.mock.calls.map((c) => c[2] as Record<string, unknown>);
  return Object.assign({} as Loaded, screens, { fs, order, apiGetV2, apiPostV2, apiDownload, shareAsync, isAvailableAsync, push, alert, signOut, confirm, dismiss, bodies });
}
afterEach(cleanup);

describe('payslip detail', () => {
  it('shows the server’s rows exactly as supplied, with the company and the run in the heading', async () => {
    const f = fixture();
    render(<f.PayslipDetailScreen id={ID.toUpperCase()} />);
    await screen.findByText('September 2026 · Monthly');
    expect(f.apiGetV2.mock.calls[0][0]).toBe(`v2/payslips/${ID}`);
    expect(f.apiGetV2.mock.calls[0][1]).toBe(v2pay.PayslipDetailResult);
    expect(screen.getByText('Acme Sdn Bhd')).toBeTruthy();
    for (const line of ['Basic salary: MYR 5,432.10', 'Overtime: MYR 360.45', '10 hours × MYR 36.045', 'Total earnings: MYR 5,792.55', 'PCB: MYR 0.00', 'Other: —', 'Total deductions: MYR 1,022.97', 'Net pay: MYR 4,769.58']) {
      expect(screen.getByText(line)).toBeTruthy();
    }
    expect(f.apiPostV2).not.toHaveBeenCalled();
    expect(f.apiDownload).not.toHaveBeenCalled();
  });

  it('a refused payslip says so and offers nothing to share; an invalid reference reads nothing', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce({ outcome: 'refused', code: 'not_found' });
    render(<f.PayslipDetailScreen id={ID} />);
    await screen.findByText('payNotFound');
    expect(screen.queryByText('payShare')).toBeNull();
    cleanup();
    const g = fixture();
    render(<g.PayslipDetailScreen id="../me" />);
    await screen.findByText('error:Error');
    expect(g.apiGetV2).not.toHaveBeenCalled();
    expect(() => g.payslipPath('../me')).toThrow();
  });
});

describe('sharing a document', () => {
  it('asks first, opens nothing until the server acknowledges, then downloads, shares, records completion and deletes the file', async () => {
    const f = fixture();
    render(<f.PayslipDetailScreen id={ID} />);
    fireEvent.click(await screen.findByText('payShare'));
    await waitFor(() => expect(f.alert).toHaveBeenCalledTimes(1));
    expect(String(f.alert.mock.calls[0][1])).toBe('payShareConfirmPayslip September 2026 · Monthly');
    expect(f.order, 'nothing happens before the confirmation').toEqual([]);
    await f.confirm();
    await waitFor(() => expect(f.order).toEqual(['post:confirmed', 'download', 'share:file', 'post:completed']));
    const [confirmed, completed] = f.bodies();
    expect(confirmed).toEqual({ requestId: expect.stringMatching(/-bbbb-/), shareId: expect.stringMatching(/-bbbb-/), document: { kind: 'payslip', id: ID }, stage: 'confirmed' });
    expect(completed).toEqual({ requestId: expect.any(String), shareId: confirmed.shareId, document: { kind: 'payslip', id: ID }, stage: 'completed' });
    expect(completed.requestId).not.toBe(confirmed.requestId);
    expect(f.apiPostV2.mock.calls[0][0]).toBe('v2/documents/share-events');
    expect((f.apiDownload.mock.calls[0][0] as { path: string }).path).toBe(`v2/payslips/${ID}/pdf`);
    expect(f.fs.files.size, 'the temporary file is gone').toBe(0);
    // No figure ever travels in a share event.
    expect(JSON.stringify(f.bodies())).not.toMatch(/5432|4769|amount|gross|net/i);
  });

  it('dismissing the confirmation records nothing and downloads nothing', async () => {
    const f = fixture();
    render(<f.PayslipDetailScreen id={ID} />);
    fireEvent.click(await screen.findByText('payShare'));
    await waitFor(() => expect(f.alert).toHaveBeenCalledTimes(1));
    await f.dismiss();
    expect(f.order).toEqual([]);
  });

  it('without an acknowledgement there is no download and no share sheet — offline, refused or garbled alike', async () => {
    for (const [answer, notice] of [
      [Promise.reject(new errors.NetworkUnavailableError()), 'payShareNeedsConnection'],
      [Promise.resolve({ outcome: 'refused', code: 'not_found' }), 'payShareRefused'],
      [Promise.resolve({ outcome: 'recorded', shareId: '99999999-9999-4999-8999-999999999999', stage: 'confirmed' }), 'payShareFailed'],
    ] as const) {
      answer.catch(() => {});
      const f = fixture();
      f.apiPostV2.mockImplementationOnce(() => answer);
      render(<f.PayslipDetailScreen id={ID} />);
      fireEvent.click(await screen.findByText('payShare'));
      await waitFor(() => expect(f.alert).toHaveBeenCalledTimes(1));
      await f.confirm();
      await screen.findByText(notice);
      expect(f.apiDownload).not.toHaveBeenCalled();
      expect(f.shareAsync).not.toHaveBeenCalled();
      expect(f.apiPostV2).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it('a failed share sheet records cancelled and still deletes the file; a refused download records cancelled and shares nothing', async () => {
    const f = fixture();
    f.shareAsync.mockImplementationOnce(async (uri: string) => { f.order.push(`share:${f.fs.files.has(uri) ? 'file' : 'missing'}`); throw new Error('dismissed'); });
    render(<f.PayslipDetailScreen id={ID} />);
    fireEvent.click(await screen.findByText('payShare'));
    await waitFor(() => expect(f.alert).toHaveBeenCalledTimes(1));
    await f.confirm();
    await waitFor(() => expect(f.order).toEqual(['post:confirmed', 'download', 'share:file', 'post:cancelled']));
    expect(f.fs.files.size).toBe(0);
    await screen.findByText('payShareFailed');
    cleanup();

    const g = fixture();
    g.apiDownload.mockImplementationOnce(async () => { g.order.push('download'); return { outcome: 'refused', code: 'not_found' }; });
    render(<g.PayslipDetailScreen id={ID} />);
    fireEvent.click(await screen.findByText('payShare'));
    await waitFor(() => expect(g.alert).toHaveBeenCalledTimes(1));
    await g.confirm();
    await waitFor(() => expect(g.order).toEqual(['post:confirmed', 'download', 'post:cancelled']));
    expect(g.shareAsync).not.toHaveBeenCalled();
    await screen.findByText('payShareRefused');
  });

  it('a lost closing answer is resent once under the SAME reference', async () => {
    const f = fixture();
    let closing = 0;
    f.apiPostV2.mockImplementation(async (_p: unknown, _s: unknown, body: unknown) => {
      const b = body as { stage: string; shareId: string };
      f.order.push(`post:${b.stage}`);
      if (b.stage !== 'confirmed' && closing++ === 0) throw new errors.UnavailableError();
      return { outcome: 'recorded', shareId: b.shareId, stage: b.stage };
    });
    render(<f.PayslipDetailScreen id={ID} />);
    fireEvent.click(await screen.findByText('payShare'));
    await waitFor(() => expect(f.alert).toHaveBeenCalledTimes(1));
    await f.confirm();
    await waitFor(() => expect(f.order).toEqual(['post:confirmed', 'download', 'share:file', 'post:completed', 'post:completed']));
    const bodies = f.bodies();
    expect(bodies[2]).toEqual(bodies[1]);
  });

  it('says so when the device cannot share, and records nothing', async () => {
    const f = fixture();
    f.isAvailableAsync.mockResolvedValueOnce(false);
    render(<f.PayslipDetailScreen id={ID} />);
    fireEvent.click(await screen.findByText('payShare'));
    await screen.findByText('payShareUnavailable');
    expect(f.alert).not.toHaveBeenCalled();
    expect(f.order).toEqual([]);
  });
});

describe('the background sweep and a document in an OS share (Android)', () => {
  it('spares the shared file while the share is open, deletes everything else, and deletes the file when the share settles', async () => {
    const f = fixture();
    const stray = f.fs.documents.writeProtectedDocument(pdfBytes, 'application/pdf');
    let settle!: () => void;
    let sharedUri = '';
    f.shareAsync.mockImplementationOnce((uri: string) => { sharedUri = uri; f.order.push('share:file'); return new Promise<void>((resolve) => { settle = resolve; }); });
    render(<f.PayslipDetailScreen id={ID} />);
    fireEvent.click(await screen.findByText('payShare'));
    await waitFor(() => expect(f.alert).toHaveBeenCalledTimes(1));
    await f.confirm();
    await waitFor(() => expect(f.order).toEqual(['post:confirmed', 'download', 'share:file']));
    // Android backgrounds the app for the share sheet: the background sweep runs now.
    f.fs.documents.sweepProtectedDocuments({ keepSharing: true });
    expect(f.fs.files.has(sharedUri), 'the file being shared survives the background sweep').toBe(true);
    expect(f.fs.files.has(stray.uri), 'every other leftover is still swept').toBe(false);
    await act(async () => { settle(); });
    await waitFor(() => expect(f.order).toEqual(['post:confirmed', 'download', 'share:file', 'post:completed']));
    expect(f.fs.files.has(sharedUri), 'deleted the moment the share settles').toBe(false);
  });

  it('the launch, logout and switch sweep (no exemption) still takes a file in an open share', async () => {
    const { documents, files } = storage();
    const doc = documents.writeProtectedDocument(pdfBytes, 'application/pdf');
    let settle!: () => void;
    const shared = documents.shareProtectedDocument(doc, () => new Promise<void>((resolve) => { settle = resolve; }));
    documents.sweepProtectedDocuments({ keepSharing: true });
    expect(files.has(doc.uri)).toBe(true);
    documents.sweepProtectedDocuments();
    expect(files.has(doc.uri)).toBe(false);
    settle();
    await shared;
    // After the share settles nothing is exempt any more: the background sweep takes everything again.
    const next = documents.writeProtectedDocument(pdfBytes, 'application/pdf');
    documents.sweepProtectedDocuments({ keepSharing: true });
    expect(files.has(next.uri)).toBe(false);
  });

  it('a share that throws still releases the exemption and deletes the file', async () => {
    const { documents, files } = storage();
    const doc = documents.writeProtectedDocument(pdfBytes, 'application/pdf');
    await expect(documents.shareProtectedDocument(doc, async () => { throw new Error('sheet failed'); })).rejects.toThrow('sheet failed');
    expect(files.has(doc.uri)).toBe(false);
    const next = documents.writeProtectedDocument(pdfBytes, 'application/pdf');
    documents.sweepProtectedDocuments({ keepSharing: true });
    expect(files.has(next.uri)).toBe(false);
  });
});

describe('the payslip index and offline', () => {
  it('groups by employer and year, names each run, and opens the detail', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce({ enabled: true, nextCursor: null, items: [
      indexItem(),
      indexItem({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', period: '2026-08', cycleName: null, runType: 'bonus', runSeq: 2 }),
      indexItem({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', companyId: CO2, company: 'Beta Bhd', employeeCode: 'B7' }),
      indexItem({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', period: '2025-12' }),
    ] });
    render(<f.PayslipsScreen />);
    await screen.findByText('Acme Sdn Bhd · 2026');
    // The same tenant header as every other screen.
    expect(screen.getByText('tenant-brand')).toBeTruthy();
    expect(f.apiGetV2.mock.calls[0][0]).toBe('v2/payslips');
    expect(f.apiGetV2.mock.calls[0][1]).toBe(v2pay.PayslipIndexV2);
    expect(screen.getByText('Beta Bhd · 2026')).toBeTruthy();
    expect(screen.getByText('Acme Sdn Bhd · 2025')).toBeTruthy();
    const month = (p: string) => new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${p}-01T00:00:00Z`));
    expect(screen.getByText(`${month('2026-08')} · payRunBonus · payRunSeq 2`)).toBeTruthy();
    expect(screen.getByText('payEmployeeCode B7')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `${month('2026-09')} · Monthly · Acme Sdn Bhd` }));
    expect(f.push).toHaveBeenCalledWith({ pathname: '/pay/[id]', params: { id: ID } });
    expect(screen.queryByText(/5432|MYR/)).toBeNull();
  });

  it('offline there is no content — only “Payslips need a connection” — and a failed refresh hides the rows it had', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce({ enabled: true, nextCursor: null, items: [indexItem()] });
    render(<f.PayslipsScreen />);
    await screen.findByText('Acme Sdn Bhd · 2026');
    f.apiGetV2.mockRejectedValueOnce(new errors.NetworkUnavailableError());
    fireEvent.click(screen.getByText('pull'));
    await screen.findByText('payNeedsConnection');
    expect(screen.queryByText('Acme Sdn Bhd · 2026')).toBeNull();
    cleanup();

    const g = fixture();
    g.apiGetV2.mockRejectedValueOnce(new errors.NetworkUnavailableError());
    render(<g.PayslipDetailScreen id={ID} />);
    await screen.findByText('payNeedsConnection');
    expect(screen.queryByText('payShare')).toBeNull();
    g.apiGetV2.mockResolvedValueOnce(found());
    fireEvent.click(screen.getByText('retry'));
    await screen.findByText('September 2026 · Monthly');
    expect(screen.queryByText('payNeedsConnection')).toBeNull();
  });

  it('says Payroll is off when the server says so', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce({ enabled: false, nextCursor: null, items: [] });
    render(<f.PayslipsScreen />);
    await screen.findByText('payrollOff');
  });
});

describe('EA forms', () => {
  it('lists years and employers; only an available form has Share, which runs the same acknowledged flow', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce({ enabled: true, items: [
      { employmentId: EMP, employeeCode: 'E001', companyId: CO1, company: 'Acme Sdn Bhd', year: '2025', available: true, isCurrent: true },
      { employmentId: EMP, employeeCode: 'E001', companyId: CO1, company: 'Acme Sdn Bhd', year: '2026', available: false, isCurrent: true },
    ] });
    render(<f.EaScreen />);
    await screen.findByText('2025 · Acme Sdn Bhd');
    expect(f.apiGetV2.mock.calls[0][0]).toBe('v2/ea');
    expect(screen.getByText('payEaNotAvailable')).toBeTruthy();
    expect(screen.getAllByText('payShare')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'payShare: 2025 · Acme Sdn Bhd' }));
    await waitFor(() => expect(f.alert).toHaveBeenCalledTimes(1));
    expect(String(f.alert.mock.calls[0][1])).toBe('payShareConfirmEa Acme Sdn Bhd · 2025');
    await f.confirm();
    await waitFor(() => expect(f.order).toEqual(['post:confirmed', 'download', 'share:file', 'post:completed']));
    expect(f.bodies()[0]).toMatchObject({ document: { kind: 'ea', employmentId: EMP, year: '2025', companyId: CO1 }, stage: 'confirmed' });
    expect(f.apiDownload.mock.calls[0][0]).toMatchObject({ path: 'v2/ea/pdf' });
    expect(f.apiDownload.mock.calls[0][1]).toEqual({ employmentId: EMP, year: '2025', company: CO1, lang: 'en' });
    expect(f.fs.files.size).toBe(0);
  });

  it('a form that cannot be laid out is closed as cancelled and says so', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce({ enabled: true, items: [{ employmentId: EMP, employeeCode: null, companyId: CO1, company: 'Acme Sdn Bhd', year: '2025', available: true, isCurrent: true }] });
    f.apiDownload.mockImplementationOnce(async () => { f.order.push('download'); return { outcome: 'refused', code: 'layout_unavailable' }; });
    render(<f.EaScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'payShare: 2025 · Acme Sdn Bhd' }));
    await waitFor(() => expect(f.alert).toHaveBeenCalledTimes(1));
    await f.confirm();
    await screen.findByText('payEaLayout');
    expect(f.order).toEqual(['post:confirmed', 'download', 'post:cancelled']);
  });
});
