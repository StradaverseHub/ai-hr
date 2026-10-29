/**
 * M09 — the employee's own payslips (index, native detail) and EA forms, and the audited share of their PDFs.
 *
 * THE APP COMPUTES NOTHING. Which payslips exist, which are released and the caller's own, every row, label and
 * amount come from the server (lib/mobile-api/v2/pay.ts; the web's own document owners). Amounts arrive as two-place
 * decimal strings and are only grouped for reading (ui.tsx fmtMoney) and prefixed with the company's currency, as the
 * web statement prints them; the app does no arithmetic on them.
 *
 * NOTHING IS KEPT (D7). The index, the detail and the EA list live in this screen's memory only: no cache, no
 * journal, no storage. Offline there is nothing to show: "Payslips need a connection", never a stale copy.
 *
 * A SHARE IS EXPLICIT, ACKNOWLEDGED AND AUDITED (D7). The order is fixed and online only:
 *   1. the person confirms in a dialog that says what leaves the app;
 *   2. the server records `confirmed` and ACKNOWLEDGES it — no acknowledgement, no download, no share sheet;
 *   3. the PDF is downloaded into a random-named temporary file (protected-document.ts);
 *   4. the OS share sheet opens on it; the file is exempt from the background sweep while it is open (Android
 *      backgrounds the app for it) and is deleted the moment the share settles, whichever way;
 *   5. the server records `completed` (the sheet returned) or `cancelled` (it failed, or the download did).
 * There is no in-app PDF viewer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import * as Sharing from 'expo-sharing';
import type { z } from 'zod';
import { DesignText as Text, TenantBrand, useTenantDesign } from './design';
import { apiDownload, apiGetV2, apiPostV2, v2Download } from './api';
import { authGeneration } from './auth';
import { config, identityNamespace } from './config';
import { isNoConnectivity, RequestRejectedError, SignInRequiredError } from './errors';
import { appLocale, t, type MessageKey } from './i18n';
import { PagedList, usePagedList, type PageLoader, type PagedListState } from './paged-list';
import { shareProtectedDocument } from './protected-document';
import { useSession } from './session';
import { Button, Card, fmtMoney, HeaderBack, LoadState, Muted, Row, Screen, Title } from './ui';
import {
  EaSourcesV2, PayslipDetailResult, PayslipIndexV2, ShareEventResult,
  type EaSourceV2, type PayslipDetailV2, type PayslipIndexItemV2, type PayslipRowV2, type RunTypeV2, type SharedDocumentV2,
  type ShareEventRefusalCode, type ShareStage,
} from '../../lib/mobile-api/v2/pay';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The only payslip paths the app builds: a validated UUID, optionally its PDF. */
export function payslipPath(id: string, pdf = false): `v2/${string}` {
  if (!UUID.test(id)) throw new Error('Invalid payslip reference');
  return `v2/payslips/${id.toLowerCase()}${pdf ? '/pdf' : ''}`;
}
const EA_PDF = v2Download('v2/ea/pdf');
const SHARE_EVENTS = 'v2/documents/share-events' as const;

const RUN_TYPE: Record<RunTypeV2, MessageKey> = { regular: 'payRunRegular', off_cycle: 'payRunOffCycle', bonus: 'payRunBonus', adjustment: 'payRunAdjustment' };
const SHARE_REFUSAL: Record<ShareEventRefusalCode, MessageKey> = {
  not_found: 'payShareRefused', not_confirmed: 'payShareFailed', already_settled: 'payShareFailed', request_conflict: 'payShareFailed', employment_required: 'payShareRefused',
};
/** An amount as the web statement prints it: the company's currency, then the grouped figure. Never a computed one. */
export function moneyLabel(amount: string, currency: string | null): string {
  return currency ? `${currency} ${fmtMoney(amount)}` : fmtMoney(amount);
}
/** `YYYY-MM` as a month and year in the app's language; the stored form if the device cannot name it. */
export function monthLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  try { return new Intl.DateTimeFormat(appLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))); }
  catch { return period; }
}
/** The run as the index names it: the configured cycle, else the run type, and the run number past the first. */
export function runLabel(item: Pick<PayslipIndexItemV2, 'cycleName' | 'runType' | 'runSeq'>): string {
  const cycle = item.cycleName?.trim() || t(RUN_TYPE[item.runType]);
  return item.runSeq > 1 ? `${cycle} · ${t('payRunSeq', { n: item.runSeq })}` : cycle;
}
const noConnection = (error: Error | null) => !!error && isNoConnectivity(error);

