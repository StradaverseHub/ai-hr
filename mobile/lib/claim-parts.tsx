/**
 * M11 — pieces the employee's claim screens (claims.tsx, claim-form.tsx) and the approver's claim task
 * (approval-decision.tsx) share: the amount label, the custom-field answers, the receipt viewer, and receipt capture.
 *
 * THE APP COMPUTES NOTHING. Amounts arrive as two-place decimal strings and are only grouped for reading
 * (ui.tsx fmtMoney) and prefixed with the company's currency when the server sends one.
 *
 * RECEIPTS ON THE PHONE (D11). A receipt being written is compressed (a photo, to JPEG under the 10 MB limit) and
 * ADOPTED into the protected folder (protected-document.ts) from the picker's own cache, which is emptied of it at
 * once; it stays there until it is uploaded or discarded, and every protected-folder sweep (launch, background,
 * logout, employment switch) takes it. A receipt opened to look at is downloaded there too and deleted when the view
 * closes or the screen goes. A JPEG or PNG is shown in the app; there is no in-app PDF viewer, so a PDF is not kept.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState, Image, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { DesignText as Text, useTenantDesign } from './design';
import { adoptProtectedDocument, type ProtectedDocument } from './protected-document';
import { SignInRequiredError } from './errors';
import { t } from './i18n';
import type { LocalAttachment } from './journey-drafts';
import { Button, Muted, Row, fmtMoney } from './ui';
import { CLAIM_RECEIPT_MAX_BYTES, type ClaimFieldAnswerV2, type ClaimReceiptV2 } from '../../lib/mobile-api/v2/claims';
import type { MobileRefusal } from '../../lib/mobile-api/v2/common';

/** An amount as the server sent it: the company's currency (when known), then the grouped figure; never a computed one. */
export function claimMoney(amount: string | null, currency: string | null): string {
  if (amount == null) return t('claimsNoAmount');
  return currency ? `${currency} ${fmtMoney(amount)}` : fmtMoney(amount);
}
/** Kilobytes for a receipt's size line, at least 1. */
export const receiptKb = (bytes: number) => String(Math.max(1, Math.round(bytes / 1024)));

/** The custom-field answers, in the order the server sent them. */
export function ClaimAnswers({ fields }: { fields: ClaimFieldAnswerV2[] }) {
  if (!fields.length) return null;
  return <View style={{ gap: 6 }}>
    {fields.map((f) => <Row key={f.key} label={f.label} value={f.value === true ? t('claimsYes') : f.value === false ? t('claimsNo') : f.value ?? '—'} />)}
  </View>;
}

// ── Viewing a stored receipt ─────────────────────────────────────────────────────────────────────────────────────

type Opened = { outcome: 'file'; document: ProtectedDocument } | MobileRefusal;
type ViewState = 'closed' | 'loading' | 'image' | 'pdf' | 'refused' | 'error';
/**
 * One stored receipt: its name and size, and View. An image is downloaded into the protected folder and shown until
 * Hide, or until the screen goes; a PDF is not kept (no viewer) and says to open it on the web. `open` is the route
 * the caller is admitted to (the employee's own claim, or the approver's assigned task).
 */
export function ReceiptLink({ receipt, open, onSignInRequired }: { receipt: ClaimReceiptV2; open: () => Promise<Opened>; onSignInRequired: () => void }) {
  const { palette } = useTenantDesign();
  const [state, setState] = useState<{ phase: ViewState; uri?: string }>({ phase: 'closed' });
  const held = useRef<ProtectedDocument | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; held.current?.delete(); held.current = null; }; }, []);
  function hide() { held.current?.delete(); held.current = null; setState({ phase: 'closed' }); }
  async function show() {
    if (state.phase === 'loading') return;
    setState({ phase: 'loading' });
    try {
      const out = await open();
      if (out.outcome !== 'file') { if (live.current) setState({ phase: 'refused' }); return; }
      // Gone while it downloaded, or a PDF the app cannot show: nothing is kept.
      if (!live.current || out.document.mimeType === 'application/pdf') { out.document.delete(); if (live.current) setState({ phase: 'pdf' }); return; }
      held.current?.delete(); held.current = out.document;
      setState({ phase: 'image', uri: out.document.uri });
    } catch (error) {
      if (error instanceof SignInRequiredError) onSignInRequired();
      if (live.current) setState({ phase: 'error' });
    }
  }
  const showing = state.phase === 'image' && state.uri;
  return <View style={{ gap: 6 }}>
    <Row label={receipt.fileName} value={t('claimsReceiptSize', { kb: receiptKb(receipt.sizeBytes) })} />
    {showing
      ? <><Image accessibilityLabel={receipt.fileName} source={{ uri: state.uri }} resizeMode="contain" style={{ width: '100%', height: 420, backgroundColor: palette.card }} />
        <Button title={t('claimsReceiptHide')} kind="quiet" onPress={hide} /></>
      : <Button title={state.phase === 'loading' ? t('loading') : t('claimsReceiptView')} accessibilityLabel={`${t('claimsReceiptView')}: ${receipt.fileName}`} kind="quiet" disabled={state.phase === 'loading'} onPress={() => void show()} />}
    {state.phase === 'pdf' && <Muted>{t('claimsReceiptPdfOnWeb')}</Muted>}
    {state.phase === 'refused' && <Muted>{t('claimsReceiptUnavailable')}</Muted>}
    {state.phase === 'error' && <Text accessibilityRole="alert" style={{ color: palette.text }}>{t('claimsReceiptFailed')}</Text>}
  </View>;
}

