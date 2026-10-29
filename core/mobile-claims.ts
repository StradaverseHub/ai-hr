/**
 * M11 — the employee's own expense claims on the phone: list, one claim, a receipt's bytes, the claim form's options,
 * the kernel's mileage preview, and the five commands. COMPOSITION ONLY: every fact and every rule belongs to the
 * claims kernel (core/claims.ts through its facade, packs/claims/service), the same owner the web's /claims page and
 * actions use. Nothing here prices, limits, validates or decides a claim.
 *
 *   list     listClaimsForEmployment (the web's own read), keyset-paged in memory, per-status counts
 *   detail   listClaimsForEmployment + claimRecordFacts (custom answers, mileage stamp, filing time, decision,
 *            rejection reason, payout route)
 *   receipt  getClaimAttachment, only for an attachment of the caller's own claim on the selected employment
 *   form     getEmployeeClaimTypes (types, items, custom fields, receipt rule and window, balances) + dateMinusDays
 *   preview  previewMileageClaim (THE submit rule, priceMileageTx)
 *   commands submitClaimWithAttachment · saveClaimDraft (+ submitDraftClaims for "edit and submit") · submitDraftClaims
 *            · deleteClaimDraft · cancelClaim — each in the mobile command receipt's transaction (the M11 kernel seam)
 *
 * SCOPE. `employmentId` is the caller's OWN claim-eligible employment, resolved by the route
 * (lib/mobile-api/claim-routes.ts claimEmployment: own, started, not past its last day, login not blocked — the
 * claims kernel's own subject rule, myOwnEmploymentSubjects({profileEdit:true})). Every read narrows to it, so a row
 * RLS would show a manager (a subordinate's claim) is absent here: `not_found`, never a subordinate's data.
 *
 * A REFUSAL ROLLS BACK AND IS NOT RECORDED. Ownership is checked INSIDE the receipt's run (after the replay lookup, so
 * a lost answer to a delete or a submit still replays), a kernel ClaimError aborts the transaction, and both are
 * mapped after withMobileCommandReceipt: nothing is recorded and a retry re-evaluates. Only an accepted command is
 * recorded and replayed. A receipt's identity (sha-256, size, sniffed type, name) is part of the command's intent, so
 * the same requestId with different bytes is `request_conflict`, never a second upload.
 *
 * Kept free of 'server-only' (mobile-command-receipt.ts says why).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { claimRequest, company, employment } from '../db/schema';
import * as claims from '../packs/claims/service';
import { isModuleEnabled, ModuleNotEnabledError } from './entitlements';
import { MobileCommandOwnerRequired, withMobileCommandReceipt } from './mobile-command-receipt';
import { todayInKualaLumpur } from '../lib/hr-date';
import { publicErrorMessage } from '../lib/public-error';
import { moneyText } from '../lib/mobile-api/money-text';
import { hasMobileBinarySignature, isMobileBinaryType, type MobileBinaryType } from '../lib/mobile-api/binary-types';
import { encodeCursor } from '../lib/mobile-api/v2/common';
import {
  CLAIM_RECEIPT_TYPES, CLAIM_STATUSES, CLAIMS_CURSOR, ClaimCancelResult, ClaimDeleteResult, ClaimDraftResult,
  ClaimDraftsSubmitResult, ClaimSubmitResult,
  type ClaimBalanceV2, type ClaimCommandRefusal, type ClaimCommandRefusalCode, type ClaimDetailResult, type ClaimDetailV2,
  type ClaimDraftCommand, type ClaimDraftsSubmitCommand, type ClaimFieldAnswerV2, type ClaimFormOptionsV2,
  type ClaimReceiptRefusal, type ClaimsPageV2, type ClaimStatusV2, type ClaimSubmitCommand, type ClaimSummaryV2,
  type MileagePreviewResult,
} from '../lib/mobile-api/v2/claims';

type ClaimRow = Awaited<ReturnType<typeof claims.listClaimsForEmployment>>[number];
type Facts = claims.ClaimRecordFacts;

const NOT_FOUND = { outcome: 'refused', code: 'not_found' } as const;
const ZERO_COUNTS = { draft: 0, pending: 0, approved: 0, rejected: 0, cancelled: 0, paid: 0 };
export const claimsEnabled = (ctx: SessionContext) => isModuleEnabled(ctx, 'claims');

/** A required amount (a sum the kernel always computes); a missing one is a contract fault, never a printed zero. */
function sum(n: unknown): string {
  const text = moneyText(n);
  if (text === null) throw new Error('Claim figure is not a recorded amount');
  return text;
}
/** A non-money decimal (km, a rate per km) as text, at most six places; null when absent. */
export function decimalText(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  return String(Number(n.toFixed(6)));
}