// ── Share ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type ShareRequest = {
  document: SharedDocumentV2;
  /** What the confirmation names ("March 2026 · Monthly", "Acme Sdn Bhd · 2025"). */
  what: string;
  download: () => ReturnType<typeof apiDownload>;
};
export type ShareOutcome = 'shared' | 'refused' | 'unavailable' | 'failed' | 'signed_out';
type SharePorts = {
  post: (body: Record<string, unknown>) => Promise<z.output<typeof ShareEventResult>>;
  share: (uri: string) => Promise<unknown>;
};

/** Record a closing stage. A lost answer is resent once under the SAME requestId (the receipt replays it). */
async function close(ports: SharePorts, shareId: string, document: SharedDocumentV2, stage: Exclude<ShareStage, 'confirmed'>) {
  const body = { requestId: randomUUID(), shareId, document, stage };
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await ports.post(body); return; }
    catch (error) { if (error instanceof SignInRequiredError || error instanceof RequestRejectedError) return; }
  }
}

/**
 * Steps 2–5 of the share (step 1, the confirmation, is the caller's). Exported for the screens and their tests;
 * resolves with what happened and never throws.
 */
export async function runDocumentShare(request: ShareRequest, ports: SharePorts): Promise<{ outcome: ShareOutcome; notice: MessageKey | null }> {
  const shareId = randomUUID(), owner = authGeneration();
  let ack: z.output<typeof ShareEventResult>;
  try { ack = await ports.post({ requestId: randomUUID(), shareId, document: request.document, stage: 'confirmed' }); }
  catch (error) {
    if (error instanceof SignInRequiredError) return { outcome: 'signed_out', notice: null };
    return { outcome: 'unavailable', notice: noConnection(error as Error) ? 'payShareNeedsConnection' : 'payShareFailed' };
  }
  // No acknowledgement, no file and no share sheet.
  if (ack.outcome !== 'recorded' || ack.shareId !== shareId || ack.stage !== 'confirmed') {
    return { outcome: 'refused', notice: ack.outcome === 'refused' ? SHARE_REFUSAL[ack.code] : 'payShareFailed' };
  }
  let file: Awaited<ReturnType<typeof apiDownload>>;
  try {
    file = await request.download();
    if (authGeneration() !== owner) { if (file.outcome === 'file') file.document.delete(); return { outcome: 'signed_out', notice: null }; }
  } catch (error) {
    await close(ports, shareId, request.document, 'cancelled');
    if (error instanceof SignInRequiredError) return { outcome: 'signed_out', notice: null };
    return { outcome: 'unavailable', notice: noConnection(error as Error) ? 'payShareNeedsConnection' : 'payShareFailed' };
  }
  if (file.outcome !== 'file') {
    await close(ports, shareId, request.document, 'cancelled');
    return { outcome: 'refused', notice: file.code === 'layout_unavailable' ? 'payEaLayout' : 'payShareRefused' };
  }
  let stage: 'completed' | 'cancelled' = 'cancelled';
  try { await shareProtectedDocument(file.document, ports.share); stage = 'completed'; }
  catch { stage = 'cancelled'; }
  await close(ports, shareId, request.document, stage);
  return stage === 'completed' ? { outcome: 'shared', notice: null } : { outcome: 'failed', notice: 'payShareFailed' };
}

