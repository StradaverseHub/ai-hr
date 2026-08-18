/**
 * e0cd4583 — what the CP39 review screen and its TWO download routes all have to do, in one place.
 *
 * THE THREE SURFACES MUST NOT BE ABLE TO DISAGREE. The screen says who is missing a tax reference number
 * and hides the buttons; the PDF route draws the statement; the text route writes the same content out
 * for reading while you key into e-PCB. If any one of them resolved the company, validated the period,
 * applied the preparer overrides or gated on readiness differently from the others, the operator would
 * check one document and download another. So all three call `loadCp39Form` and there is exactly one of
 * each decision.
 *
 * NO PACK IMPORT (ADR-0080 D1). Everything here goes through `reportPreview` — the generic core seam — so
 * `app/` never names `localization/my`. The form's own header rides on `ReportResult.meta.formHeader` and
 * is turned back into a printable statement by `lib/cp39-form.ts`.
 *
 * ── ONE READINESS GATE, AND IT IS THE ONE THE CATALOGUE ALREADY HAD ───────────────────────────────
 * `my.cp39`'s readiness has always been "the tax reference number is missing", because the e-Data PCB
 * file refuses without it (`cp39-file.ts:207` — "TIN is mandatory (Exhibit 4 field 11)"). The printed
 * statement inherits exactly that list rather than inventing a second one, which is the whole reason
 * e0cd4583 enriched the existing generator instead of registering a second CP39 card: two cards would be
 * two gates that could disagree about who is ready to be filed.
 *
 * ── THE PER-GENERATION INPUTS ─────────────────────────────────────────────────────────────────────
 * `prepName` / `prepIc` / `prepPosition` / `prepPhone` — the PEGAWAI YANG MENYEDIAKAN MAKLUMAT block.
 *               Defaults come from the company's LHDN statutory-authority row; these override for one
 *               generation and are never persisted. A BLANK box means "keep the default", not "clear it"
 *               — see `withPreparer`, and note that these boxes are submitted on every request whether
 *               or not they were touched, so presence can never be read as intent (AGENTS rule 17).
 * `date`      — Tarikh. Defaults to today in Malaysian time; an ISO `YYYY-MM-DD` overrides it.
 * `payRef` / `payBranch` — BUTIR-BUTIR PEMBAYARAN, the payment instrument: the cheque / bank draft /
 *               postal order number and the branch it was drawn on. The plan lists these as MANUAL
 *               fields and as editable on the preview, and both halves are true: nothing in the database
 *               can produce either, and this page doubles as the payment cover document, so the operator
 *               usually has the instrument in front of them when they print it. UNLIKE the preparer
 *               boxes these have no default, so an empty one means BLANK — the form prints the ruled
 *               line it always did. See `withPaymentInstrument` for why that is a separate helper.
 * None of them is persisted, and none reaches the pack: `ReportParams` stays {companyId, periodKey}.
 *
 * THE SIGNATURE IS THE ONE FIELD WITH NO INPUT, and that is not an omission: the request says to leave
 * it blank for physical signing, so the form draws a box to sign in.
 */
import { reportPreview } from '@/core/reporting';
import { scopedAdmin } from '@/lib/scope';
import {
  cp39FormFrom,
  missingCp39FormHeader,
  missingCp39Preparer,
  withPaymentInstrument,
  withPreparer,
  type Cp39Form,
  type Cp39FormRow,
} from '@/lib/cp39-form';

/** The catalog id this screen is the printed form for. One literal, shared, rather than three. */
export const CP39_REPORT_ID = 'my.cp39';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export type Cp39Missing = { employmentId: string; name: string; missing: string[] };

export type Cp39Load =
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'no-batch' }
  | {
      ok: false;
      reason: 'not-ready';
      missing: Cp39Missing[];
      /** Employer-level header fields the statement cannot be produced without. */
      headerMissing: string[];
    }
  | {
      ok: true;
      form: Cp39Form;
      /**
       * Who cannot go on a completed statement. ALWAYS EMPTY unless `includeIncomplete` was set — the
       * download routes never reach `ok: true` with anybody in here, which is what makes the gate a
       * property of this function rather than of each caller's discipline.
       */
      missing: Cp39Missing[];
      /** The employer-level gaps, same rule and same guarantee as `missing` above. */
      headerMissing: string[];
      /** The preparer block's gaps. ADVISORY — never blocks. See `missingCp39Preparer`. */
      preparerMissing: string[];
      notes: string[];
      statutoryVersion: string;
    };

/** Every row on the statement, in printed order. */
export function cp39FormRows(form: Cp39Form): Cp39FormRow[] {
  return form.pages.flatMap((p) => p.rows);
}

