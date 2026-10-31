/**
 * M09 — the employee's own payslips and EA forms on the phone, and the audited share of their PDFs. v2 only: the
 * v1 payslip list (lib/mobile-api/contract.ts PayslipsResponse, active employments, totals) stays for installed
 * clients. Imported by route handlers AND by the Expo app, so this file stays dependency-free (zod and common.ts
 * only, no server module, no 'server-only').
 *
 *   GET  /api/mobile/v2/payslips?cursor&limit                 → PayslipIndexV2   (no amounts)
 *   GET  /api/mobile/v2/payslips/{id}                         → PayslipDetailResult
 *   GET  /api/mobile/v2/payslips/{id}/pdf                     → the PDF bytes, or DocumentRefusal
 *   GET  /api/mobile/v2/ea                                    → EaSourcesV2
 *   GET  /api/mobile/v2/ea/pdf?employmentId&year&company&lang → the PDF bytes, or EaDocumentRefusal
 *   POST /api/mobile/v2/documents/share-events {requestId, shareId, document, stage} → ShareEventResult
 *
 * Owner decisions (2026-10-28). D1: every employment of the signed-in login, as the web's /me/payslip and /me/ea
 * list them (current and past), and nothing once the login is blocked (the bearer session is refused first).
 * D7: the payslip is VIEWED natively; the PDF and the EA form leave the app only through the OS share sheet,
 * after an explicit confirmation the server has acknowledged, and every share is audited without a figure.
 *
 * NOTHING HERE IS COMPUTED. Every amount is the payslip document owner's own figure (app/(app)/me/payslip/document.ts →
 * lib/payslip-pdf.ts payslipPresentationRows, the rows the web statement draws), sent as a decimal string with
 * two places — the precision the web statement prints — and the app does no arithmetic on it. Labels are the
 * document's own strings. Which payslips exist, which are released and which are the caller's own belong to
 * core/read.ts myReleasedPayslipRuns and payslipDetail; which EA forms exist to core/reporting.ts myEaSources.
 */
import { z } from 'zod';
import { commandOf, pageOf, refusalOf } from './common';

const uuid = z.string().uuid();
const name = z.string().max(300);
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const year = z.string().regex(/^\d{4}$/);
/** A decimal STRING with exactly two places, as the web statement prints it. Never a float. */
export const MoneyV2 = z.string().regex(/^-?\d+\.\d{2}$/);
const label = z.string().max(300);

/** payroll_run_type (db/schema.ts payrollRunTypeEnum). The app names them in its own language. */
export const RUN_TYPES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
export const RunTypeV2 = z.enum(RUN_TYPES);
export type RunTypeV2 = z.infer<typeof RunTypeV2>;

// ── Payslip index ──────────────────────────────────────────────────────────────────────────────────────────────

/** One released payslip of the caller's own. Identity and context only: no amount travels in the index. */
export const PayslipIndexItemV2 = z.object({
  id: uuid,
  employmentId: uuid,
  employeeCode: z.string().max(64).nullable(),
  companyId: uuid,
  company: name,
  /** The stored `YYYY-MM`. */
  period,
  /** The configured pay cycle's name; null for a run opened under none. */
  cycleName: name.nullable(),
  runType: RunTypeV2,
  runSeq: z.number().int().positive(),
});
export type PayslipIndexItemV2 = z.infer<typeof PayslipIndexItemV2>;
/** Keyset tuple: myReleasedPayslipRuns's own order (period desc, company, run sequence, payslip id). */
export const PAYSLIPS_CURSOR = 'payslips';
export const PayslipsCursor = z.tuple([period, uuid, z.number().int().positive(), uuid]);
/** `enabled: false` ⇔ the Payroll module is off for the caller; nothing is read and `items` is empty. */
export const PayslipIndexV2 = pageOf(PayslipIndexItemV2).extend({ enabled: z.boolean() });
export type PayslipIndexV2 = z.infer<typeof PayslipIndexV2>;

// ── Payslip detail ─────────────────────────────────────────────────────────────────────────────────────────────

/** A row exactly as the web statement draws it: an amount, or the owner's own text where it prints no amount. */
export const PayslipRowV2 = z.object({
  label,
  /** E.g. "10 hours" or "2 days": the owner's own words, beside the amount. */
  quantity: label.nullable(),
  /** E.g. a unit rate the run recorded ("MYR 36.045"), as the web statement prints it. */
  sub: label.nullable(),
  amount: MoneyV2.nullable(),
  /** Set exactly when `amount` is null. */
  text: label.nullable(),
});
export type PayslipRowV2 = z.infer<typeof PayslipRowV2>;
const total = z.object({ label, amount: MoneyV2 });
export const PayslipSectionV2 = z.object({ title: label, rows: z.array(PayslipRowV2).max(200), total });
export type PayslipSectionV2 = z.infer<typeof PayslipSectionV2>;