/** The claimant's company's ONE currency (company.currency). Claims carry none; null when it cannot be read. */
export function currencyOfEmployment(ctx: SessionContext, employmentId: string): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select({ currency: company.currency }).from(employment)
      .innerJoin(company, eq(company.id, employment.companyId)).where(eq(employment.id, employmentId)).limit(1);
    return row?.currency ?? null;
  });
}
/** The currency of a claim's claimant's company (the approver's view), or null. */
export function currencyOfClaim(ctx: SessionContext, claimId: string): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select({ currency: company.currency }).from(claimRequest)
      .innerJoin(sql`LATERAL app.delegated_approval_subject(${claimRequest.employmentId},'claims','claims.claim') AS approval_subject`,sql`true`)
      .innerJoin(company, sql`${company.id}=approval_subject.company_id`).where(eq(claimRequest.id, claimId)).limit(1);
    return row?.currency ?? null;
  });
}
/** currencyOfClaim for many claims in one read (the approvals list); a claim RLS hides is simply absent. */
export function currenciesOfClaims(ctx: SessionContext, claimIds: readonly string[]): Promise<Map<string, string | null>> {
  if (!claimIds.length) return Promise.resolve(new Map());
  return withTenant(ctx, async (tx) => {
    const rows = await tx.select({ id: claimRequest.id, currency: company.currency }).from(claimRequest)
      .innerJoin(sql`LATERAL app.delegated_approval_subject(${claimRequest.employmentId},'claims','claims.claim') AS approval_subject`,sql`true`)
      .innerJoin(company, sql`${company.id}=approval_subject.company_id`).where(inArray(claimRequest.id, [...claimIds]));
    return new Map(rows.map((r) => [r.id, r.currency ?? null]));
  });
}

/**
 * The stored custom-field answers with their labels, in designer order. A number/money answer travels as text
 * (money as a two-place string), a yes/no as a boolean; a key the type no longer names keeps its key as its label.
 */
export function claimAnswers(facts: Facts | undefined): ClaimFieldAnswerV2[] {
  const values = facts?.fieldValues ?? null;
  if (!values) return [];
  const known = new Set<string>();
  const out: ClaimFieldAnswerV2[] = [];
  const text = (kind: string, raw: string | number | boolean | null): string | boolean | null => {
    if (raw == null) return null;
    if (typeof raw === 'boolean') return raw;
    if (kind === 'money') return moneyText(raw) ?? String(raw).slice(0, 2000);
    return String(raw).slice(0, 2000);
  };
  for (const f of facts?.fields ?? []) {
    if (!Object.prototype.hasOwnProperty.call(values, f.fieldKey)) continue;
    known.add(f.fieldKey);
    out.push({ key: f.fieldKey.slice(0, 64), label: f.label.slice(0, 300), kind: f.kind, value: text(f.kind, values[f.fieldKey]) });
  }
  for (const [key, raw] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) {
    if (known.has(key) || !key) continue;
    out.push({ key: key.slice(0, 64), label: key.slice(0, 300), kind: typeof raw === 'boolean' ? 'boolean' : 'text', value: text('text', raw) });
  }
  return out.slice(0, 100);
}
/** The banded arithmetic as text. */
export function mileageBands(bands: readonly { fromKm: number; toKm: number | null; ratePerKm: number; km: number; amount: number }[]) {
  return bands.slice(0, 50).map((b) => ({
    fromKm: decimalText(b.fromKm) ?? '0', toKm: decimalText(b.toKm), ratePerKm: decimalText(b.ratePerKm) ?? '0',
    km: decimalText(b.km) ?? '0', amount: sum(b.amount),
  }));
}

