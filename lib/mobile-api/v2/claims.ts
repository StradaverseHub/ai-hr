/**
 * M11 — the employee's own expense claims on the phone: the list, one claim, its receipts, the claim form's options
 * (with the kernel's mileage preview), and the commands (submit, save/submit drafts, delete a draft, cancel). v2 only.
 * Imported by route handlers AND by the Expo app, so this file stays dependency-free (zod, common.ts and pay.ts's
 * money shape only, no server module, no 'server-only').
 *
 *   GET  /api/mobile/v2/claims?employmentId&status&cursor&limit                    → ClaimsPageV2
 *   GET  /api/mobile/v2/claims/form?employmentId                                   → ClaimFormOptionsV2
 *   GET  /api/mobile/v2/claims/mileage-preview?employmentId&claimTypeId&km&incurredOn → MileagePreviewResult
 *   GET  /api/mobile/v2/claims/{id}?employmentId                                   → ClaimDetailResult
 *   GET  /api/mobile/v2/claims/{id}/receipt?employmentId&attachment                → the receipt bytes, or ClaimReceiptRefusal
 *   POST /api/mobile/v2/claims?employmentId         multipart {command: ClaimSubmitCommand, receipt?} → ClaimSubmitResult
 *   POST /api/mobile/v2/claims/drafts?employmentId  multipart {command: ClaimDraftCommand, receipt?}  → ClaimDraftResult
 *   POST /api/mobile/v2/claims/drafts/submit?employmentId {requestId, ids}                         → ClaimDraftsSubmitResult
 *   POST /api/mobile/v2/claims/{id}/delete?employmentId   {requestId}                              → ClaimDeleteResult
 *   POST /api/mobile/v2/claims/{id}/cancel?employmentId   {requestId}                              → ClaimCancelResult
 *
 * Owner decisions (2026-10-28). D11: drafts are the server's own `draft` claim rows (core/claims.ts saveClaimDraft),
 * the same ones the web lists; a draft reserves nothing. Nothing about a claim is persisted on the phone: a receipt
 * being captured lives in memory and the protected temporary folder until it is uploaded. D10: commands are online,
 * confirmed and held in memory; a lost answer is retried with the same requestId and the server's receipt replays it.
 *
 * NOTHING HERE IS A CLAIM RULE OR A COMPUTED FIGURE. Types, items, custom fields, the receipt requirement and window,
 * balances and limits come from core/claims.ts getEmployeeClaimTypes; a mileage price is the kernel's own
 * (previewMileageClaim, the rule submit uses); limits and duplicates are re-checked by the kernel at submit, and its
 * refusal travels as `claim_refused` with the kernel's own sentence. Amounts are two-place decimal strings; claims
 * have no currency column, so `currency` is the claimant's company's one currency (company.currency), or null.
 *
 * WHY MULTIPART FOR THE RECEIPT. The existing native uploads (v1 leave document, clock photo) are multipart through
 * lib/mobile-api/body.ts mobileForm, which bounds the stream before parsing; the app streams the file's bytes from
 * the protected folder (expo fetch). Base64 in JSON would add a third to the body and hold a 13 MiB string in the
 * app's JS heap for a 10 MB receipt. The server never trusts the part's declared type: it sniffs the bytes (PDF, JPEG,
 * PNG; fail closed), as app/(app)/claims/actions.ts does.
 */
import { z } from 'zod';
import { commandOf, pageOf, refusalOf } from './common';
import { MoneyV2 } from './pay';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const calendarDate = isoDate.refine((v) => { const d = new Date(v + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; });
const instant = z.string().max(40);
const name = z.string().max(300);
const count = z.number().int().nonnegative();
/** A non-money decimal the kernel stores or configures (km, a rate per km), as text. */
const decimal = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);

/** core/claims.ts ALLOWED_RECEIPT_MIME and its 10 MB bound (assertValidAttachment); pinned to the kernel by test. */
export const CLAIM_RECEIPT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const CLAIM_RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
/** The multipart parts a claim upload may carry (lib/mobile-api/body.ts mobileForm refuses any other). */
export const CLAIM_UPLOAD_PARTS = ['command', 'receipt'] as const;

