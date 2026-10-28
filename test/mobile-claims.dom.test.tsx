/**
 * M11 — the shipped native claim screens (mobile/lib/claims.tsx, claim-form.tsx, claim-parts.tsx over the shipped
 * paged list and journey-draft provider), the receipt custody (mobile/lib/protected-document.ts adoptProtectedDocument
 * on a fake file system) and the D12 claim task in approvals (mobile/lib/approval-decision.tsx), with only native
 * views, pickers, transport, navigation and identity injected. The server's rules are tested in
 * test/mobile-v2-claims.test.ts; this file pins what the app does with its answers.
 *
 * Pinned: a command runs only after a confirmation; a lost answer is retried with the SAME reference; a kernel
 * refusal shows the kernel's sentence; the form sends exactly the contract's fields (the amount only when asked, the
 * distance only for mileage) with the receipt as a multipart part; a receipt swept while away is asked for again; the
 * mileage figure shown is the server's preview; a receipt photo is compressed and ADOPTED into the protected folder
 * (only the picker's cache copy is deleted); a viewed image is deleted when hidden, a PDF is never kept; the approver's
 * claim decision needs a reason to reject and echoes the expected state.
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
import * as v2claims from '../lib/mobile-api/v2/claims';
import * as v2tasks from '../lib/mobile-api/v2/tasks';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECEIPT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TYPE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MILE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
type Ports = Record<string, unknown>;
type Loaded = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function load(path: string, ports: Ports): Loaded {
  const module = { exports: {} as Loaded };
  runInNewContext(transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, AbortController, Date, Error, Intl, JSON, FormData, require: (id: string) => { if (id in ports) return ports[id]; throw new Error('Missing port ' + id + ' for ' + path); } });
  return module.exports;
}

const balance = { annualLimit: '1000.00', usedThisYear: '200.00', reservedThisYear: '50.00', remainingThisYear: '800.00', monthlyLimit: null, usedThisMonth: '0.00', remainingThisMonth: null,
  perClaimCap: null, lifetimeLimit: null, usedLifetime: '0.00', claimsUsedThisYear: 2, maxClaimsPerYear: null, blockLimit: null, usedThisBlock: '0.00', remainingThisBlock: null, blockEndsOn: null, items: [] };
const options = (over: Record<string, unknown> = {}) => ({ enabled: true, employmentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', currency: 'MYR', today: '2026-10-28', types: [
  { id: TYPE, code: 'MEAL', name: 'Meals', requiresReceipt: false, amountEntry: 'entered', fixedAmount: null, earliestIncurredOn: '2026-09-13', items: [],
    fields: [{ key: 'client', label: 'Client', kind: 'text', required: true, options: [] }], balance },
  { id: MILE, code: 'MILE', name: 'Mileage', requiresReceipt: false, amountEntry: 'distance', fixedAmount: null, earliestIncurredOn: '2026-09-13', items: [], fields: [], balance },
], ...over });
const detail = (over: Record<string, unknown> = {}) => ({ outcome: 'found', claim: {
  id: ID, claimTypeId: TYPE, claimItemId: null, claimType: 'Meals', claimItem: null, amount: '42.50', amountProvisional: false, currency: 'MYR', quantityKm: null, mileage: null,
  incurredOn: '2026-10-26', description: 'Team lunch', fields: [{ key: 'client', label: 'Client', kind: 'text', value: 'Acme' }],
  receipts: [{ id: RECEIPT, fileName: 'lunch.png', sizeBytes: 2048 }], status: 'pending', createdAt: '2026-10-26T02:00:00.000Z', submittedAt: '2026-10-26T02:00:00.000Z',
  decision: null, payout: null, actions: { cancel: true, editDraft: false, deleteDraft: false, submitDraft: false }, ...over,
} });

function fixture() {
  let seq = 0;
  const apiGetPage = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ items: [{ id: ID, claimType: 'Meals', claimItem: null, amount: '42.50', amountProvisional: false, incurredOn: '2026-10-26', status: 'pending', receiptCount: 1 }], nextCursor: null }));
  const apiGetV2 = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => detail());
  const apiPostV2 = vi.fn<(...a: unknown[]) => Promise<unknown>>();
  const apiPostFormV2 = vi.fn<(...a: unknown[]) => Promise<unknown>>();
  const apiDownload = vi.fn<(...a: unknown[]) => Promise<unknown>>();
  let formOptions: unknown = options();
  const useApiV2 = vi.fn(() => ({ data: formOptions, error: null, loading: false, reload: () => {} }));
  const push = vi.fn(), back = vi.fn(), replace = vi.fn(), alert = vi.fn(), signOut = vi.fn();
  const View = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Text = ({ children, accessibilityRole }: { children?: React.ReactNode; accessibilityRole?: string }) => <span role={accessibilityRole === 'alert' ? 'alert' : undefined}>{children}</span>;
  const native = {
    View, Text, Alert: { alert }, AppState: { currentState: 'active' },
    Image: (p: { accessibilityLabel?: string; source: { uri: string } }) => <img alt={p.accessibilityLabel} src={p.source.uri} />,
    Pressable: (p: { disabled?: boolean; accessibilityRole?: string; accessibilityLabel?: string; accessibilityState?: { checked?: boolean }; onPress?: () => void; children?: React.ReactNode }) =>
      <button disabled={p.disabled} role={p.accessibilityRole ?? 'button'} aria-label={p.accessibilityLabel} aria-checked={p.accessibilityState?.checked} onClick={p.onPress}>{p.children}</button>,
    TextInput: (p: { accessibilityLabel?: string; value: string; editable?: boolean; onChangeText: (v: string) => void }) => <input aria-label={p.accessibilityLabel} disabled={p.editable === false} value={p.value} onChange={(e) => p.onChangeText(e.target.value)} />,
    RefreshControl: (p: { onRefresh: () => void }) => <button onClick={p.onRefresh}>pull</button>,
    FlatList: (p: { refreshControl: React.ReactNode; ListHeaderComponent: React.ReactNode; ListEmptyComponent: React.ReactNode; ListFooterComponent: React.ReactNode; data: unknown[]; keyExtractor: (i: unknown) => string; renderItem: (a: { item: unknown }) => React.ReactNode }) =>
      <div>{p.refreshControl}{p.ListHeaderComponent}{p.data.length ? p.data.map((i) => <div key={p.keyExtractor(i)}>{p.renderItem({ item: i })}</div>) : p.ListEmptyComponent}{p.ListFooterComponent}</div>,
  };
  const ui = {
    Button: (p: { disabled?: boolean; onPress: () => void; title: string; accessibilityLabel?: string }) => <button disabled={p.disabled} aria-label={p.accessibilityLabel} onClick={p.onPress}>{p.title}</button>,
    Card: View, Muted: Text, Title: Text, Row: ({ label, value }: { label: string; value: string }) => <p>{label}: {value}</p>,
    Screen: ({ children, onRefresh }: { children?: React.ReactNode; onRefresh?: () => void }) => <div><button onClick={onRefresh}>refresh</button>{children}</div>,
    LoadState: (p: { error: Error | null; hasData: boolean; loading: boolean; onRetry: () => void }) => p.error ? <div>{'error:' + p.error.name}<button onClick={p.onRetry}>retry-load</button></div> : p.loading ? <span role="progressbar" /> : null,
    fmtDays: (n: unknown) => String(n), fmtMoney: (v: string) => v,
  };
  const t = (k: string, v?: Record<string, unknown>) => (v ? `${k} ${Object.values(v).join('|')}` : k);
  const files = new Set<string>();
  class File { uri: string; constructor(uri: string) { this.uri = uri; } get exists() { return files.has(this.uri); } delete() { files.delete(this.uri); } get size() { return 2048; } }
  const session = { employmentId: null as string | null, status: 'signedIn', signOut };
  const base: Ports = {
    react: React, 'react/jsx-runtime': jsx, 'react-native': native, './ui': ui, './errors': errors,
    './auth': { authGeneration: () => 1, assertAuthGeneration: () => {} },
    './config': { config: { apiUrl: 'https://hr.test' }, identityNamespace: () => 'company' },
    './i18n': { appLocale: () => 'en', t },
    './design': { DesignText: Text, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'dark') }) },
    './session': { useSession: () => session },
    'react-native-safe-area-context': { SafeAreaView: View }, 'expo-router': { router: { push, back, replace } },
    'expo-crypto': { randomUUID: () => `${String(++seq).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb` },
    '../../lib/mobile-api/v2/claims': v2claims, '../../lib/mobile-api/v2/tasks': v2tasks,
    'expo-file-system': { File, Directory: class { exists = false; }, Paths: { cache: { uri: 'file:///cache' } } },
  };
  const api = { apiGetPage, apiGetV2, apiPostV2, apiPostFormV2, apiDownload, useApiV2,
    v2Page: (path: string) => ({ kind: 'page', path, schema: null }), v2Download: (path: string, maxBytes: number, types: string[]) => ({ kind: 'download', path, maxBytes, types }) };
  const exists = vi.fn((uri: string) => files.has(uri));
  const parts = load('mobile/lib/claim-parts.tsx', { ...base, 'expo-image-picker': {}, 'expo-image-manipulator': {}, 'expo-document-picker': {}, './protected-document': { adoptProtectedDocument: vi.fn() } });
  const paged = load('mobile/lib/paged-list.tsx', { ...base, './api': api });
  const claims = load('mobile/lib/claims.tsx', { ...base, './api': api, './paged-list': paged, './claim-parts': parts });
  const provider = load('mobile/lib/journey-drafts.tsx', base);
  const capture = { photo: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null), pdf: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null) };
  const formScreens = load('mobile/lib/claim-form.tsx', {
    ...base, './api': api, './claims': claims, './journey-drafts': provider,
    './claim-parts': { ...parts, captureReceiptPhoto: capture.photo, pickReceiptPdf: capture.pdf },
    './capture': { appendAttachment: (form: FormData, key: string, file: { name: string; uri: string }) => form.append(key, `file:${file.name}:${file.uri}`) },
    './leave-request-form': { PickerField: (p: { label: string; value?: string; onChange: (v: string) => void }) => <input aria-label={p.label} value={p.value ?? ''} onChange={(e) => p.onChange(e.target.value)} /> },
    './protected-document': { protectedDocumentExists: exists },
  });
  const approvals = load('mobile/lib/approval-decision.tsx', { ...base, './api': api, './paged-list': paged, './claim-parts': parts });
  /** Press the confirming (second) button of the Nth alert. */
  const confirm = async (index = 0) => { const buttons = alert.mock.calls[index][2] as { onPress?: () => void }[]; await act(async () => { buttons[1].onPress?.(); }); };
  const Form = ({ draftId }: { draftId?: string }) => <provider.JourneyDraftProvider><formScreens.ClaimFormScreen draftId={draftId} /></provider.JourneyDraftProvider>;
  return Object.assign({} as Loaded, claims, { Form, ApprovalDetailScreen: approvals.ApprovalDetailScreen, parts, apiGetPage, apiGetV2, apiPostV2, apiPostFormV2, apiDownload, useApiV2, push, replace, alert, signOut, confirm, files, exists, capture, setOptions: (value: unknown) => { formOptions = value; } });
}
afterEach(cleanup);