// ── List ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Newest first, id-tied, on the instant the list carries (deterministic for the keyset). */
const order = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
/** A draft the kernel could not price yet stores 0, which the web shows as "no amount": never a 0.00 payable. */
const amountOf = (r: ClaimRow) => (r.status === 'draft' && !(r.amount > 0) ? null : sum(r.amount));
const statusOf = (s: string): ClaimStatusV2 => {
  if ((CLAIM_STATUSES as readonly string[]).includes(s)) return s as ClaimStatusV2;
  throw new Error('Unclassified claim status'); // core/claims.ts CLAIM_STATUSES is the enum; a new one must be named here
};
function summaryOf(r: ClaimRow): ClaimSummaryV2 {
  return {
    id: r.id, claimType: r.typeName.slice(0, 300), claimItem: r.itemName?.slice(0, 300) ?? null, amount: amountOf(r),
    amountProvisional: r.status === 'draft', incurredOn: r.incurredOn, status: statusOf(r.status), receiptCount: r.attachments.length,
  };
}

/** One page of the caller's own claims on one employment, newest first. */
export async function ownClaimsPage(
  ctx: SessionContext,
  employmentId: string | null,
  q: { status?: ClaimStatusV2; limit: number; cursor: readonly [string, string] | null },
): Promise<ClaimsPageV2> {
  const empty = { items: [], nextCursor: null, counts: { ...ZERO_COUNTS } };
  if (!claimsEnabled(ctx)) return { enabled: false, employmentId: null, currency: null, ...empty };
  if (!employmentId) return { enabled: true, employmentId: null, currency: null, ...empty };
  const [rows, currency] = await Promise.all([claims.listClaimsForEmployment(ctx, employmentId), currencyOfEmployment(ctx, employmentId)]);
  const all = rows.map((r) => ({ row: r, createdAt: r.createdAt, id: r.id })).sort(order);
  const counts = { ...ZERO_COUNTS };
  for (const { row } of all) counts[statusOf(row.status)] += 1;
  const at = q.cursor ? { createdAt: q.cursor[0], id: q.cursor[1] } : null;
  const after = all.filter((r) => (!q.status || r.row.status === q.status) && (!at || order(r, at) > 0)).slice(0, q.limit + 1);
  const page = after.slice(0, q.limit), last = page[page.length - 1];
  return {
    enabled: true, employmentId, currency, counts,
    items: page.map((r) => summaryOf(r.row)),
    nextCursor: after.length > q.limit && last ? encodeCursor(CLAIMS_CURSOR, [last.createdAt, last.id]) : null,
  };
}

/** The row, only when it is the caller's own on `employmentId` (verified upstream). */
async function ownRow(ctx: SessionContext, employmentId: string, id: string): Promise<ClaimRow | null> {
  return (await claims.listClaimsForEmployment(ctx, employmentId)).find((r) => r.id === id) ?? null;
}

// ── One claim ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function ownClaimDetail(ctx: SessionContext, employmentId: string | null, id: string): Promise<ClaimDetailResult> {
  if (!claimsEnabled(ctx) || !employmentId) return NOT_FOUND;
  const r = await ownRow(ctx, employmentId, id);
  if (!r) return NOT_FOUND;
  const [facts, currency] = await Promise.all([claims.claimRecordFacts(ctx, [r.id]), currencyOfEmployment(ctx, employmentId)]);
  const f = facts.get(r.id);
  const status = statusOf(r.status);
  const claim: ClaimDetailV2 = {
    id: r.id, claimTypeId: r.claimTypeId, claimItemId: r.claimItemId,
    claimType: r.typeName.slice(0, 300), claimItem: r.itemName?.slice(0, 300) ?? null,
    amount: amountOf(r), amountProvisional: status === 'draft', currency,
    quantityKm: decimalText(r.quantityKm),
    mileage: f?.mileage ? { tableValidFrom: f.mileage.tableValidFrom, bands: mileageBands(f.mileage.bands) } : null,
    incurredOn: r.incurredOn, description: r.description?.slice(0, 2000) ?? null,
    fields: claimAnswers(f),
    receipts: r.attachments.slice(0, 50).map((a) => ({ id: a.id, fileName: a.fileName.slice(0, 300), sizeBytes: a.sizeBytes })),
    status, createdAt: r.createdAt, submittedAt: status === 'draft' ? null : f?.submittedAt ?? null,
    decision: r.decidedAt ? { decidedAt: r.decidedAt, decidedByName: f?.decidedByName?.slice(0, 300) ?? null, rejectReason: f?.rejectReason?.slice(0, 2000) ?? null } : null,
    payout: f?.payoutRoute ? { route: f.payoutRoute, scheduledInPayroll: f.scheduledInPayroll, paidAt: r.paidAt } : null,
    // The kernel's own status rules: cancelClaim takes a pending claim; saveClaimDraft / deleteClaimDraft /
    // submitDraftClaims take a draft. Nothing reopens a rejected or cancelled claim.
    actions: { cancel: status === 'pending', editDraft: status === 'draft', deleteDraft: status === 'draft', submitDraft: status === 'draft' },
  };
  return { outcome: 'found', claim };
}

