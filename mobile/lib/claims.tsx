/**
 * M11 — the employee's own expense claims: every claim on the selected employment (paged, filtered by status, drafts
 * included — D11) and one claim's detail, with the commands the kernel allows on it: Cancel (a pending claim), and
 * Edit, Submit or Delete (a draft). The claim form is claim-form.tsx.
 *
 * The app decides nothing. Statuses, amounts, the payout route, the rejection reason and the actions offered come from
 * the server (lib/mobile-api/v2/claims.ts; composed in core/mobile-claims.ts from the claims kernel). A command runs
 * only online, only after an explicit confirmation, and carries a client requestId the server's command receipt
 * replays: when the answer is lost, "Try again" resends the SAME reference and the server returns its first answer
 * instead of applying it twice. Nothing is queued or persisted (D10).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { DesignText as Text, useTenantDesign } from './design';
import { apiDownload, apiGetV2, apiPostV2, useApiV2, v2Download, v2Page } from './api';
import { assertAuthGeneration, authGeneration } from './auth';
import { config, identityNamespace } from './config';
import { RequestRejectedError, SignInRequiredError } from './errors';
import { appLocale, t, type MessageKey } from './i18n';
import { PagedList, usePagedResource } from './paged-list';
import { useSession } from './session';
import { Button, Card, LoadState, Muted, Row, Screen, Title } from './ui';
import { ClaimAnswers, ReceiptLink, claimMoney } from './claim-parts';
import {
  CLAIM_RECEIPT_MAX_BYTES, CLAIM_RECEIPT_TYPES, ClaimCancelResult, ClaimDeleteResult, ClaimDetailResult, ClaimDraftsSubmitResult,
  ClaimFormOptionsV2, ClaimSummaryV2,
  type ClaimCommandRefusal, type ClaimCommandRefusalCode, type ClaimDetailV2, type ClaimStatusV2,
} from '../../lib/mobile-api/v2/claims';

export const CLAIMS = v2Page('v2/claims', ClaimSummaryV2);
export const CLAIM_FORM = 'v2/claims/form' as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The only claim paths the app builds: a validated claim UUID, optionally one of its actions. */
export function claimPath(id: string, action?: 'receipt' | 'delete' | 'cancel'): `v2/${string}` {
  if (!UUID.test(id)) throw new Error('Invalid claim reference');
  return `v2/claims/${id.toLowerCase()}${action ? `/${action}` : ''}`;
}

export const CLAIM_STATUS_LABEL: Record<ClaimStatusV2, MessageKey> = {
  draft: 'claimsStatusDraft', pending: 'claimsStatusPending', approved: 'claimsStatusApproved',
  rejected: 'claimsStatusRejected', cancelled: 'claimsStatusCancelled', paid: 'claimsStatusPaid',
};
const REFUSAL: Record<ClaimCommandRefusalCode, MessageKey> = {
  not_found: 'claimsDetailMissing', request_conflict: 'claimsRefusalConflict', no_employment: 'claimsNoEmployment', claims_off: 'claimsOff',
  receipt_empty: 'claimsReceiptEmpty', receipt_too_large: 'claimsReceiptTooLarge', receipt_type: 'claimsReceiptType', claim_refused: 'claimsRefusedLead',
};
/**
 * The app's own sentence for a refusal. A kernel refusal (`claim_refused`) carries the kernel's English sentence —
 * the limit, the remaining amount, the window — which is the useful part, so it is shown in either language (after
 * the app's own lead in Malay).
 */