/** core/claims.ts CLAIM_STATUSES. */
export const CLAIM_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'cancelled', 'paid'] as const;
export const ClaimStatusV2 = z.enum(CLAIM_STATUSES);
export type ClaimStatusV2 = z.infer<typeof ClaimStatusV2>;
/** core/claims.ts CLAIM_FIELD_KINDS. */
export const CLAIM_FIELD_KINDS = ['text', 'number', 'money', 'date', 'select', 'boolean'] as const;
export const ClaimFieldKindV2 = z.enum(CLAIM_FIELD_KINDS);

// ── List ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const ClaimSummaryV2 = z.object({
  id: uuid,
  claimType: name,
  claimItem: name.nullable(),
  /** Null for a draft not priced yet (the kernel stores 0 for it, as the web shows "no amount"). */
  amount: MoneyV2.nullable(),
  /** A draft's amount is provisional: it is re-priced at submit by the policy then in force. */
  amountProvisional: z.boolean(),
  incurredOn: isoDate,
  status: ClaimStatusV2,
  receiptCount: count,
});
export type ClaimSummaryV2 = z.infer<typeof ClaimSummaryV2>;
/** Keyset tuple: the claim's creation instant and id, newest first (listClaimsForEmployment's order, id-tied). */
export const CLAIMS_CURSOR = 'claims';
export const ClaimsCursor = z.tuple([instant, uuid]);
export const ClaimsPageV2 = pageOf(ClaimSummaryV2).extend({
  /** False when the tenant has no Claims module: nothing else is read. */
  enabled: z.boolean(),
  /** The caller's own claim-eligible employment the list is about; null when there is none. */
  employmentId: uuid.nullable(),
  currency: z.string().max(8).nullable(),
  /** Per status over every claim of the employment, ignoring the status filter (the chips' badges). */
  counts: z.object({ draft: count, pending: count, approved: count, rejected: count, cancelled: count, paid: count }),
});
export type ClaimsPageV2 = z.infer<typeof ClaimsPageV2>;

// ── One claim ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A custom-field answer: number and money answers as text, a yes/no as a boolean, an unanswered one as null. */
export const ClaimFieldAnswerV2 = z.object({
  key: z.string().min(1).max(64),
  label: name,
  kind: ClaimFieldKindV2,
  value: z.union([z.string().max(2000), z.boolean()]).nullable(),
});
export type ClaimFieldAnswerV2 = z.infer<typeof ClaimFieldAnswerV2>;
export const ClaimReceiptV2 = z.object({ id: uuid, fileName: name, sizeBytes: count });
export type ClaimReceiptV2 = z.infer<typeof ClaimReceiptV2>;
/** The banded arithmetic stamped on a mileage claim at submit (or previewed before it). */
export const MileageBandsV2 = z.array(z.object({ fromKm: decimal, toKm: decimal.nullable(), ratePerKm: decimal, km: decimal, amount: MoneyV2 })).max(50);

export const ClaimDetailV2 = z.object({
  id: uuid,
  claimTypeId: uuid,
  claimItemId: uuid.nullable(),
  claimType: name,
  claimItem: name.nullable(),
  amount: MoneyV2.nullable(),
  amountProvisional: z.boolean(),
  currency: z.string().max(8).nullable(),
  quantityKm: decimal.nullable(),
  /** The rate table the claim was priced under; null unless it was priced by a banded mileage table. */
  mileage: z.object({ tableValidFrom: isoDate, bands: MileageBandsV2 }).nullable(),
  incurredOn: isoDate,
  description: z.string().max(2000).nullable(),
  fields: z.array(ClaimFieldAnswerV2).max(100),
  receipts: z.array(ClaimReceiptV2).max(50),
  status: ClaimStatusV2,
  createdAt: instant,
  /** When it was filed (null for a draft). */
  submittedAt: instant.nullable(),
  /** A decided claim: when, by whom (when the caller may read the name), and an approver's rejection reason. */
  decision: z.object({ decidedAt: instant, decidedByName: name.nullable(), rejectReason: z.string().max(2000).nullable() }).nullable(),
  /** An approved or paid claim: through payroll (taxable) or an off-cycle reimbursement, queued, and when paid. */
  payout: z.object({ route: z.enum(['payroll', 'reimbursement']), scheduledInPayroll: z.boolean(), paidAt: instant.nullable() }).nullable(),
  /**
   * What the employee may do now, from the kernel's own status rules: cancel a pending claim (cancelClaim); edit,
   * delete or submit a draft (saveClaimDraft / deleteClaimDraft / submitDraftClaims). A rejected or cancelled claim
   * has no correction path in the kernel: it is final, and a new claim is a new claim.
   */
  actions: z.object({ cancel: z.boolean(), editDraft: z.boolean(), deleteDraft: z.boolean(), submitDraft: z.boolean() }),
});
export type ClaimDetailV2 = z.infer<typeof ClaimDetailV2>;
export const ClaimDetailResult = z.union([z.object({ outcome: z.literal('found'), claim: ClaimDetailV2 }), refusalOf(['not_found'])]);
export type ClaimDetailResult = z.infer<typeof ClaimDetailResult>;