const sharePorts: SharePorts = {
  post: (body) => apiPostV2(SHARE_EVENTS, ShareEventResult, body),
  share: (uri) => Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: t('payShare') }),
};

/** The confirmation, then runDocumentShare. One share at a time. */
export function useDocumentShare(onSignInRequired: () => void, ports: SharePorts = sharePorts) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const flight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = useCallback(async (request: ShareRequest) => {
    if (flight.current) return;
    flight.current = true; setBusy(true);
    try {
      const result = await runDocumentShare(request, ports);
      if (result.outcome === 'signed_out') onSignInRequired();
      if (mounted.current) setNotice(result.notice ? t(result.notice) : null);
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  }, [onSignInRequired, ports]);
  const start = useCallback(async (request: ShareRequest) => {
    if (flight.current) return;
    setNotice(null);
    let available = false;
    try { available = await Sharing.isAvailableAsync(); } catch { available = false; }
    if (!available) { setNotice(t('payShareUnavailable')); return; }
    Alert.alert(t('payShareConfirmTitle'), t(request.document.kind === 'payslip' ? 'payShareConfirmPayslip' : 'payShareConfirmEa', { what: request.what }), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('payShareGo'), onPress: () => void run(request) },
    ]);
  }, [run]);
  return { start, busy, notice };
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Read<T> = { data: T | null; error: Error | null; loading: boolean; reload: () => void };
/** One v2 read held in memory, scoped like useApi. Any failure shows nothing of the old answer. */
function useV2Read<S extends z.ZodType>(path: `v2/${string}` | null, schema: S, onSignInRequired: () => void): Read<z.output<S>> {
  const owner = authGeneration(), namespace = identityNamespace(), origin = config.apiUrl, locale = appLocale();
  const key = JSON.stringify([owner, namespace, origin, locale, path]);
  const [state, setState] = useState<{ key: string; data: z.output<S> | null; error: Error | null; loading: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    if (!path) { setState({ key, data: null, error: new Error('Invalid reference'), loading: false }); return; }
    setState((prior) => ({ key, data: prior?.key === key ? prior.data : null, error: null, loading: true }));
    apiGetV2(path, schema, {}, controller.signal).then(
      (data) => { if (live && authGeneration() === owner) setState({ key, data, error: null, loading: false }); },
      (error: Error) => {
        if (!live || authGeneration() !== owner) return;
        if (error instanceof SignInRequiredError) onSignInRequired();
        setState({ key, data: null, error, loading: false });
      });
    return () => { live = false; controller.abort(); };
  }, [key, tick, onSignInRequired]); // `path` is part of `key`; `schema` is a module constant
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return state?.key === key ? { ...state, reload } : { data: null, error: null, loading: true, reload };
}

/** Connection message in place of any content, with a retry. */
function NeedsConnection({ onRetry }: { onRetry: () => void }) {
  const { palette } = useTenantDesign();
  return <Card>
    <Text accessibilityRole="alert" style={{ color: palette.text, fontSize: 16, lineHeight: 23 }}>{t('payNeedsConnection')}</Text>
    <Button title={t('retry')} kind="quiet" onPress={onRetry} />
  </Card>;
}

// ── Index ──────────────────────────────────────────────────────────────────────────────────────────────────────

const itemKey = (item: PayslipIndexItemV2) => item.id;
const groupOf = (item: PayslipIndexItemV2) => `${item.period.slice(0, 4)}:${item.companyId}`;
/** The ids that open a (year, employer) group, in the server's grouped order. */
export function groupStarts(items: readonly PayslipIndexItemV2[]): Set<string> {
  const starts = new Set<string>();
  let previous: string | null = null;
  for (const item of items) { const g = groupOf(item); if (g !== previous) starts.add(item.id); previous = g; }
  return starts;
}