// ── Capturing a new receipt ──────────────────────────────────────────────────────────────────────────────────────

/** A capture that cannot proceed; the message is the app's own sentence. */
export class ReceiptCaptureError extends Error {
  constructor(message: string) { super(message); this.name = 'ReceiptCaptureError'; }
}
/** The long edge a receipt photo is scaled down to: legible print, far under the 10 MB limit as a JPEG. */
const RECEIPT_EDGE = 2048;
const inCache = (uri: string) => { try { return uri.startsWith(Paths.cache.uri); } catch { return false; } };
const discard = (uri: string | undefined) => { if (!uri || !inCache(uri)) return; try { const f = new File(uri); if (f.exists) f.delete(); } catch { /* purged at launch */ } };

/**
 * A receipt photo from the camera or the photo library, as a JPEG in the protected folder; null when the person
 * backs out. Only the picker's own cache copy is ever deleted (never a photo in the person's library).
 */
export async function captureReceiptPhoto(source: 'camera' | 'library', assertCurrent?: () => void): Promise<LocalAttachment | null> {
  assertCurrent?.();
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new ReceiptCaptureError(t('claimsCameraPermission'));
  }
  if (AppState.currentState !== 'active') throw new ReceiptCaptureError(t('unlockContinue'));
  assertCurrent?.();
  const result = source === 'camera'
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9, exif: false })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9, exif: false, allowsMultipleSelection: false });
  if (result.canceled) return null;
  const original = result.assets[0];
  const image = ImageManipulator.manipulate(original.uri);
  let rendered: Awaited<ReturnType<typeof image.renderAsync>> | undefined;
  let saved: string | undefined;
  try {
    if (Math.max(original.width, original.height) > RECEIPT_EDGE) image.resize(original.width >= original.height ? { width: RECEIPT_EDGE } : { height: RECEIPT_EDGE });
    rendered = await image.renderAsync();
    saved = (await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.7 })).uri;
    const document = adoptProtectedDocument(saved, 'image/jpeg');
    saved = undefined; // adopted: the manipulator's copy is already gone
    if (!document.size || document.size > CLAIM_RECEIPT_MAX_BYTES) { document.delete(); throw new ReceiptCaptureError(t('claimsReceiptTooLarge')); }
    return { uri: document.uri, name: 'receipt.jpg', mimeType: 'image/jpeg', size: document.size };
  } finally {
    image.release(); rendered?.release();
    discard(saved); discard(original.uri);
  }
}

/** A PDF receipt from the device's files, adopted into the protected folder; null when the person backs out. */
export async function pickReceiptPdf(assertCurrent?: () => void): Promise<LocalAttachment | null> {
  assertCurrent?.();
  const result = await DocumentPicker.getDocumentAsync({ type: ['application/pdf'], copyToCacheDirectory: true, multiple: false });
  if (result.canceled) return null;
  const picked = result.assets[0];
  let size = picked.size ?? 0;
  try { if (!size) size = new File(picked.uri).size; } catch { size = 0; }
  if (!size || size > CLAIM_RECEIPT_MAX_BYTES) { discard(picked.uri); throw new ReceiptCaptureError(t(size ? 'claimsReceiptTooLarge' : 'claimsReceiptEmpty')); }
  const document = adoptProtectedDocument(picked.uri, 'application/pdf');
  return { uri: document.uri, name: (picked.name || 'receipt.pdf').slice(0, 200), mimeType: 'application/pdf', size: document.size };
}