export function claimRefusalText(r: ClaimCommandRefusal): string {
  if (r.code !== 'claim_refused' || !r.message) return t(REFUSAL[r.code]);
  return appLocale() === 'en' ? r.message : `${t('claimsRefusedLead')} ${r.message}`;
}
function fmtInstant(iso: string | null): string {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat(appLocale() === 'ms' ? 'ms-MY' : 'en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso)); }
  catch { return iso.slice(0, 10); }
}
/** A receipt of the caller's own claim, downloaded into the protected folder (images only are kept for viewing). */
export function ownReceiptDownload(claimId: string, receiptId: string, employmentId: string | null) {
  return apiDownload(v2Download(claimPath(claimId, 'receipt'), CLAIM_RECEIPT_MAX_BYTES, CLAIM_RECEIPT_TYPES), { employmentId: employmentId ?? undefined, attachment: receiptId });
}

export function ClaimStatusBadge({ status }: { status: ClaimStatusV2 }) {
  const { palette } = useTenantDesign();
  return <Text accessibilityLabel={t(CLAIM_STATUS_LABEL[status])} style={{ color: palette.accent, fontWeight: '600' }}>{t(CLAIM_STATUS_LABEL[status])}</Text>;
}

export function ClaimRow({ item, currency, onPress }: { item: ClaimSummaryV2; currency: string | null; onPress: () => void }) {
  const { palette } = useTenantDesign();
  const name = item.claimItem ? `${item.claimType} · ${item.claimItem}` : item.claimType;
  const money = claimMoney(item.amount, currency);
  return <Pressable accessibilityRole="button" accessibilityLabel={`${name}, ${money}, ${item.incurredOn}, ${t(CLAIM_STATUS_LABEL[item.status])}`} onPress={onPress}
    style={{ paddingVertical: 14, borderBottomWidth: 1, borderColor: palette.border, gap: 6 }}>
    <Text style={{ color: palette.text, fontSize: 17, fontWeight: '600' }}>{name}</Text>
    <Muted>{item.amountProvisional && item.amount ? t('claimsProvisional', { amount: money }) : money} · {item.incurredOn}</Muted>
    <ClaimStatusBadge status={item.status} />
  </Pressable>;
}

const FILTERS = [undefined, 'draft', 'pending', 'approved', 'rejected', 'cancelled', 'paid'] as const;
const keyOf = (item: ClaimSummaryV2) => item.id;

/** Every claim on the selected employment, newest first. Offline: the rows already shown stay, labelled stale. */
export function ClaimsScreen() {
  const { palette } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const [status, setStatus] = useState<(typeof FILTERS)[number]>(undefined);
  const params = { employmentId: employmentId ?? undefined };
  const options = useApiV2(CLAIM_FORM, ClaimFormOptionsV2, params, signOut);
  const list = usePagedResource(CLAIMS, { ...params, status }, keyOf, signOut);
  const o = options.data;
  const ready = !!o?.enabled && !!o.employmentId;
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }} edges={['top']}>
    <PagedList list={list} keyOf={keyOf} emptyText={t('claimsEmpty')} contentContainerStyle={{ padding: 20, gap: 8 }}
      header={<View style={{ gap: 12 }}>
        <Button title={t('back')} kind="quiet" onPress={() => router.back()} />
        <Title>{t('claimsTitle')}</Title>
        {o && !o.enabled && <Muted>{t('claimsOff')}</Muted>}
        {o?.enabled && !o.employmentId && <Muted>{t('claimsNoEmployment')}</Muted>}
        {ready && (o.types.length > 0
          ? <Button title={t('claimsNew')} onPress={() => router.push('/claims/new')} />
          : <Muted>{t('claimsNoTypes')}</Muted>)}
        {!o && options.error && <Muted>{t('claimsNeedsConnection')}</Muted>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {FILTERS.map((f) => <Button key={f ?? 'all'} title={f ? t(CLAIM_STATUS_LABEL[f]) : t('claimsFilterAll')} kind={f === status ? 'primary' : 'quiet'} onPress={() => setStatus(f)} />)}
        </View>
      </View>}
      renderItem={(item) => <ClaimRow item={item} currency={o?.currency ?? null} onPress={() => router.push({ pathname: '/claims/[id]', params: { id: item.id } })} />} />
  </SafeAreaView>;
}

type Detail = { data: ClaimDetailResult | null; error: Error | null; loading: boolean; reload: () => void };
/** One claim, scoped like useApi: a change of identity, connection, locale or employment hides the old answer. */
export function useClaimDetail(id: string, employmentId: string | null, onSignInRequired: () => void): Detail {
  const owner = authGeneration(), namespace = identityNamespace(), origin = config.apiUrl, locale = appLocale();
  const key = JSON.stringify([owner, namespace, origin, locale, id, employmentId]);
  const [state, setState] = useState<{ key: string; data: ClaimDetailResult | null; error: Error | null; loading: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setState((prior) => ({ key, data: prior?.key === key ? prior.data : null, error: null, loading: true }));
    let path: `v2/${string}`;
    try { path = claimPath(id); } catch (e) { setState({ key, data: null, error: e as Error, loading: false }); return; }
    apiGetV2(path, ClaimDetailResult, { employmentId: employmentId ?? undefined }, controller.signal).then(
      (data) => { if (live && authGeneration() === owner) setState({ key, data, error: null, loading: false }); },
      (error: Error) => {
        if (!live || authGeneration() !== owner) return;
        if (error instanceof SignInRequiredError) onSignInRequired();
        // A refused or signed-out read keeps nothing; an outage keeps what was shown, labelled stale.
        setState((prior) => ({ key, data: error instanceof RequestRejectedError || error instanceof SignInRequiredError ? null : prior?.key === key ? prior.data : null, error, loading: false }));
      });
    return () => { live = false; controller.abort(); };
  }, [key, tick, onSignInRequired]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return state?.key === key ? { ...state, reload } : { data: null, error: null, loading: true, reload };
}