describe('claims list', () => {
  it('rows carry the company currency; New claim opens the form; the filter narrows the list', async () => {
    const f = fixture();
    render(<f.ClaimsScreen />);
    await screen.findByText('Meals');
    expect(screen.getByText('MYR 42.50 · 2026-10-26')).toBeTruthy();
    expect((f.apiGetPage.mock.calls[0][0] as { path: string }).path).toBe('v2/claims');
    fireEvent.click(screen.getByText('claimsNew'));
    expect(f.push).toHaveBeenCalledWith('/claims/new');
    fireEvent.click(screen.getByText('claimsStatusDraft'));
    await waitFor(() => expect(f.apiGetPage.mock.calls.some((c) => (c[2] as Record<string, string>).status === 'draft')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /^Meals, MYR 42.50/ }));
    expect(f.push).toHaveBeenCalledWith({ pathname: '/claims/[id]', params: { id: ID } });
  });

  it('says so when Claims is off or there is no claim-eligible employment, and offers no New claim', async () => {
    const f = fixture();
    f.setOptions(options({ enabled: false, employmentId: null, types: [] }));
    render(<f.ClaimsScreen />);
    await screen.findByText('claimsOff');
    expect(screen.queryByText('claimsNew')).toBeNull();
  });
});

describe('claim detail', () => {
  it('shows the claim; cancel runs only after a confirmation; a lost answer is retried with the SAME reference', async () => {
    const f = fixture();
    render(<f.ClaimDetailScreen id={ID} />);
    await screen.findByText('Meals');
    expect(f.apiGetV2.mock.calls[0][0]).toBe(`v2/claims/${ID}`);
    expect(screen.getByText('MYR 42.50')).toBeTruthy();
    expect(screen.getByText('Client: Acme')).toBeTruthy();
    fireEvent.click(screen.getByText('claimsCancel'));
    expect(f.apiPostV2).not.toHaveBeenCalled();
    f.apiPostV2.mockRejectedValueOnce(new errors.UnavailableError());
    await f.confirm();
    await screen.findByText('claimsCommandUncertain');
    const [path, , body] = f.apiPostV2.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(path).toBe(`v2/claims/${ID}/cancel`);
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'cancelled', id: ID });
    fireEvent.click(screen.getByText('claimsCommandRetry'));
    await screen.findByText('claimsCancelledDone');
    expect(f.apiPostV2.mock.calls[1][2]).toEqual(body);
  });

  it('a kernel refusal shows the kernel’s own sentence and reloads', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValue(detail({ status: 'draft', amountProvisional: true, actions: { cancel: false, editDraft: true, deleteDraft: true, submitDraft: true } }));
    render(<f.ClaimDetailScreen id={ID} />);
    fireEvent.click(await screen.findByText('claimsSubmitDraft'));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'refused', code: 'claim_refused', message: 'This claim (RM 80.00) would exceed the annual limit.' });
    await f.confirm();
    await screen.findByText('This claim (RM 80.00) would exceed the annual limit.');
    expect(f.apiPostV2.mock.calls[0][0]).toBe('v2/claims/drafts/submit');
    expect(f.apiPostV2.mock.calls[0][2]).toEqual({ requestId: expect.any(String), ids: [ID] });
    await waitFor(() => expect(f.apiGetV2).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('claimsEditDraft')).not.toBeDisabled());
    fireEvent.click(screen.getByText('claimsEditDraft'));
    expect(f.push).toHaveBeenCalledWith({ pathname: '/claims/new', params: { draft: ID } });
  });

  it('an image receipt is shown from the protected folder and deleted on Hide; a PDF is never kept', async () => {
    const f = fixture();
    const image = { uri: 'file:///cache/aihr-protected/x.png', mimeType: 'image/png', size: 2048, delete: vi.fn() };
    f.apiDownload.mockResolvedValueOnce({ outcome: 'file', document: image });
    render(<f.ClaimDetailScreen id={ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'claimsReceiptView: lunch.png' }));
    const shown = await screen.findByRole('img', { name: 'lunch.png' });
    expect(shown.getAttribute('src')).toBe(image.uri);
    const [resource, params] = f.apiDownload.mock.calls[0] as [{ path: string; types: string[] }, Record<string, string>];
    expect(resource.path).toBe(`v2/claims/${ID}/receipt`);
    expect(resource.types).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
    expect(params).toEqual({ employmentId: undefined, attachment: RECEIPT });
    fireEvent.click(screen.getByText('claimsReceiptHide'));
    expect(image.delete).toHaveBeenCalled();
    const pdf = { uri: 'file:///cache/aihr-protected/y.pdf', mimeType: 'application/pdf', size: 10, delete: vi.fn() };
    f.apiDownload.mockResolvedValueOnce({ outcome: 'file', document: pdf });
    fireEvent.click(screen.getByRole('button', { name: 'claimsReceiptView: lunch.png' }));
    await screen.findByText('claimsReceiptPdfOnWeb');
    expect(pdf.delete).toHaveBeenCalled();
  });
});