/**
 * Resolve, validate, generate and gate — for a caller that already holds the request's query.
 *
 * FAILS CLOSED TWICE, and answers the SAME 'not-found' for every way of being refused: a malformed id, a
 * period that is not YYYY-MM, a company this admin does not administer, and a company whose jurisdiction
 * does not register this form. `isAdmin` is deliberately not used — it is true for an hr_admin grant on
 * ANY company, so it would let a guessed companyId export another company's employee names, identity
 * card numbers, tax reference numbers and monthly deductions.
 *
 * READINESS IS ENFORCED HERE, NOT ONLY ON THE SCREEN. A URL is not a screen: hiding the download button
 * while the route still answers 200 means a bookmarked link produces a CP39 with somebody's No. Cukai
 * Pendapatan box empty. `includeIncomplete` exists for the REVIEW screen alone, which must be able to
 * render the table in order to name who is missing.
 */
export async function loadCp39Form(p: {
  companyId: string;
  periodKey: string;
  query: URLSearchParams;
  includeIncomplete?: boolean;
}): Promise<Cp39Load> {
  if (!UUID.test(p.companyId) || !PERIOD.test(p.periodKey)) return { ok: false, reason: 'not-found' };
  const { s, scopeIds } = await scopedAdmin();
  if (!scopeIds.includes(p.companyId)) return { ok: false, reason: 'not-found' };

  let result;
  try {
    result = await reportPreview(s, {
      companyId: p.companyId,
      reportId: CP39_REPORT_ID,
      periodKey: p.periodKey,
    });
  } catch {
    // `resolveDef` throws for a jurisdiction whose pack does not register this form. Same bare answer as
    // an out-of-scope company, so the URL cannot be used to enumerate either.
    return { ok: false, reason: 'not-found' };
  }
  if (!result.meta.hasBatch) return { ok: false, reason: 'no-batch' };

  const missing = result.readiness.map((r) => ({ employmentId: r.employmentId, name: r.name, missing: r.missing }));
  // TWO KINDS OF GAP, ONE GATE. `missing` is per-employee; `headerMissing` is employer-level (no LHDN
  // employer number) and gaps EVERY page at once. Either one means the statement cannot be completed, so
  // either one blocks the download — and the review screen shows both, which is the entire reason it
  // must still render when they exist.
  const headerMissing = missingCp39FormHeader(result.meta.formHeader);
  if ((missing.length > 0 || headerMissing.length > 0) && !p.includeIncomplete) {
    return { ok: false, reason: 'not-ready', missing, headerMissing };
  }

  const base = cp39FormFrom({ header: result.meta.formHeader, rows: result.rows });
  // The operator's preparer block and print date, applied to the FORM rather than passed into the read,
  // so `ReportParams` stays {companyId, periodKey} and the pack never learns about a per-generation
  // input. An invalid date is ignored rather than throwing: this is a render path and a junk query
  // string must not 500 the review screen.
  const form = withPaymentInstrument(
    withPreparer(base, {
      preparerName: p.query.get('prepName') ?? undefined,
      preparerIc: p.query.get('prepIc') ?? undefined,
      preparerPosition: p.query.get('prepPosition') ?? undefined,
      preparerPhone: p.query.get('prepPhone') ?? undefined,
      printedOnIso: p.query.get('date') ?? undefined,
    }),
    // Applied HERE and nowhere else, which is what stops the reviewed statement and the downloaded one
    // carrying different cheque numbers: the screen and both routes reach the form through this call.
    {
      paymentRef: p.query.get('payRef') ?? undefined,
      paymentBranch: p.query.get('payBranch') ?? undefined,
    },
  );

  return {
    ok: true,
    form,
    missing,
    headerMissing,
    // Computed from the form AFTER the operator's overrides, not from the raw header: typing a name into
    // the preview must clear that advisory, or the screen would keep nagging about a box now filled in.
    preparerMissing: missingCp39Preparer({
      preparerName: form.preparerName,
      preparerIc: form.preparerIc,
      preparerPosition: form.preparerPosition,
      preparerPhone: form.preparerPhone,
    }),
    notes: result.meta.notes ?? [],
    statutoryVersion: result.meta.statutoryVersion,
  };
}

/** The two kinds of gap, named, for a route that has to answer in plain text. */
export function describeCp39Gaps(loaded: { missing: Cp39Missing[]; headerMissing: string[] }): string {
  return [
    loaded.headerMissing.length ? `the company is missing: ${loaded.headerMissing.join(', ')}` : null,
    loaded.missing.length ? loaded.missing.map((m) => `${m.name} (${m.missing.join(', ')})`).join('; ') : null,
  ]
    .filter(Boolean)
    .join('; ');
}