type Command = { kind: 'cancel' | 'delete' | 'submit'; body: { requestId: string; ids?: string[] } };

function decisionLine(claim: ClaimDetailV2): string | null {
  const d = claim.decision;
  if (!d) return null;
  const date = fmtInstant(d.decidedAt);
  const rejected = claim.status === 'rejected';
  if (d.decidedByName) return t(rejected ? 'claimsRejectedBy' : 'claimsApprovedBy', { name: d.decidedByName, date });
  return t(rejected ? 'claimsRejectedOn' : 'claimsApprovedOn', { date });
}
function payoutLine(claim: ClaimDetailV2): string | null {
  const p = claim.payout;
  if (!p) return null;
  if (p.paidAt) return t(p.route === 'payroll' ? 'claimsPaidPayroll' : 'claimsPaidReimbursement', { date: fmtInstant(p.paidAt) });
  if (p.route === 'payroll') return t(p.scheduledInPayroll ? 'claimsPayrollScheduled' : 'claimsPayrollAwaiting');
  return t('claimsReimbursementAwaiting');
}

/** One claim: what was claimed, its receipts, how it was decided and paid, and the commands the kernel allows. */
export function ClaimDetailScreen({ id }: { id: string }) {
  const { palette } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const detail = useClaimDetail(id, employmentId ?? null, signOut);
  const [command, setCommand] = useState<{ value: Command; phase: 'sending' | 'uncertain' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const flight = useRef(false);
  const claim = detail.data?.outcome === 'found' ? detail.data.claim : null;
  // Online only: an action needs a fresh answer from the server, never a stale copy.
  const online = !!claim && !detail.error && !detail.loading;
  const busy = command?.phase === 'sending';

  async function send(value: Command) {
    if (flight.current) return;
    flight.current = true; const owner = authGeneration();
    setCommand({ value, phase: 'sending' }); setNotice(null);
    try {
      const params = { employmentId: employmentId ?? undefined };
      const result = value.kind === 'cancel'
        ? await apiPostV2(claimPath(id, 'cancel'), ClaimCancelResult, value.body, params)
        : value.kind === 'delete'
          ? await apiPostV2(claimPath(id, 'delete'), ClaimDeleteResult, value.body, params)
          : await apiPostV2('v2/claims/drafts/submit', ClaimDraftsSubmitResult, value.body, params);
      assertAuthGeneration(owner);
      setCommand(null);
      if (result.outcome === 'refused') { setNotice(claimRefusalText(result)); detail.reload(); return; }
      if (result.outcome === 'deleted') { setDeleted(true); return; }
      setNotice(t(result.outcome === 'cancelled' ? 'claimsCancelledDone' : 'claimsSubmittedDone'));
      detail.reload();
    } catch (e) {
      if (e instanceof SignInRequiredError) { setCommand(null); void signOut(); }
      // A 4xx was refused before anything was recorded; anything else may or may not have been: keep the reference.
      else if (e instanceof RequestRejectedError) { setCommand(null); setNotice(t('genericError')); detail.reload(); }
      else setCommand({ value, phase: 'uncertain' });
    } finally { flight.current = false; }
  }
  function confirm(kind: Command['kind']) {
    if (!claim) return;
    const requestId = randomUUID();
    const body = kind === 'submit' ? { requestId, ids: [claim.id] } : { requestId };
    const what = t('claimsConfirmWhat', { type: claim.claimType, amount: claimMoney(claim.amount, claim.currency), date: claim.incurredOn });
    const [title, message, go] = kind === 'cancel' ? ['claimsCancelConfirmTitle', 'claimsCancelConfirm', 'claimsCancel'] as const
      : kind === 'delete' ? ['claimsDeleteConfirmTitle', 'claimsDeleteConfirm', 'claimsDeleteDraft'] as const
        : ['claimsSubmitConfirmTitle', 'claimsSubmitDraftConfirm', 'claimsSubmitDraft'] as const;
    Alert.alert(t(title), t(message, { what }), [
      { text: t('cancel'), style: 'cancel' },
      { text: t(go), style: kind === 'submit' ? 'default' : 'destructive', onPress: () => void send({ kind, body }) },
    ]);
  }

  if (deleted) return <Screen>
    <Text accessibilityRole="alert" style={{ color: palette.text, fontSize: 18, lineHeight: 26 }}>{t('claimsDeletedDone')}</Text>
    <Button title={t('claimsBackToList')} onPress={() => router.back()} />
  </Screen>;

  const decision = claim ? decisionLine(claim) : null, payout = claim ? payoutLine(claim) : null;
  const heading = (text: string) => <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{text}</Text>;
  const actions = claim?.actions;
  const offered = !!actions && (actions.cancel || actions.submitDraft || actions.deleteDraft || actions.editDraft);
  return <Screen onRefresh={detail.reload}>
    <Button title={t('back')} kind="quiet" onPress={() => router.back()} />
    <LoadState loading={detail.loading} hasData={detail.data != null} error={detail.error} onRetry={detail.reload} />
    {notice && <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{notice}</Text>}
    {detail.data?.outcome === 'refused' && <Muted>{t('claimsDetailMissing')}</Muted>}
    {claim && <>
      <Title>{claim.claimItem ? `${claim.claimType} · ${claim.claimItem}` : claim.claimType}</Title>
      <Text style={{ color: palette.text, fontSize: 20, fontWeight: '600' }}>{claim.amountProvisional && claim.amount ? t('claimsProvisional', { amount: claimMoney(claim.amount, claim.currency) }) : claimMoney(claim.amount, claim.currency)}</Text>
      <ClaimStatusBadge status={claim.status} />
      {claim.amountProvisional && <Muted>{t('claimsDraftNote')}</Muted>}
      <Row label={t('claimsIncurredOn')} value={claim.incurredOn} />
      {claim.quantityKm && <Row label={t('claimsDistance')} value={t('claimsKm', { km: claim.quantityKm })} />}
      {claim.mileage && <Card>
        {heading(t('claimsMileageHeading'))}
        {claim.mileage.bands.map((b) => <Muted key={b.fromKm}>{t('claimsMileageBand', { from: b.fromKm, to: b.toKm ?? '∞', km: b.km, rate: b.ratePerKm, amount: claimMoney(b.amount, claim.currency) })}</Muted>)}
        <Muted>{t('claimsMileageTable', { date: claim.mileage.tableValidFrom })}</Muted>
      </Card>}
      {claim.description && <Muted>{claim.description}</Muted>}
      {claim.fields.length > 0 && <Card>{heading(t('claimsFieldsHeading'))}<ClaimAnswers fields={claim.fields} /></Card>}
      <Card>
        {heading(t('claimsReceiptsHeading'))}
        {claim.receipts.length === 0 ? <Muted>{t('claimsNoReceipts')}</Muted>
          : claim.receipts.map((r) => <ReceiptLink key={r.id} receipt={r} onSignInRequired={signOut} open={() => ownReceiptDownload(claim.id, r.id, employmentId ?? null)} />)}
      </Card>
      {(claim.submittedAt || decision || payout) && <Card>
        {heading(t('claimsProgressHeading'))}
        {claim.submittedAt && <Muted>{t('claimsFiledOn', { date: fmtInstant(claim.submittedAt) })}</Muted>}
        {claim.status === 'pending' && <Muted>{t('claimsAwaitingApproval')}</Muted>}
        {decision && <Muted>{decision}</Muted>}
        {claim.decision?.rejectReason && <Row label={t('claimsRejectionReason')} value={claim.decision.rejectReason} />}
        {payout && <Muted>{payout}</Muted>}
      </Card>}
      {(claim.status === 'rejected' || claim.status === 'cancelled') && <Muted>{t('claimsFinal')}</Muted>}

      {command?.phase === 'uncertain' && <Card>
        <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{t('claimsCommandUncertain')}</Text>
        <Button title={t('claimsCommandRetry')} onPress={() => void send(command.value)} />
        <Button title={t('claimsCommandDismiss')} kind="quiet" onPress={() => { setCommand(null); detail.reload(); }} />
      </Card>}
      {!command && offered && !online && <Muted>{t('claimsCommandsOnline')}</Muted>}
      {!command && actions?.editDraft && <Button title={t('claimsEditDraft')} kind="quiet" disabled={!online || busy} onPress={() => router.push({ pathname: '/claims/new', params: { draft: claim.id } })} />}
      {!command && actions?.submitDraft && <Button title={t('claimsSubmitDraft')} disabled={!online || busy} onPress={() => confirm('submit')} />}
      {!command && actions?.deleteDraft && <Button title={t('claimsDeleteDraft')} kind="quiet" disabled={!online || busy} onPress={() => confirm('delete')} />}
      {!command && actions?.cancel && <Button title={t('claimsCancel')} kind="quiet" disabled={!online || busy} onPress={() => confirm('cancel')} />}
      {busy && <Muted>{t('claimsCommandSending')}</Muted>}
    </>}
  </Screen>;
}