/** `unsupported_document`: stored in a type the phone is not sent, or bytes that are not what the label says. */
export const ClaimReceiptRefusal = refusalOf(['not_found', 'unsupported_document']);
export type ClaimReceiptRefusal = z.infer<typeof ClaimReceiptRefusal>;

// ── The claim form ─────────────────────────────────────────────────────────────────────────────────────────────

export const ClaimFieldDefV2 = z.object({
  key: z.string().min(1).max(64),
  label: name,
  kind: ClaimFieldKindV2,
  required: z.boolean(),
  options: z.array(z.string().max(300)).max(100),
});
export type ClaimFieldDefV2 = z.infer<typeof ClaimFieldDefV2>;
const pot = {
  annualLimit: MoneyV2.nullable(), usedThisYear: MoneyV2, remainingThisYear: MoneyV2.nullable(),
  monthlyLimit: MoneyV2.nullable(), usedThisMonth: MoneyV2, remainingThisMonth: MoneyV2.nullable(), perClaimCap: MoneyV2.nullable(),
};
/** getEmployeeClaimTypes's balance for this employee's grade today (pending reservations included); null ⇒ no limit. */
export const ClaimBalanceV2 = z.object({
  ...pot,
  reservedThisYear: MoneyV2,
  lifetimeLimit: MoneyV2.nullable(), usedLifetime: MoneyV2,
  claimsUsedThisYear: count, maxClaimsPerYear: count.nullable(),
  blockLimit: MoneyV2.nullable(), usedThisBlock: MoneyV2, remainingThisBlock: MoneyV2.nullable(), blockEndsOn: isoDate.nullable(),
  items: z.array(z.object({ claimItemId: uuid, itemName: name, ...pot })).max(200),
});
export type ClaimBalanceV2 = z.infer<typeof ClaimBalanceV2>;
/**
 * What the form asks for the amount, as the web's claim form decides it: `distance` for THE mileage type (priced by
 * the kernel from the km), `fixed` for a fixed allowance (the configured amount), else `entered`.
 */
export const ClaimAmountEntry = z.enum(['entered', 'fixed', 'distance']);
export const ClaimFormTypeV2 = z.object({
  id: uuid,
  code: z.string().max(64),
  name,
  requiresReceipt: z.boolean(),
  amountEntry: ClaimAmountEntry,
  /** The configured allowance for a `fixed` type; null otherwise. */
  fixedAmount: MoneyV2.nullable(),
  /** The oldest incurred date the kernel accepts today (its per-type receipt window); the newest is `today`. */
  earliestIncurredOn: isoDate,
  /** Non-empty ⇒ an item is required at submit. */
  items: z.array(z.object({ id: uuid, name })).max(200),
  fields: z.array(ClaimFieldDefV2).max(100),
  balance: ClaimBalanceV2,
});
export type ClaimFormTypeV2 = z.infer<typeof ClaimFormTypeV2>;
export const ClaimFormOptionsV2 = z.object({
  enabled: z.boolean(),
  employmentId: uuid.nullable(),
  currency: z.string().max(8).nullable(),
  /** The tenant's local date (Asia/Kuala_Lumpur), the kernel's "today" for the receipt window. */
  today: isoDate,
  types: z.array(ClaimFormTypeV2).max(200),
});
export type ClaimFormOptionsV2 = z.infer<typeof ClaimFormOptionsV2>;

