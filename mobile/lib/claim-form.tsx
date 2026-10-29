/**
 * M11 — the claim form: file a new claim, save it as a draft (D11: the server's own `draft` row, which reserves
 * nothing), or edit one of the caller's own drafts and file or re-save it.
 *
 * THE APP DECIDES NOTHING. The types, items, custom fields, the receipt requirement and date window, what the amount
 * is asked as, and the balances come from the server (getEmployeeClaimTypes). A mileage figure is the KERNEL's
 * (GET v2/claims/mileage-preview, the rule submit uses), never the app's. Only the INPUT FORMAT is checked here (a
 * date, a two-place amount, a distance), so the server is not sent a request it would answer 400; every claim rule —
 * limits, the receipt window and requirement, items, required fields — is the kernel's, at submit, and its refusal is
 * shown in its own words.
 *
 * IN MEMORY ONLY (D10, D11). What is typed lives in the journey-draft provider above the lock (journey-drafts.tsx),
 * so the camera or file picker — which locks the app — does not lose it; the receipt lives in the protected folder
 * (claim-parts.tsx). Nothing is persisted on the phone. A command runs online, after a confirmation, under a client
 * requestId the server's receipt replays: a lost answer is retried with the SAME reference (and the same receipt), so a
 * claim is never filed twice. A background sweep may take the receipt while the person is away; it is then asked for
 * again, never silently dropped from a claim.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { DesignText as Text, useTenantDesign } from './design';
import { apiGetV2, apiPostFormV2, useApiV2 } from './api';
import { assertAuthGeneration, authGeneration } from './auth';
import { appendAttachment } from './capture';
import { RequestRejectedError, SignInRequiredError } from './errors';
import { t, type MessageKey } from './i18n';
import { removeLocalFile, useJourneyDrafts, type ClaimDraft, type ClaimFormValues, type LocalAttachment } from './journey-drafts';
import { PickerField } from './leave-request-form';
import { protectedDocumentExists } from './protected-document';
import { useSession } from './session';
import { Button, Card, LoadState, Muted, Row, Screen, Title } from './ui';
import { captureReceiptPhoto, claimMoney, pickReceiptPdf, receiptKb } from './claim-parts';
import { CLAIM_FORM, claimPath, claimRefusalText } from './claims';
import {
  ClaimDetailResult, ClaimDraftResult, ClaimFormOptionsV2, ClaimKmInput, ClaimMoneyInput, ClaimSubmitResult, MileagePreviewResult,
  type ClaimDetailV2, type ClaimFieldDefV2, type ClaimFormTypeV2,
} from '../../lib/mobile-api/v2/claims';

/** A draft read from the server, as the form's values (number and money answers as text). */
export function formOfDraft(c: ClaimDetailV2): ClaimFormValues {
  return {
    claimTypeId: c.claimTypeId, claimItemId: c.claimItemId ?? undefined,
    amount: c.amount ?? '', quantityKm: c.quantityKm ?? '', incurredOn: c.incurredOn, description: c.description ?? '',
    fieldValues: Object.fromEntries(c.fields.filter((f) => f.value != null).map((f) => [f.key, f.value as string | boolean])),
  };
}

/**
 * The command body exactly as the contract takes it: the amount only when the type asks for one, the distance only for
 * THE mileage type, custom answers only for the type's own fields.
 */
export function claimCommandBody(d: ClaimDraft, type: ClaimFormTypeV2): Record<string, unknown> {
  const f = d.form;
  const body: Record<string, unknown> = { requestId: d.requestId, claimTypeId: f.claimTypeId, incurredOn: f.incurredOn };
  if (d.draftId) body.draftId = d.draftId;
  if (f.claimItemId && type.items.some((i) => i.id === f.claimItemId)) body.claimItemId = f.claimItemId;
  if (type.amountEntry === 'entered' && f.amount.trim()) body.amount = f.amount.trim();
  if (type.amountEntry === 'distance' && f.quantityKm.trim()) body.quantityKm = f.quantityKm.trim();
  if (f.description.trim()) body.description = f.description.trim();
  const answers = Object.fromEntries(type.fields.filter((fd) => Object.prototype.hasOwnProperty.call(f.fieldValues, fd.key) && f.fieldValues[fd.key] !== '').map((fd) => [fd.key, f.fieldValues[fd.key]]));
  if (Object.keys(answers).length) body.fieldValues = answers;
  return body;
}