describe('claim form', () => {
  it('sends exactly the contract’s fields with the receipt as a multipart part, after a confirmation', async () => {
    const f = fixture();
    f.files.add('file:///cache/aihr-protected/r.jpg');
    f.capture.photo.mockResolvedValueOnce({ uri: 'file:///cache/aihr-protected/r.jpg', name: 'receipt.jpg', mimeType: 'image/jpeg', size: 2048 });
    render(<f.Form />);
    fireEvent.click(await screen.findByText('Meals'));
    fireEvent.change(await screen.findByRole('textbox', { name: 'claimsAmount (MYR)' }), { target: { value: '42.5' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Client · required' }), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByText('claimsReceiptCamera'));
    await screen.findByText('receipt.jpg: claimsReceiptSize 2');
    expect(f.capture.photo).toHaveBeenCalledWith('camera');
    expect(screen.getByText('claimsBalanceYear MYR 800.00|MYR 1000.00')).toBeTruthy();
    fireEvent.click(screen.getByText('claimsSubmit'));
    expect(f.apiPostFormV2).not.toHaveBeenCalled();
    expect(String(f.alert.mock.calls[0][1])).toContain('receipt.jpg');
    f.apiPostFormV2.mockResolvedValueOnce({ outcome: 'submitted', id: ID });
    await f.confirm();
    await screen.findByText('claimsSubmittedDone');
    const [path, , form, params] = f.apiPostFormV2.mock.calls[0] as [string, unknown, FormData, Record<string, string>];
    expect(path).toBe('v2/claims');
    expect(params).toEqual({ employmentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
    expect(JSON.parse(String(form.get('command')))).toEqual({ requestId: expect.any(String), claimTypeId: TYPE, incurredOn: '2026-10-28', amount: '42.5', fieldValues: { client: 'Acme' } });
    expect(form.get('receipt')).toBe('file:receipt.jpg:file:///cache/aihr-protected/r.jpg');
    expect(f.files.has('file:///cache/aihr-protected/r.jpg'), 'an uploaded receipt leaves the phone').toBe(false);
    fireEvent.click(screen.getByText('claimsViewClaim'));
    expect(f.replace).toHaveBeenCalledWith({ pathname: '/claims/[id]', params: { id: ID } });
  });

  it('a lost answer resends the SAME reference; a refusal keeps the edits under a new one; a bad amount sends nothing', async () => {
    const f = fixture();
    render(<f.Form />);
    fireEvent.click(await screen.findByText('Meals'));
    fireEvent.change(await screen.findByRole('textbox', { name: 'claimsAmount (MYR)' }), { target: { value: '12,50' } });
    fireEvent.click(screen.getByText('claimsSaveDraft'));
    await f.confirm();
    await screen.findByText('claimsInvalidAmount');
    expect(f.apiPostFormV2).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'claimsAmount (MYR)' }), { target: { value: '12.50' } });
    fireEvent.click(screen.getByText('claimsSaveDraft'));
    f.apiPostFormV2.mockRejectedValueOnce(new errors.NetworkUnavailableError());
    await f.confirm(1);
    await screen.findByText('claimsCommandUncertain');
    const first = JSON.parse(String((f.apiPostFormV2.mock.calls[0][2] as FormData).get('command')));
    expect(f.apiPostFormV2.mock.calls[0][0]).toBe('v2/claims/drafts');
    f.apiPostFormV2.mockResolvedValueOnce({ outcome: 'refused', code: 'claim_refused', message: 'Receipt date cannot be in the future' });
    fireEvent.click(screen.getByText('claimsCommandRetry'));
    await screen.findByText('Receipt date cannot be in the future');
    const retried = JSON.parse(String((f.apiPostFormV2.mock.calls[1][2] as FormData).get('command')));
    expect(retried).toEqual(first);
    expect(screen.getByRole('textbox', { name: 'claimsAmount (MYR)' })).toHaveProperty('value', '12.50');
    fireEvent.click(screen.getByText('claimsSaveDraft'));
    f.apiPostFormV2.mockResolvedValueOnce({ outcome: 'saved', id: ID });
    await f.confirm(2);
    await screen.findByText('claimsDraftSavedDone');
    const third = JSON.parse(String((f.apiPostFormV2.mock.calls[2][2] as FormData).get('command')));
    expect(third.requestId).not.toBe(first.requestId);
  });

  it('a receipt swept while the app was away is asked for again, never silently dropped', async () => {
    const f = fixture();
    f.capture.photo.mockResolvedValueOnce({ uri: 'file:///cache/aihr-protected/gone.jpg', name: 'receipt.jpg', mimeType: 'image/jpeg', size: 2048 });
    render(<f.Form />);
    fireEvent.click(await screen.findByText('Meals'));
    fireEvent.click(await screen.findByText('claimsReceiptLibrary'));
    await screen.findByText('receipt.jpg: claimsReceiptSize 2');
    expect(f.capture.photo).toHaveBeenCalledWith('library');
    fireEvent.click(screen.getByText('claimsSubmit'));
    await f.confirm();
    await screen.findByText('claimsReceiptGone');
    expect(f.apiPostFormV2).not.toHaveBeenCalled();
    expect(screen.queryByText('receipt.jpg: claimsReceiptSize 2')).toBeNull();
  });

  it('mileage: the amount shown is the server’s preview, and only the distance is sent', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce({ outcome: 'priced', amount: '390.00', tableValidFrom: '2026-01-01', bands: [
      { fromKm: '0', toKm: '500', ratePerKm: '0.6', km: '500', amount: '300.00' }, { fromKm: '500', toKm: null, ratePerKm: '0.45', km: '200', amount: '90.00' }] });
    render(<f.Form />);
    fireEvent.click(await screen.findByText('Mileage'));
    expect(screen.queryByRole('textbox', { name: 'claimsAmount (MYR)' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'claimsDistanceKm' }), { target: { value: '700' } });
    fireEvent.click(screen.getByText('claimsMileagePrice'));
    await screen.findByText('claimsMileagePriced MYR 390.00');
    expect(f.apiGetV2).toHaveBeenCalledWith('v2/claims/mileage-preview', expect.anything(), { employmentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', claimTypeId: MILE, km: '700', incurredOn: '2026-10-28' });
    expect(screen.getByText('claimsMileageBand 500|∞|200|0.45|MYR 90.00')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'claimsDistanceKm' }), { target: { value: '701' } });
    expect(screen.queryByText('claimsMileagePriced MYR 390.00'), 'a preview for another distance is not shown').toBeNull();
    fireEvent.click(screen.getByText('claimsSubmit'));
    expect(String(f.alert.mock.calls[0][1])).toContain('claimsPricedOnSubmit');
    f.apiPostFormV2.mockResolvedValueOnce({ outcome: 'submitted', id: ID });
    await f.confirm();
    await screen.findByText('claimsSubmittedDone');
    expect(JSON.parse(String((f.apiPostFormV2.mock.calls[0][2] as FormData).get('command')))).toEqual({ requestId: expect.any(String), claimTypeId: MILE, incurredOn: '2026-10-28', quantityKm: '701' });
  });

  it('editing a draft reads it from the server once and submits it by its id', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValueOnce(detail({ status: 'draft', amountProvisional: true, actions: { cancel: false, editDraft: true, deleteDraft: true, submitDraft: true } }));
    render(<f.Form draftId={ID} />);
    expect(await screen.findByRole('textbox', { name: 'claimsAmount (MYR)' })).toHaveProperty('value', '42.50');
    expect(screen.getByText('claimsDraftHasReceipts 1')).toBeTruthy();
    fireEvent.click(screen.getByText('claimsSubmit'));
    f.apiPostFormV2.mockResolvedValueOnce({ outcome: 'submitted', id: ID });
    await f.confirm();
    await screen.findByText('claimsSubmittedDone');
    expect(JSON.parse(String((f.apiPostFormV2.mock.calls[0][2] as FormData).get('command')))).toEqual({
      requestId: expect.any(String), draftId: ID, claimTypeId: TYPE, incurredOn: '2026-10-26', amount: '42.50', description: 'Team lunch', fieldValues: { client: 'Acme' },
    });
  });
});