/** Every own released payslip, every employment of the login (D1), grouped by employer and year. */
export function usePayslipIndex(onSignInRequired: () => void): { list: PagedListState<PayslipIndexItemV2>; enabled: boolean | null } {
  const scope = JSON.stringify([identityNamespace(), config.apiUrl, appLocale(), authGeneration(), 'v2/payslips']);
  const [enabled, setEnabled] = useState<{ scope: string; value: boolean } | null>(null);
  const load = useCallback<PageLoader<PayslipIndexItemV2>>(async (cursor, signal) => {
    const page = await apiGetV2('v2/payslips', PayslipIndexV2, cursor ? { cursor } : {}, signal);
    setEnabled({ scope, value: page.enabled });
    return { items: page.items, nextCursor: page.nextCursor };
  }, [scope]);
  const list = usePagedList(scope, load, itemKey, onSignInRequired);
  return { list, enabled: enabled?.scope === scope ? enabled.value : null };
}

export function PayslipsScreen() {
  const { palette } = useTenantDesign();
  const { signOut } = useSession();
  const { list, enabled } = usePayslipIndex(signOut);
  const offline = noConnection(list.error);
  // Nothing outlives a failed read: no stale rows, offline or not.
  const shown: PagedListState<PayslipIndexItemV2> = list.error
    ? { ...list, items: [], stale: false, empty: false, error: offline ? null : list.error }
    : list;
  const starts = useMemo(() => groupStarts(shown.items), [shown.items]);
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }} edges={['top']}>
    <PagedList list={shown} keyOf={itemKey} emptyText={enabled === false ? t('payrollOff') : t('noPayslips')} contentContainerStyle={{ padding: 20, gap: 8 }}
      header={<View style={{ gap: 12 }}>
        <HeaderBack />
        <TenantBrand />
        <Title>{t('payTitle')}</Title>
        <Button title={t('payEaOpen')} kind="quiet" onPress={() => router.push('/pay/ea')} />
        {offline && <NeedsConnection onRetry={list.retry} />}
      </View>}
      renderItem={(item) => <View style={{ gap: 6 }}>
        {starts.has(item.id) && <Text accessibilityRole="header" style={{ color: palette.text, fontSize: 18, fontWeight: '700', marginTop: 12 }}>{`${item.company} · ${item.period.slice(0, 4)}`}</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel={`${monthLabel(item.period)} · ${runLabel(item)} · ${item.company}`}
          onPress={() => router.push({ pathname: '/pay/[id]', params: { id: item.id } })}
          style={{ paddingVertical: 14, borderBottomWidth: 1, borderColor: palette.border, gap: 4 }}>
          <Text style={{ color: palette.text, fontSize: 17, fontWeight: '600' }}>{`${monthLabel(item.period)} · ${runLabel(item)}`}</Text>
          {item.employeeCode ? <Muted>{t('payEmployeeCode', { code: item.employeeCode })}</Muted> : null}
        </Pressable>
      </View>} />
  </SafeAreaView>;
}

// ── Detail ─────────────────────────────────────────────────────────────────────────────────────────────────────

function valueOf(row: PayslipRowV2, currency: string | null): string {
  return row.amount !== null ? moneyLabel(row.amount, currency) : row.text ?? '—';
}
export function payslipHeading(p: Pick<PayslipDetailV2, 'periodLabel' | 'cycleLabel'>): string {
  return p.cycleLabel ? `${p.periodLabel} · ${p.cycleLabel}` : p.periodLabel;
}