export const PayslipDetailV2 = z.object({
  id: uuid,
  employmentId: uuid,
  employeeCode: z.string().max(64).nullable(),
  employee: name,
  company: name,
  period,
  /** The document's own period line (a month name, or the segment a mid-month transfer split). */
  periodLabel: label,
  /** The document's own cycle line: the configured cycle's name, else the run-type word. */
  cycleLabel: label.nullable(),
  /** ISO-4217 as stored on the company; null ⇒ the figures are unlabelled, never a guessed currency. */
  currency: z.string().max(8).nullable(),
  /** Earnings (total: gross pay), then deductions (total: total deductions). */
  sections: z.array(PayslipSectionV2).length(2),
  net: total,
});
export type PayslipDetailV2 = z.infer<typeof PayslipDetailV2>;

/**
 * `not_found`: not the caller's own, not released (unclosed run, or a release instant still ahead), another
 * tenant's or company's, a guessed id, or the Payroll module is off — never told apart.
 */
export const DocumentRefusal = refusalOf(['not_found']);
export type DocumentRefusal = z.infer<typeof DocumentRefusal>;
export const PayslipDetailResult = z.union([z.object({ outcome: z.literal('found'), payslip: PayslipDetailV2 }), DocumentRefusal]);
export type PayslipDetailResult = z.infer<typeof PayslipDetailResult>;

// ── EA ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One own (employment, employer, year) EA source as /me/ea lists it; `available` ⇔ the form can be produced. */
export const EaSourceV2 = z.object({
  employmentId: uuid,
  employeeCode: z.string().max(64).nullable(),
  companyId: uuid,
  company: name,
  year,
  available: z.boolean(),
  /** The employment's current employer for that year (the web's default choice). */
  isCurrent: z.boolean(),
});
export type EaSourceV2 = z.infer<typeof EaSourceV2>;
export const EaSourcesV2 = z.object({ enabled: z.boolean(), items: z.array(EaSourceV2).max(400) });
export type EaSourcesV2 = z.infer<typeof EaSourcesV2>;
/** The two editions of the C.P.8A the renderer draws. */
export const EA_LANGS = ['en', 'ms'] as const;
export const EaLangV2 = z.enum(EA_LANGS);
export type EaLangV2 = z.infer<typeof EaLangV2>;
/** `layout_unavailable`: the form could not be laid out (lib/ea-pdf.ts EaLayoutFitError); no partial PDF exists. */
export const EaDocumentRefusal = refusalOf(['not_found', 'layout_unavailable']);
export type EaDocumentRefusal = z.infer<typeof EaDocumentRefusal>;

// ── Share events (D7) ──────────────────────────────────────────────────────────────────────────────────────────

/** Which document is shared. Identifiers only: never a figure, a name or a file. */
export const SharedDocumentV2 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('payslip'), id: uuid }).strict(),
  z.object({ kind: z.literal('ea'), employmentId: uuid, year, companyId: uuid }).strict(),
]);
export type SharedDocumentV2 = z.infer<typeof SharedDocumentV2>;
export const SHARE_STAGES = ['confirmed', 'completed', 'cancelled'] as const;
export type ShareStage = (typeof SHARE_STAGES)[number];
/**
 * One stage of one share. `shareId` is minted by the app when the person confirms and names every stage of that
 * share; `requestId` is each stage's own idempotency key. `confirmed` must be acknowledged BEFORE the OS share sheet
 * opens; `completed` or `cancelled` closes it, once.
 */
export const ShareEventCommand = commandOf({ shareId: uuid, document: SharedDocumentV2, stage: z.enum(SHARE_STAGES) });
export type ShareEventCommand = z.infer<typeof ShareEventCommand>;
/**
 * `not_found`: `confirmed` for a document the caller may not open now (as DocumentRefusal); `not_confirmed`: a
 * closing stage with no acknowledged `confirmed` of this document under this shareId by this caller;
 * `already_settled`: the share was already completed or cancelled; `request_conflict`: the requestId (or, for
 * `confirmed`, the shareId) already recorded something else; `employment_required`: no own employment to record under.
 */
export const SHARE_EVENT_REFUSALS = ['not_found', 'not_confirmed', 'already_settled', 'request_conflict', 'employment_required'] as const;
export type ShareEventRefusalCode = (typeof SHARE_EVENT_REFUSALS)[number];
export const ShareEventRefusal = refusalOf(SHARE_EVENT_REFUSALS);
export const ShareEventResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('recorded'), shareId: uuid, stage: z.enum(SHARE_STAGES) }),
  ShareEventRefusal,
]);
export type ShareEventResult = z.infer<typeof ShareEventResult>;