describe('receipt capture', () => {
  function capturePorts(over: Ports = {}) {
    const deleted: string[] = [];
    class File { uri: string; constructor(uri: string) { this.uri = uri; } get exists() { return true; } get size() { return 4096; } delete() { deleted.push(this.uri); } }
    const resize = vi.fn(), adopt = vi.fn((uri: string, type: string) => ({ uri: 'file:///cache/aihr-protected/new.' + (type === 'application/pdf' ? 'pdf' : 'jpg'), mimeType: type, size: 4096, delete: vi.fn() }));
    const picker = {
      requestCameraPermissionsAsync: vi.fn(async () => ({ granted: true })),
      launchCameraAsync: vi.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///cache/ImagePicker/o.jpg', width: 4000, height: 3000 }] })),
      launchImageLibraryAsync: vi.fn(async () => ({ canceled: false, assets: [{ uri: 'content://media/external/1', width: 1000, height: 800 }] })),
    };
    const manipulator = { ImageManipulator: { manipulate: () => ({ resize, release: vi.fn(), renderAsync: async () => ({ release: vi.fn(), saveAsync: async () => ({ uri: 'file:///cache/ImageManipulator/s.jpg' }) }) }) }, SaveFormat: { JPEG: 'jpeg' } };
    const documents = { getDocumentAsync: vi.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///cache/DocumentPicker/t.pdf', name: 'ticket.pdf', size: 4096 }] })) };
    const parts = load('mobile/lib/claim-parts.tsx', {
      react: React, 'react/jsx-runtime': jsx, 'react-native': { AppState: { currentState: 'active' }, View: () => null, Image: () => null },
      'expo-image-picker': picker, 'expo-image-manipulator': manipulator, 'expo-document-picker': documents,
      'expo-file-system': { File, Paths: { cache: { uri: 'file:///cache' } } }, './design': { DesignText: () => null, useTenantDesign: () => ({}) },
      './protected-document': { adoptProtectedDocument: adopt }, './errors': errors, './i18n': { t: (k: string) => k },
      './ui': { Button: () => null, Muted: () => null, Row: () => null, fmtMoney: (v: string) => v }, '../../lib/mobile-api/v2/claims': v2claims, ...over,
    });
    return { parts, picker, resize, adopt, documents, deleted };
  }

  it('a photo is scaled to the receipt edge, saved as JPEG and adopted; only the picker’s cache copy is deleted', async () => {
    const c = capturePorts();
    expect(await c.parts.captureReceiptPhoto('camera')).toEqual({ uri: 'file:///cache/aihr-protected/new.jpg', name: 'receipt.jpg', mimeType: 'image/jpeg', size: 4096 });
    expect(c.resize).toHaveBeenCalledWith({ width: 2048 });
    expect(c.adopt).toHaveBeenCalledWith('file:///cache/ImageManipulator/s.jpg', 'image/jpeg');
    expect(c.deleted).toEqual(['file:///cache/ImagePicker/o.jpg']);
    c.deleted.length = 0;
    await c.parts.captureReceiptPhoto('library');
    expect(c.picker.requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(c.deleted, 'a library photo outside the app cache is never deleted').toEqual([]);
  });

  it('a refused camera permission and an oversized PDF are refused in the app’s words', async () => {
    const c = capturePorts();
    c.picker.requestCameraPermissionsAsync.mockResolvedValueOnce({ granted: false });
    await expect(c.parts.captureReceiptPhoto('camera')).rejects.toThrow('claimsCameraPermission');
    c.documents.getDocumentAsync.mockResolvedValueOnce({ canceled: false, assets: [{ uri: 'file:///cache/DocumentPicker/big.pdf', name: 'big.pdf', size: 10 * 1024 * 1024 + 1 }] });
    await expect(c.parts.pickReceiptPdf()).rejects.toThrow('claimsReceiptTooLarge');
    expect(c.adopt).not.toHaveBeenCalled();
    expect(await c.parts.pickReceiptPdf()).toEqual({ uri: 'file:///cache/aihr-protected/new.pdf', name: 'ticket.pdf', mimeType: 'application/pdf', size: 4096 });
  });
});

describe('the approver’s claim task (D12)', () => {
  const claimTask = { outcome: 'found', task: {
    kind: 'claim', id: ID, subject: { name: 'Aina', code: 'E001' }, createdAt: '2026-10-26T02:00:00.000Z', reasonRequiredToReject: true,
    claimType: 'Meals', claimItem: null, amount: '42.50', currency: 'MYR', quantityKm: null, incurredOn: '2026-10-26', employeeReason: 'Team lunch',
    fields: [{ key: 'client', label: 'Client', kind: 'text', value: 'Acme' }], receipts: [{ id: RECEIPT, fileName: 'lunch.png', sizeBytes: 2048 }], expected: { status: 'pending' },
  } };

  it('shows the claim and its receipt; a rejection needs a reason and echoes the expected state', async () => {
    const f = fixture();
    f.apiGetV2.mockResolvedValue(claimTask);
    render(<f.ApprovalDetailScreen kind="claim" id={ID} />);
    await screen.findByText('Aina · E001');
    expect(f.apiGetV2.mock.calls[0][0]).toBe(`v2/tasks/claim/${ID}`);
    expect(screen.getByText('claimsApprovalLine Meals|MYR 42.50|2026-10-26')).toBeTruthy();
    expect(screen.getByText('Client: Acme')).toBeTruthy();
    f.apiDownload.mockResolvedValueOnce({ outcome: 'refused', code: 'unsupported_document' });
    fireEvent.click(screen.getByRole('button', { name: 'claimsReceiptView: lunch.png' }));
    await screen.findByText('claimsReceiptUnavailable');
    expect((f.apiDownload.mock.calls[0][0] as { path: string }).path).toBe(`v2/tasks/claim/${ID}/document`);
    expect(f.apiDownload.mock.calls[0][1]).toEqual({ attachment: RECEIPT });
    expect(screen.getByText('approvalReject')).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'approvalReason' }), { target: { value: ' Personal meal ' } });
    fireEvent.click(screen.getByText('approvalReject'));
    f.apiPostV2.mockResolvedValueOnce({ outcome: 'accepted', status: 'rejected' });
    await f.confirm();
    await screen.findByText('approvalDoneRejected');
    expect(f.apiPostV2.mock.calls[0][0]).toBe(`v2/tasks/claim/${ID}/decision`);
    expect(f.apiPostV2.mock.calls[0][2]).toEqual({ requestId: expect.any(String), decision: 'reject', reason: 'Personal meal', expected: { status: 'pending' } });
  });
});