export type ClaimFile = { outcome: 'file'; contentType: MobileBinaryType; fileName: string; bytes: Uint8Array };
/** One receipt of the caller's own claim: PDF, JPEG or PNG whose bytes match its label, else `unsupported_document`. */
export async function ownClaimReceipt(ctx: SessionContext, employmentId: string | null, claimId: string, attachmentId: string): Promise<ClaimFile | ClaimReceiptRefusal> {
  if (!claimsEnabled(ctx) || !employmentId) return NOT_FOUND;
  const r = await ownRow(ctx, employmentId, claimId);
  if (!r || !r.attachments.some((a) => a.id === attachmentId)) return NOT_FOUND;
  return receiptFile(ctx, attachmentId, NOT_FOUND);
}
/** getClaimAttachment's bytes when the stored type is one the phone is sent and the bytes are that type. */
export async function receiptFile<R>(ctx: SessionContext, attachmentId: string, missing: R): Promise<ClaimFile | R | { outcome: 'refused'; code: 'unsupported_document' }> {
  const file = await claims.getClaimAttachment(ctx, attachmentId);
  if (!file) return missing;
  const type = file.mimeType.toLowerCase(), bytes = new Uint8Array(file.content);
  if (!isMobileBinaryType(type, CLAIM_RECEIPT_TYPES) || !hasMobileBinarySignature(type, bytes)) return { outcome: 'refused', code: 'unsupported_document' };
  return { outcome: 'file', contentType: type, fileName: file.fileName, bytes };
}

// ── The claim form ─────────────────────────────────────────────────────────────────────────────────────────────

type Balance = Awaited<ReturnType<typeof claims.getEmployeeClaimTypes>>[number]['balance'];
function balanceOf(b: Balance): ClaimBalanceV2 {
  const opt = (n: number | null) => (n == null ? null : sum(n));
  return {
    annualLimit: opt(b.annualLimit), usedThisYear: sum(b.usedThisYear), reservedThisYear: sum(b.reservedThisYear), remainingThisYear: opt(b.remainingThisYear),
    monthlyLimit: opt(b.monthlyLimit), usedThisMonth: sum(b.usedThisMonth), remainingThisMonth: opt(b.remainingThisMonth), perClaimCap: opt(b.perClaimCap),
    lifetimeLimit: opt(b.lifetimeLimit), usedLifetime: sum(b.usedLifetime), claimsUsedThisYear: b.claimsUsedThisYear, maxClaimsPerYear: b.maxClaimsPerYear,
    blockLimit: opt(b.blockLimit), usedThisBlock: sum(b.usedThisBlock), remainingThisBlock: opt(b.remainingThisBlock), blockEndsOn: b.blockEndsOn,
    items: b.items.slice(0, 200).map((i) => ({
      claimItemId: i.claimItemId, itemName: i.itemName.slice(0, 300), annualLimit: opt(i.annualLimit), usedThisYear: sum(i.usedThisYear),
      remainingThisYear: opt(i.remainingThisYear), monthlyLimit: opt(i.monthlyLimit), usedThisMonth: sum(i.usedThisMonth),
      remainingThisMonth: opt(i.remainingThisMonth), perClaimCap: opt(i.perClaimCap),
    })),
  };
}