/** The input format only (the contract's): a problem the server would answer 400, never a claim rule. */
export function inputProblem(d: ClaimDraft, type: ClaimFormTypeV2): MessageKey | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.form.incurredOn)) return 'claimsInvalidDate';
  if (type.amountEntry === 'entered' && d.form.amount.trim() && !ClaimMoneyInput.safeParse(d.form.amount).success) return 'claimsInvalidAmount';
  if (type.amountEntry === 'distance' && d.form.quantityKm.trim() && !ClaimKmInput.safeParse(d.form.quantityKm).success) return 'claimsInvalidKm';
  return null;
}

type Preview = { key: string; loading: boolean; result: MileagePreviewResult | null; failed: boolean };

/** The balance lines for the chosen type (and item) today, as the server computed them. */
function BalanceCard({ type, itemId, currency }: { type: ClaimFormTypeV2; itemId: string | undefined; currency: string | null }) {
  const { palette } = useTenantDesign();
  const b = type.balance, m = (a: string) => claimMoney(a, currency), lines: string[] = [];
  if (b.annualLimit != null && b.remainingThisYear != null) lines.push(t('claimsBalanceYear', { remaining: m(b.remainingThisYear), limit: m(b.annualLimit) }));
  if (b.monthlyLimit != null && b.remainingThisMonth != null) lines.push(t('claimsBalanceMonth', { remaining: m(b.remainingThisMonth), limit: m(b.monthlyLimit) }));
  if (b.blockLimit != null && b.remainingThisBlock != null && b.blockEndsOn) lines.push(t('claimsBalanceBlock', { remaining: m(b.remainingThisBlock), date: b.blockEndsOn }));
  if (b.lifetimeLimit != null) lines.push(t('claimsBalanceLifetime', { used: m(b.usedLifetime), limit: m(b.lifetimeLimit) }));
  if (b.perClaimCap != null) lines.push(t('claimsBalanceCap', { cap: m(b.perClaimCap) }));
  if (b.maxClaimsPerYear != null) lines.push(t('claimsBalanceCount', { used: b.claimsUsedThisYear, max: b.maxClaimsPerYear }));
  if (b.reservedThisYear !== '0.00') lines.push(t('claimsBalanceReserved', { amount: m(b.reservedThisYear) }));
  const item = itemId ? b.items.find((i) => i.claimItemId === itemId) : undefined;
  if (item?.annualLimit != null && item.remainingThisYear != null) lines.push(t('claimsBalanceItemYear', { item: item.itemName, remaining: m(item.remainingThisYear), limit: m(item.annualLimit) }));
  if (item?.monthlyLimit != null && item.remainingThisMonth != null) lines.push(t('claimsBalanceItemMonth', { item: item.itemName, remaining: m(item.remainingThisMonth), limit: m(item.monthlyLimit) }));
  if (item?.perClaimCap != null) lines.push(t('claimsBalanceItemCap', { item: item.itemName, cap: m(item.perClaimCap) }));
  if (!lines.length) return null;
  return <Card>
    <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{t('claimsBalanceHeading')}</Text>
    {lines.map((line) => <Muted key={line}>{line}</Muted>)}
  </Card>;
}