/** The kernel's price for a distance on THE mileage type (previewMileageClaim); `amount` is what submit would store. */
export const MileagePreviewResult = z.union([
  z.object({ outcome: z.literal('priced'), amount: MoneyV2, bands: MileageBandsV2.nullable(), tableValidFrom: isoDate.nullable() }),
  refusalOf(['not_found', 'no_employment', 'claims_off', 'claim_refused']),
]);
export type MileagePreviewResult = z.infer<typeof MileagePreviewResult>;

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `not_found`: the claim is not one of the caller's own on the selected employment (or a draft/claim in the wrong
 * state for the command's target); `no_employment`: no claim-eligible own employment (offboarded, blocked, none);
 * `claims_off`: the tenant has no Claims module; `receipt_*`: the uploaded file is empty, over 10 MB, or not a PDF,
 * JPEG or PNG by its bytes; `claim_refused`: the kernel refused (a limit, the receipt window or requirement, an item,
 * a required field, the state), with its own sentence; `request_conflict`: the requestId already recorded a
 * different command.
 */
export const CLAIM_COMMAND_REFUSALS = [
  'not_found', 'request_conflict', 'no_employment', 'claims_off', 'receipt_empty', 'receipt_too_large', 'receipt_type', 'claim_refused',
] as const;
export type ClaimCommandRefusalCode = (typeof CLAIM_COMMAND_REFUSALS)[number];
export const ClaimCommandRefusal = refusalOf(CLAIM_COMMAND_REFUSALS);
export type ClaimCommandRefusal = z.infer<typeof ClaimCommandRefusal>;

/** What the employee types: up to ten digits and two places, no sign, no grouping. Converted by the kernel's caller only. */
export const ClaimMoneyInput = z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/);
export const ClaimKmInput = z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/);
const fieldValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
const claimInput = {
  claimTypeId: uuid,
  claimItemId: uuid.nullable().optional(),
  /** Omitted for a `distance` or `fixed` type: the kernel prices those. */
  amount: ClaimMoneyInput.nullable().optional(),
  quantityKm: ClaimKmInput.nullable().optional(),
  incurredOn: calendarDate,
  description: z.string().trim().max(2000).optional(),
  fieldValues: z.record(z.string().min(1).max(64), fieldValue).refine((v) => Object.keys(v).length <= 100).optional(),
};
/** File a claim. With `draftId`, the caller's own draft is saved with these values and filed, in ONE transaction. */
export const ClaimSubmitCommand = commandOf({ draftId: uuid.optional(), ...claimInput });
export type ClaimSubmitCommand = z.infer<typeof ClaimSubmitCommand>;
export const ClaimSubmitResult = z.discriminatedUnion('outcome', [z.object({ outcome: z.literal('submitted'), id: uuid }), ClaimCommandRefusal]);
export type ClaimSubmitResult = z.infer<typeof ClaimSubmitResult>;
/** Save a new draft, or (with `draftId`) the caller's own existing draft. A draft reserves nothing (D11). */
export const ClaimDraftCommand = commandOf({ draftId: uuid.optional(), ...claimInput });
export type ClaimDraftCommand = z.infer<typeof ClaimDraftCommand>;
export const ClaimDraftResult = z.discriminatedUnion('outcome', [z.object({ outcome: z.literal('saved'), id: uuid }), ClaimCommandRefusal]);
export type ClaimDraftResult = z.infer<typeof ClaimDraftResult>;
/** File drafts together: all or none, against one limit (submitDraftClaims). */
export const ClaimDraftsSubmitCommand = commandOf({ ids: z.array(uuid).min(1).max(20) });
export type ClaimDraftsSubmitCommand = z.infer<typeof ClaimDraftsSubmitCommand>;
export const ClaimDraftsSubmitResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('submitted'), ids: z.array(uuid).max(20), submitted: count }), ClaimCommandRefusal,
]);
export type ClaimDraftsSubmitResult = z.infer<typeof ClaimDraftsSubmitResult>;
export const ClaimDeleteCommand = commandOf({});
export const ClaimDeleteResult = z.discriminatedUnion('outcome', [z.object({ outcome: z.literal('deleted'), id: uuid }), ClaimCommandRefusal]);
export type ClaimDeleteResult = z.infer<typeof ClaimDeleteResult>;
export const ClaimCancelCommand = commandOf({});
export const ClaimCancelResult = z.discriminatedUnion('outcome', [z.object({ outcome: z.literal('cancelled'), id: uuid }), ClaimCommandRefusal]);
export type ClaimCancelResult = z.infer<typeof ClaimCancelResult>;