/** The types this employment may claim, as the web's claim form is given them, for the caller's own grade. */
export async function ownClaimFormOptions(ctx: SessionContext, employmentId: string | null): Promise<ClaimFormOptionsV2> {
  const today = todayInKualaLumpur();
  if (!claimsEnabled(ctx)) return { enabled: false, employmentId: null, currency: null, today, types: [] };
  if (!employmentId) return { enabled: true, employmentId: null, currency: null, today, types: [] };
  const [types, currency] = await Promise.all([claims.getEmployeeClaimTypes(ctx, employmentId), currencyOfEmployment(ctx, employmentId)]);
  return {
    enabled: true, employmentId, currency, today,
    types: types.slice(0, 200).map((t) => {
      // The web form's rule (components/claim-form.tsx): THE mileage type asks a distance; a fixed allowance asks
      // nothing; everything else asks an amount. The kernel prices all three at submit.
      const fixed = !t.isMileage && t.rateConfig?.kind === 'fixed_allowance' ? t.rateConfig : null;
      return {
        id: t.id, code: t.code.slice(0, 64), name: t.name.slice(0, 300), requiresReceipt: t.requiresReceipt,
        amountEntry: t.isMileage ? 'distance' : fixed ? 'fixed' : 'entered',
        fixedAmount: fixed ? moneyText(fixed.amount) : null,
        earliestIncurredOn: claims.dateMinusDays(today, t.maxReceiptAgeDays),
        items: t.items.slice(0, 200).map((i) => ({ id: i.id, name: i.name.slice(0, 300) })),
        fields: t.formFields.slice(0, 100).map((f) => ({ key: f.fieldKey.slice(0, 64), label: f.label.slice(0, 300), kind: f.kind, required: f.required, options: f.options.slice(0, 100).map((o) => String(o).slice(0, 300)) })),
        balance: balanceOf(t.balance),
      };
    }),
  };
}