/** New claim (no `draftId`), or the caller's own draft `draftId`. */
export function ClaimFormScreen({ draftId }: { draftId?: string }) {
  const { palette, design } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const { claim: draft, putClaim } = useJourneyDrafts();
  const options = useApiV2(CLAIM_FORM, ClaimFormOptionsV2, { employmentId: employmentId ?? undefined }, signOut);
  const o = options.data;
  const target = o?.enabled ? o.employmentId : null;
  const mine = draft && draft.draftId === draftId ? draft : null;
  const type = mine && o ? o.types.find((x) => x.id === mine.form.claimTypeId) : undefined;
  const flight = useRef(false);
  const [draftLoad, setDraftLoad] = useState<'loading' | 'missing' | 'failed' | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const sending = mine?.phase === 'sending', disabled = sending || mine?.phase === 'uncertain';
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 12 : 4;

  // A finished claim is not resumed by "New claim".
  useEffect(() => { if (!draftId && draft && !draft.draftId && draft.phase === 'done') putClaim(null); }, []);
  // Editing a draft: read it once from the server (it is the only copy) unless this very draft is already in memory.
  useEffect(() => {
    if (!draftId || mine || !target) return;
    let live = true; const owner = authGeneration();
    setDraftLoad('loading');
    let path: `v2/${string}`;
    try { path = claimPath(draftId); } catch { setDraftLoad('missing'); return; }
    apiGetV2(path, ClaimDetailResult, { employmentId: target }).then((r) => {
      if (!live || authGeneration() !== owner) return;
      if (r.outcome !== 'found' || r.claim.status !== 'draft') { setDraftLoad('missing'); return; }
      if (draft) removeLocalFile(draft.receipt);
      putClaim({ employmentId: target, requestId: randomUUID(), draftId: r.claim.id, existingReceipts: r.claim.receipts.length, form: formOfDraft(r.claim), phase: 'edit' });
      setDraftLoad(null);
    }, (error: Error) => {
      if (!live) return;
      if (error instanceof SignInRequiredError) void signOut();
      setDraftLoad('failed');
    });
    return () => { live = false; };
  }, [draftId, !!mine, target]);

  function begin(choice: ClaimFormTypeV2) {
    if (!o || !target) return;
    if (draft && draft !== mine) removeLocalFile(draft.receipt);
    putClaim({ employmentId: target, requestId: randomUUID(), form: { claimTypeId: choice.id, amount: '', quantityKm: '', incurredOn: o.today, description: '', fieldValues: {} }, phase: 'edit' });
  }
  /** Every edit renews the reference: a changed claim is a different command. */
  function edit(patch: Partial<ClaimFormValues>) {
    if (!mine || disabled) return;
    putClaim({ ...mine, form: { ...mine.form, ...patch }, requestId: randomUUID(), phase: 'edit', message: undefined }, mine.requestId);
  }
  function answer(field: ClaimFieldDefV2, value: string | boolean) {
    if (!mine) return;
    edit({ fieldValues: { ...mine.form.fieldValues, [field.key]: value } });
  }
  function discard() {
    if (!mine) return;
    removeLocalFile(mine.receipt); putClaim(null); router.back();
  }

  async function attach(kind: 'camera' | 'library' | 'pdf') {
    if (!mine || disabled || flight.current) return;
    flight.current = true; const owner = authGeneration(), at = mine;
    let file: LocalAttachment | null = null;
    try {
      file = kind === 'pdf' ? await pickReceiptPdf() : await captureReceiptPhoto(kind);
      if (!file) return;
      assertAuthGeneration(owner);
      // The picker locked the app; the draft lives above the lock, so this lands whether or not the screen did.
      if (putClaim({ ...at, receipt: file, requestId: randomUUID(), message: undefined }, at.requestId)) { removeLocalFile(at.receipt); file = null; }
    } catch (error) {
      putClaim({ ...at, message: error instanceof Error ? error.message : t('genericError') }, at.requestId);
      if (error instanceof SignInRequiredError) void signOut();
    } finally { removeLocalFile(file ?? undefined); flight.current = false; }
  }
  function removeReceipt() {
    if (!mine || disabled) return;
    removeLocalFile(mine.receipt);
    putClaim({ ...mine, receipt: undefined, requestId: randomUUID(), message: undefined }, mine.requestId);
  }

  const previewKey = mine && type ? JSON.stringify([type.id, mine.form.quantityKm.trim(), mine.form.incurredOn]) : '';
  const fresh = preview && preview.key === previewKey ? preview : null;
  async function price() {
    if (!mine || !type || type.amountEntry !== 'distance' || !target) return;
    const km = mine.form.quantityKm.trim();
    if (!ClaimKmInput.safeParse(km).success || !/^\d{4}-\d{2}-\d{2}$/.test(mine.form.incurredOn)) { putClaim({ ...mine, message: t('claimsInvalidKm') }, mine.requestId); return; }
    const key = previewKey;
    setPreview({ key, loading: true, result: null, failed: false });
    try {
      const result = await apiGetV2('v2/claims/mileage-preview', MileagePreviewResult, { employmentId: target, claimTypeId: type.id, km, incurredOn: mine.form.incurredOn });
      setPreview((p) => (p?.key === key ? { key, loading: false, result, failed: false } : p));
    } catch (error) {
      if (error instanceof SignInRequiredError) void signOut();
      setPreview((p) => (p?.key === key ? { key, loading: false, result: null, failed: true } : p));
    }
  }

  async function send(action: 'submit' | 'save') {
    if (!mine || !type || !target || flight.current) return;
    const problem = inputProblem(mine, type);
    if (problem) { putClaim({ ...mine, message: t(problem) }, mine.requestId); return; }
    if (mine.receipt && !protectedDocumentExists(mine.receipt.uri)) {
      // Swept while the person was away. An uncertain command cannot be resent with different bytes: start over.
      putClaim({ ...mine, receipt: undefined, phase: 'edit', action: undefined, requestId: randomUUID(), message: t(mine.phase === 'uncertain' ? 'claimsUncertainReceiptGone' : 'claimsReceiptGone') }, mine.requestId);
      return;
    }
    flight.current = true; const owner = authGeneration(), at = mine;
    if (!putClaim({ ...at, phase: 'sending', action, message: undefined }, at.requestId)) { flight.current = false; return; }
    try {
      const form = new FormData();
      form.append('command', JSON.stringify(claimCommandBody(at, type)));
      if (at.receipt) appendAttachment(form, 'receipt', at.receipt);
      const params = { employmentId: target };
      const result = action === 'submit'
        ? await apiPostFormV2('v2/claims', ClaimSubmitResult, form, params)
        : await apiPostFormV2('v2/claims/drafts', ClaimDraftResult, form, params);
      assertAuthGeneration(owner);
      if (result.outcome === 'refused') {
        // A refusal records nothing; the edits stay for the person to fix.
        putClaim({ ...at, phase: 'edit', action: undefined, requestId: randomUUID(), message: claimRefusalText(result) }, at.requestId);
        return;
      }
      removeLocalFile(at.receipt);
      putClaim({ ...at, receipt: undefined, phase: 'done', action, message: undefined, result: { kind: result.outcome === 'submitted' ? 'submitted' : 'saved', id: result.id } }, at.requestId);
    } catch (error) {
      if (error instanceof SignInRequiredError) { void signOut(); return; }
      // A 4xx was refused before anything was recorded; anything else may or may not have been: keep the reference.
      if (error instanceof RequestRejectedError) putClaim({ ...at, phase: 'edit', action: undefined, requestId: randomUUID(), message: t('genericError') }, at.requestId);
      else putClaim({ ...at, phase: 'uncertain', action, message: undefined }, at.requestId);
    } finally { flight.current = false; }
  }
  function confirm(action: 'submit' | 'save') {
    if (!mine || !type) return;
    const currency = o?.currency ?? null;
    const amount = type.amountEntry === 'fixed' ? claimMoney(type.fixedAmount, currency)
      : type.amountEntry === 'distance' ? (fresh?.result?.outcome === 'priced' ? claimMoney(fresh.result.amount, currency) : t('claimsPricedOnSubmit'))
        : mine.form.amount.trim() && ClaimMoneyInput.safeParse(mine.form.amount).success ? claimMoney(mine.form.amount.trim(), currency) : t('claimsNoAmount');
    const what = t('claimsConfirmWhat', { type: type.name, amount, date: mine.form.incurredOn });
    const receipt = mine.receipt ? mine.receipt.name : t('claimsNoNewReceipt');
    Alert.alert(t(action === 'submit' ? 'claimsSubmitConfirmTitle' : 'claimsSaveConfirmTitle'), t(action === 'submit' ? 'claimsSubmitConfirm' : 'claimsSaveConfirm', { what, receipt }), [
      { text: t('cancel'), style: 'cancel' },
      { text: t(action === 'submit' ? 'claimsSubmit' : 'claimsSaveDraft'), onPress: () => void send(action) },
    ]);
  }

  const heading = (text: string) => <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{text}</Text>;
  const input = (label: string, value: string, change: (v: string) => void, opts: { multiline?: boolean; numeric?: boolean; max?: number } = {}) =>
    <View style={{ gap: 6 }}>
      <Text style={{ color: palette.muted, fontSize: 14 }}>{label}</Text>
      <TextInput accessibilityLabel={label} editable={!disabled} value={value} onChangeText={change} multiline={opts.multiline} keyboardType={opts.numeric ? 'decimal-pad' : 'default'}
        maxLength={opts.max ?? (opts.multiline ? 2000 : 64)} placeholderTextColor={palette.muted}
        style={{ color: palette.text, minHeight: 48, borderWidth: 1, borderColor: palette.border, borderRadius: radius, padding: 12, fontSize: 16, textAlignVertical: 'top' }} />
    </View>;
  const check = (label: string, value: boolean, change: () => void) =>
    <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked: value, disabled }} disabled={disabled} onPress={change} style={{ minHeight: 48, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <View style={{ width: 24, height: 24, borderWidth: 1, borderColor: value ? palette.accent : palette.border, borderRadius: 4, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: palette.accent }}>{value ? '✓' : ''}</Text></View>
      <Text style={{ color: palette.text, flex: 1 }}>{label}</Text>
    </Pressable>;

  // ── States before the form ──
  if (!o) return <Screen onRefresh={options.reload}>
    <Button title={t('back')} kind="quiet" onPress={() => router.back()} />
    <LoadState loading={options.loading} hasData={false} error={options.error} onRetry={options.reload} />
    {options.error && <Muted>{t('claimsNeedsConnection')}</Muted>}
  </Screen>;
  if (!o.enabled || !target) return <Screen>
    <Button title={t('back')} kind="quiet" onPress={() => router.back()} />
    <Muted>{t(!o.enabled ? 'claimsOff' : 'claimsNoEmployment')}</Muted>
  </Screen>;
  if (draftId && !mine) return <Screen>
    <Button title={t('back')} kind="quiet" onPress={() => router.back()} />
    {draftLoad === 'missing' ? <Muted>{t('claimsDraftUnavailable')}</Muted>
      : draftLoad === 'failed' ? <><Muted>{t('claimsNeedsConnection')}</Muted><Button title={t('retry')} kind="quiet" onPress={() => setDraftLoad(null)} /></>
        : <LoadState loading hasData={false} error={null} onRetry={() => {}} />}
  </Screen>;
  if (mine?.phase === 'done' && mine.result) {
    const id = mine.result.id;
    return <Screen>
      <Text accessibilityRole="alert" style={{ color: palette.text, fontSize: 20, fontWeight: '600' }}>{t(mine.result.kind === 'submitted' ? 'claimsSubmittedDone' : 'claimsDraftSavedDone')}</Text>
      <Button title={t('claimsViewClaim')} onPress={() => { putClaim(null); router.replace({ pathname: '/claims/[id]', params: { id } }); }} />
      <Button title={t('claimsBackToList')} kind="quiet" onPress={() => { putClaim(null); router.back(); }} />
    </Screen>;
  }
  if (!mine) return <Screen onRefresh={options.reload}>
    <Button title={t('back')} kind="quiet" onPress={() => router.back()} />
    <Title>{t('claimsNew')}</Title>
    {o.types.length === 0 ? <Muted>{t('claimsNoTypes')}</Muted> : <>
      <Muted>{t('claimsChooseType')}</Muted>
      {o.types.map((choice) => <Button key={choice.id} title={choice.name} kind="quiet" onPress={() => begin(choice)} />)}
    </>}
  </Screen>;

  // ── The form ──
  const currency = o.currency;
  return <Screen>
    <Button title={t('back')} kind="quiet" onPress={() => router.back()} />
    <Title>{mine.draftId ? t('claimsEditDraftTitle') : t('claimsNew')}</Title>
    {mine.message && <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{mine.message}</Text>}
    {!type ? <>
      <Muted>{t(mine.form.claimTypeId ? 'claimsTypeUnavailable' : 'claimsChooseType')}</Muted>
      {o.types.map((choice) => <Button key={choice.id} title={choice.name} kind="quiet" disabled={disabled} onPress={() => edit({ claimTypeId: choice.id, claimItemId: undefined, fieldValues: {} })} />)}
    </> : <>
      {heading(type.name)}
      {o.types.length > 1 && <Button title={t('claimsChangeType')} kind="quiet" disabled={disabled} onPress={() => edit({ claimTypeId: '', claimItemId: undefined, fieldValues: {} })} />}
      {type.items.length > 0 && <View style={{ gap: 8 }}>
        <Text style={{ color: palette.muted, fontSize: 14 }}>{t('claimsItem')} · {t('required')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {type.items.map((item) => <Button key={item.id} title={item.name} kind={item.id === mine.form.claimItemId ? 'primary' : 'quiet'} disabled={disabled} onPress={() => edit({ claimItemId: item.id })} />)}
        </View>
      </View>}

      {type.amountEntry === 'entered' && input(t('claimsAmount') + (currency ? ` (${currency})` : ''), mine.form.amount, (v) => edit({ amount: v }), { numeric: true, max: 14 })}
      {type.amountEntry === 'fixed' && <Row label={t('claimsAmount')} value={claimMoney(type.fixedAmount, currency)} />}
      {type.amountEntry === 'distance' && <View style={{ gap: 8 }}>
        {input(t('claimsDistanceKm'), mine.form.quantityKm, (v) => edit({ quantityKm: v }), { numeric: true, max: 11 })}
        <Button title={fresh?.loading ? t('loading') : t('claimsMileagePrice')} kind="quiet" disabled={disabled || !!fresh?.loading || !mine.form.quantityKm.trim()} onPress={() => void price()} />
        {fresh?.result?.outcome === 'priced' && <Card>
          <Text style={{ color: palette.text, fontWeight: '600' }}>{t('claimsMileagePriced', { amount: claimMoney(fresh.result.amount, currency) })}</Text>
          {(fresh.result.bands ?? []).map((b) => <Muted key={b.fromKm}>{t('claimsMileageBand', { from: b.fromKm, to: b.toKm ?? '∞', km: b.km, rate: b.ratePerKm, amount: claimMoney(b.amount, currency) })}</Muted>)}
        </Card>}
        {fresh?.result?.outcome === 'refused' && <Muted>{claimRefusalText(fresh.result)}</Muted>}
        {fresh?.failed && <Muted>{t('claimsNeedsConnection')}</Muted>}
        <Muted>{t('claimsMileageNote')}</Muted>
      </View>}

      <PickerField label={t('claimsIncurredOn')} mode="date" value={mine.form.incurredOn} today={o.today} disabled={!!disabled} onChange={(v) => edit({ incurredOn: v })} />
      <Muted>{t('claimsDateWindow', { from: type.earliestIncurredOn, to: o.today })}</Muted>
      {input(t('claimsDescription'), mine.form.description, (v) => edit({ description: v }), { multiline: true })}

      {type.fields.map((field) => {
        const label = field.label + (field.required ? ` · ${t('required')}` : '');
        const value = mine.form.fieldValues[field.key];
        if (field.kind === 'boolean') return <View key={field.key}>{check(label, value === true, () => answer(field, value !== true))}</View>;
        if (field.kind === 'select') return <View key={field.key} style={{ gap: 8 }}>
          <Text style={{ color: palette.muted, fontSize: 14 }}>{label}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {field.options.map((choice) => <Button key={choice} title={choice} kind={value === choice ? 'primary' : 'quiet'} disabled={disabled} onPress={() => answer(field, choice)} />)}
          </View>
        </View>;
        if (field.kind === 'date') return <PickerField key={field.key} label={label} mode="date" value={typeof value === 'string' && value ? value : undefined} today={o.today} disabled={!!disabled} onChange={(v) => answer(field, v)} />;
        return <View key={field.key}>{input(label, typeof value === 'string' ? value : '', (v) => answer(field, v), { numeric: field.kind === 'number' || field.kind === 'money', max: 2000 })}</View>;
      })}

      <View style={{ gap: 8 }}>
        {heading(t('claimsReceiptHeading') + (type.requiresReceipt ? ` · ${t('required')}` : ''))}
        {!!mine.existingReceipts && <Muted>{t('claimsDraftHasReceipts', { n: mine.existingReceipts })}</Muted>}
        {mine.receipt && <>
          <Row label={mine.receipt.name} value={t('claimsReceiptSize', { kb: receiptKb(mine.receipt.size) })} />
          <Button title={t('claimsReceiptRemove')} kind="quiet" disabled={disabled} onPress={removeReceipt} />
        </>}
        <Button title={t('claimsReceiptCamera')} kind="quiet" disabled={disabled} onPress={() => void attach('camera')} />
        <Button title={t('claimsReceiptLibrary')} kind="quiet" disabled={disabled} onPress={() => void attach('library')} />
        <Button title={t('claimsReceiptPdf')} kind="quiet" disabled={disabled} onPress={() => void attach('pdf')} />
        <Muted>{t('claimsReceiptLimit')}</Muted>
      </View>

      <BalanceCard type={type} itemId={mine.form.claimItemId} currency={currency} />
    </>}

    {mine.phase === 'uncertain' && <Card>
      <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{t('claimsCommandUncertain')}</Text>
      <Button title={t('claimsCommandRetry')} onPress={() => void send(mine.action ?? 'submit')} />
      <Button title={t('claimsCheckList')} kind="quiet" onPress={() => router.push('/claims')} />
    </Card>}
    {mine.phase !== 'uncertain' && type && <>
      <Button title={sending && mine.action === 'submit' ? t('claimsCommandSending') : t('claimsSubmit')} disabled={!!disabled} onPress={() => confirm('submit')} />
      <Button title={sending && mine.action === 'save' ? t('claimsCommandSending') : t('claimsSaveDraft')} kind="quiet" disabled={!!disabled} onPress={() => confirm('save')} />
      <Muted>{t('claimsConfirmHint')}</Muted>
    </>}
    <Button title={t('claimsDiscard')} kind="quiet" disabled={!!disabled} onPress={discard} />
  </Screen>;
}