/** One own payslip, natively: the document's own rows, exactly as supplied, and Share PDF. */
export function PayslipDetailScreen({ id }: { id: string }) {
  const { palette } = useTenantDesign();
  const { signOut } = useSession();
  let path: `v2/${string}` | null = null;
  try { path = payslipPath(id); } catch { path = null; }
  const detail = useV2Read(path, PayslipDetailResult, signOut);
  const share = useDocumentShare(signOut);
  const payslip = detail.data?.outcome === 'found' ? detail.data.payslip : null;
  const offline = noConnection(detail.error);
  const heading = (text: string) => <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{text}</Text>;
  return <Screen back onRefresh={detail.reload}>
    {offline ? <NeedsConnection onRetry={detail.reload} /> : <LoadState loading={detail.loading} hasData={false} error={detail.error} onRetry={detail.reload} />}
    {detail.data?.outcome === 'refused' && <Muted>{t('payNotFound')}</Muted>}
    {payslip && <>
      <Title>{payslipHeading(payslip)}</Title>
      <Muted>{payslip.company}</Muted>
      {payslip.employeeCode ? <Muted>{t('payEmployeeCode', { code: payslip.employeeCode })}</Muted> : null}
      {payslip.sections.map((section) => <Card key={section.title}>
        {heading(section.title)}
        {section.rows.map((row, index) => <View key={`${row.label}-${index}`}>
          <Row label={row.label} value={valueOf(row, payslip.currency)} />
          {row.quantity ? <Muted>{row.sub ? `${row.quantity} × ${row.sub}` : row.quantity}</Muted> : null}
        </View>)}
        <Row label={section.total.label} value={moneyLabel(section.total.amount, payslip.currency)} strong />
      </Card>)}
      <Card><Row label={payslip.net.label} value={moneyLabel(payslip.net.amount, payslip.currency)} strong /></Card>
      {share.notice && <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{share.notice}</Text>}
      <Button title={share.busy ? t('payShareBusy') : t('payShare')} disabled={share.busy} onPress={() => void share.start({
        document: { kind: 'payslip', id: payslip.id }, what: payslipHeading(payslip),
        download: () => apiDownload(v2Download(payslipPath(payslip.id, true))),
      })} />
    </>}
  </Screen>;
}

// ── EA ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const eaKey = (s: EaSourceV2) => `${s.employmentId}:${s.companyId}:${s.year}`;
/** Every own EA source as /me/ea lists it (years and employers); an available one can be shared. */
export function EaScreen() {
  const { palette } = useTenantDesign();
  const { signOut } = useSession();
  const sources = useV2Read('v2/ea', EaSourcesV2, signOut);
  const share = useDocumentShare(signOut);
  const offline = noConnection(sources.error);
  const data = sources.data;
  const lang = appLocale() === 'ms' ? 'ms' : 'en';
  return <Screen back onRefresh={sources.reload}>
    <Title>{t('payEaTitle')}</Title>
    {offline ? <NeedsConnection onRetry={sources.reload} /> : <LoadState loading={sources.loading} hasData={false} error={sources.error} onRetry={sources.reload} />}
    {data && !data.enabled && <Muted>{t('payrollOff')}</Muted>}
    {data?.enabled && data.items.length === 0 && <Muted>{t('payEaEmpty')}</Muted>}
    {share.notice && <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{share.notice}</Text>}
    {data?.enabled && data.items.map((s) => <Card key={eaKey(s)}>
      <Text style={{ color: palette.text, fontSize: 17, fontWeight: '600' }}>{`${s.year} · ${s.company}`}</Text>
      {s.employeeCode ? <Muted>{t('payEmployeeCode', { code: s.employeeCode })}</Muted> : null}
      {s.available
        ? <Button title={share.busy ? t('payShareBusy') : t('payShare')} accessibilityLabel={`${t('payShare')}: ${s.year} · ${s.company}`} disabled={share.busy} onPress={() => void share.start({
          document: { kind: 'ea', employmentId: s.employmentId, year: s.year, companyId: s.companyId }, what: `${s.company} · ${s.year}`,
          download: () => apiDownload(EA_PDF, { employmentId: s.employmentId, year: s.year, company: s.companyId, lang }),
        })} />
        : <Muted>{t('payEaNotAvailable')}</Muted>}
    </Card>)}
  </Screen>;
}