const UNKNOWN_TYPE = 'Unknown or archived claim type';
/** The kernel's price for `km` on THE mileage type, for the caller's own employment and grade. */
export async function ownMileagePreview(ctx: SessionContext, employmentId: string | null, q: { claimTypeId: string; km: string; incurredOn: string }): Promise<MileagePreviewResult> {
  if (!claimsEnabled(ctx)) return { outcome: 'refused', code: 'claims_off' };
  if (!employmentId) return { outcome: 'refused', code: 'no_employment' };
  try {
    const p = await claims.previewMileageClaim(ctx, { employmentId, claimTypeId: q.claimTypeId, quantityKm: Number(q.km), incurredOn: q.incurredOn });
    return { outcome: 'priced', amount: sum(p.amount), bands: p.bands ? mileageBands(p.bands) : null, tableValidFrom: p.tableValidFrom };
  } catch (e) {
    if (e instanceof ModuleNotEnabledError) return { outcome: 'refused', code: 'claims_off' };
    if (e instanceof claims.ClaimError) {
      return e.message === UNKNOWN_TYPE ? NOT_FOUND : { outcome: 'refused', code: 'claim_refused', message: publicErrorMessage(e).slice(0, 4000) };
    }
    throw e;
  }
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A receipt as the route read it: none, a sniffed file, or a refusal decided before anything ran. */
export type ClaimUpload =
  | { kind: 'none' }
  | { kind: 'file'; fileName: string; mimeType: MobileBinaryType; content: Buffer; sha256: string }
  | { kind: 'refused'; code: 'receipt_empty' | 'receipt_too_large' | 'receipt_type' };

/** A refusal raised inside the receipt's run, so the transaction rolls back and nothing is recorded. */
class ClaimRefused extends Error {
  constructor(readonly code: ClaimCommandRefusalCode) { super(code); this.name = 'ClaimRefused'; }
}
/** A thrown refusal as the app reads it; anything else is rethrown (a logged 500). */
export function claimCommandRefusal(e: unknown): ClaimCommandRefusal {
  if (e instanceof ClaimRefused) return { outcome: 'refused', code: e.code };
  if (e instanceof MobileCommandOwnerRequired) return { outcome: 'refused', code: 'no_employment' };
  if (e instanceof ModuleNotEnabledError) return { outcome: 'refused', code: 'claims_off' };
  // The kernel's own sentence (English, with its own currency wording), never a database message.
  if (e instanceof claims.ClaimError) return { outcome: 'refused', code: 'claim_refused', message: publicErrorMessage(e).slice(0, 4000) };
  throw e;
}
async function command<S extends z.ZodType>(run: () => Promise<z.output<S> | ClaimCommandRefusal>): Promise<z.output<S> | ClaimCommandRefusal> {
  try { return await run(); } catch (e) { return claimCommandRefusal(e); }
}
/** Admission shared by every command: the module, an own claim-eligible employment, a readable upload. */
function precheck(ctx: SessionContext, employmentId: string | null, upload?: ClaimUpload): ClaimCommandRefusal | null {
  if (!claimsEnabled(ctx)) return { outcome: 'refused', code: 'claims_off' };
  if (!employmentId) return { outcome: 'refused', code: 'no_employment' };
  if (upload?.kind === 'refused') return { outcome: 'refused', code: upload.code };
  return null;
}
/** The claim is the caller's own on this employment (any status), read in the receipt's transaction under RLS. */
async function ownClaimTx(tx: Tx, id: string, employmentId: string): Promise<boolean> {
  const [row] = await tx.select({ id: claimRequest.id }).from(claimRequest)
    .where(and(eq(claimRequest.id, id), eq(claimRequest.employmentId, employmentId))).limit(1);
  return !!row;
}

type Fields = Omit<ClaimSubmitCommand, 'requestId' | 'draftId'>;
/** The kernel's input. An amount the form did not ask for is 0: the kernel prices distance and fixed types itself. */
function kernelFields(employmentId: string, c: Fields) {
  return {
    employmentId, claimTypeId: c.claimTypeId, claimItemId: c.claimItemId ?? null,
    amount: c.amount != null ? Number(c.amount) : 0,
    quantityKm: c.quantityKm != null ? Number(c.quantityKm) : null,
    incurredOn: c.incurredOn, description: c.description?.trim() || null,
    fieldValues: c.fieldValues ?? null,
  };
}
/** Everything that decides the outcome, normalised (the receipt by identity, never by bytes). */
function intentOf(c: Fields & { draftId?: string }, upload: ClaimUpload) {
  return {
    draftId: c.draftId?.toLowerCase() ?? null, claimTypeId: c.claimTypeId.toLowerCase(), claimItemId: c.claimItemId?.toLowerCase() ?? null,
    amount: c.amount ?? null, quantityKm: c.quantityKm ?? null, incurredOn: c.incurredOn, description: c.description?.trim() || null,
    fieldValues: c.fieldValues ?? null,
    receipt: upload.kind === 'file' ? { sha256: upload.sha256, size: upload.content.byteLength, mimeType: upload.mimeType, fileName: upload.fileName } : null,
  };
}
const fileOf = (upload: ClaimUpload) => (upload.kind === 'file' ? { fileName: upload.fileName, mimeType: upload.mimeType, content: upload.content } : null);

/**
 * File a claim (submitClaimWithAttachment), or — with `draftId` — save the caller's own draft with these values and
 * file it (saveClaimDraft, then submitDraftClaims: the web's "edit and submit"), in ONE transaction with the receipt.
 * Unlike the web's two transactions, a refusal at filing also undoes the edit: the phone still holds the edits.
 */
export async function submitOwnClaimV2(ctx: SessionContext, employmentId: string | null, c: ClaimSubmitCommand, upload: ClaimUpload): Promise<z.output<typeof ClaimSubmitResult>> {
  const pre = precheck(ctx, employmentId, upload);
  if (pre || !employmentId) return pre ?? { outcome: 'refused', code: 'no_employment' };
  const fields = kernelFields(employmentId, c), file = fileOf(upload), draftId = c.draftId?.toLowerCase();
  return command<typeof ClaimSubmitResult>(() => withMobileCommandReceipt(ctx, {
    kind: 'claim.submit', requestId: c.requestId, actorEmploymentId: employmentId, response: ClaimSubmitResult, intent: intentOf(c, upload),
  }, async (tx) => {
    if (draftId) {
      if (!(await ownClaimTx(tx, draftId, employmentId))) throw new ClaimRefused('not_found');
      await claims.saveClaimDraft(ctx, { ...fields, id: draftId }, file, tx);
      await claims.submitDraftClaims(ctx, { ids: [draftId], employmentId }, tx);
      return { outcome: 'submitted' as const, id: draftId };
    }
    const { id } = await claims.submitClaimWithAttachment(ctx, { ...fields, hasReceipt: file != null }, file, tx);
    return { outcome: 'submitted' as const, id };
  }));
}

/** Save a new draft, or the caller's own existing one (saveClaimDraft). Reserves nothing; checks no limit (D11). */
export async function saveOwnClaimDraftV2(ctx: SessionContext, employmentId: string | null, c: ClaimDraftCommand, upload: ClaimUpload): Promise<z.output<typeof ClaimDraftResult>> {
  const pre = precheck(ctx, employmentId, upload);
  if (pre || !employmentId) return pre ?? { outcome: 'refused', code: 'no_employment' };
  const fields = kernelFields(employmentId, c), file = fileOf(upload), draftId = c.draftId?.toLowerCase();
  return command<typeof ClaimDraftResult>(() => withMobileCommandReceipt(ctx, {
    kind: 'claim.draft', requestId: c.requestId, actorEmploymentId: employmentId, response: ClaimDraftResult, intent: intentOf(c, upload),
  }, async (tx) => {
    if (draftId && !(await ownClaimTx(tx, draftId, employmentId))) throw new ClaimRefused('not_found');
    const { id } = await claims.saveClaimDraft(ctx, { ...fields, ...(draftId ? { id: draftId } : {}) }, file, tx);
    return { outcome: 'saved' as const, id };
  }));
}

/** File the caller's own drafts together (submitDraftClaims): all or none, against one limit. */
export async function submitOwnClaimDraftsV2(ctx: SessionContext, employmentId: string | null, c: ClaimDraftsSubmitCommand): Promise<z.output<typeof ClaimDraftsSubmitResult>> {
  const pre = precheck(ctx, employmentId);
  if (pre || !employmentId) return pre ?? { outcome: 'refused', code: 'no_employment' };
  const ids = [...new Set(c.ids.map((id) => id.toLowerCase()))].sort();
  return command<typeof ClaimDraftsSubmitResult>(() => withMobileCommandReceipt(ctx, {
    kind: 'claim.drafts-submit', requestId: c.requestId, actorEmploymentId: employmentId, response: ClaimDraftsSubmitResult, intent: { ids },
  }, async (tx) => {
    for (const id of ids) if (!(await ownClaimTx(tx, id, employmentId))) throw new ClaimRefused('not_found');
    const { submitted } = await claims.submitDraftClaims(ctx, { ids, employmentId }, tx);
    return { outcome: 'submitted' as const, ids, submitted };
  }));
}

/** Delete the caller's own draft (deleteClaimDraft). A lost answer replays `deleted`, although the row is gone. */
export async function deleteOwnClaimDraftV2(ctx: SessionContext, employmentId: string | null, claimId: string, requestId: string): Promise<z.output<typeof ClaimDeleteResult>> {
  const pre = precheck(ctx, employmentId);
  if (pre || !employmentId) return pre ?? { outcome: 'refused', code: 'no_employment' };
  const id = claimId.toLowerCase();
  return command<typeof ClaimDeleteResult>(() => withMobileCommandReceipt(ctx, {
    kind: 'claim.delete', requestId, actorEmploymentId: employmentId, response: ClaimDeleteResult, intent: { claimId: id },
  }, async (tx) => {
    if (!(await ownClaimTx(tx, id, employmentId))) throw new ClaimRefused('not_found');
    await claims.deleteClaimDraft(ctx, id, employmentId, tx);
    return { outcome: 'deleted' as const, id };
  }));
}

/** Cancel the caller's own PENDING claim (cancelClaim): the reservation is released. */
export async function cancelOwnClaimV2(ctx: SessionContext, employmentId: string | null, claimId: string, requestId: string): Promise<z.output<typeof ClaimCancelResult>> {
  const pre = precheck(ctx, employmentId);
  if (pre || !employmentId) return pre ?? { outcome: 'refused', code: 'no_employment' };
  const id = claimId.toLowerCase();
  return command<typeof ClaimCancelResult>(() => withMobileCommandReceipt(ctx, {
    kind: 'claim.cancel', requestId, actorEmploymentId: employmentId, response: ClaimCancelResult, intent: { claimId: id },
  }, async (tx) => {
    if (!(await ownClaimTx(tx, id, employmentId))) throw new ClaimRefused('not_found');
    await claims.cancelClaim(ctx, id, employmentId, tx);
    return { outcome: 'cancelled' as const, id };
  }));
}
