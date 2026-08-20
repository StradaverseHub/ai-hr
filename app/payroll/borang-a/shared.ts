/**
 * 9c8dad7a / 3aae0789 — what the Borang A review screen and its THREE download routes all have to do, in
 * one place.
 *
 * THE FOUR SURFACES MUST NOT BE ABLE TO DISAGREE. The screen says who is missing an EPF member number and
 * hides the buttons; the PDF route draws the form; the text route writes the same content out for reading
 * while you key; the file route emits the i-Akaun upload file. If any one of them resolved the company,
 * validated the period, applied the contribution-month override or gated on readiness differently from
 * the others, the operator would check one document and download another. So all four call `loadBorangA`
 * and there is exactly one of each decision.
 *
 * NO PACK IMPORT (ADR-0080 D1). Everything here goes through `reportPreview` — the generic core seam — so
 * `app/` never names `localization/my`. The form's own header rides on `ReportResult.meta.formHeader` and
 * is turned back into a printable form by `lib/borang-a.ts`.
 *
 * ── TWO READINESS GATES, NOT ONE, AND THEY ARE NOT THE SAME LIST ──────────────────────────────────
 * The PRINTED form blocks on ABSENCE: no EPF member number, no identity card number, or a payroll run
 * that recorded no EPF wage basis. The UPLOAD FILE blocks on all of that AND on FORMAT, because a
 * fixed-width numeric field cannot carry `EPF9203030` — and MEASURED on production 2026-08-13, four of
 * the nine employees who have a member number at all carry exactly that shape, and one of the three
 * companies with an EPF employer reference has `xx` in the box. A value the paper can print is not
 * automatically a value the file can carry, so `loadBorangAFile` layers the second gate on the first.
 *
 * ── THE PER-GENERATION INPUTS ─────────────────────────────────────────────────────────────────────
 * `epfPeriod` — the contribution month. Defaults to payroll + 1 (the rule printed on the form); an
 *               override WARNS and is honoured, because some employers file late or early on purpose.
 * `code`      — the employer's 3-character short code for the upload file's 01 record. THERE IS NO
 *               COLUMN FOR THIS ANYWHERE in the schema, and one is deliberately not added: a second
 *               sample file has not yet proved the value is stable per employer, and a stored field that
 *               turns out to be per-submission is a migration to undo. Typed per generation, blank ⇒
 *               three spaces.
 * `control`   — an OVERRIDE for the trailer's control total. Blank, which it normally is, means the file
 *               derives it: cc74dcb2's sample proves it is the sum of the EPF member numbers on the file.
 *               The box stays because KWSP may ask a particular employer for something else.
 * `batch`     — the batch/sequence number written identically into the 00 and 01 records. Defaults to 1.
 * None of them is persisted, and none of them reaches the pack: `ReportParams` stays {companyId, periodKey}.
 *
 * ⚠️ THE REQUEST'S "SUBMIT-ON PERIOD" HAS NO FIELD AND THEREFORE HAS NO INPUT. The item lists it among
 * the filters, but its own field tables — which are the specification — give it no position in any of the
 * four records. The 00 record's only date is the FILE DATE, which is the day the file is produced. An
 * input that lands nowhere would be a control that silently does nothing, so there is not one.
 */
import { reportPreview } from '@/core/reporting';
import { scopedAdmin } from '@/lib/scope';
import {
  borangAFrom,
  contributionPeriodOverridden,
  isEpfPeriodKey,
  missingBorangAHeader,
  missingBorangARep,
  withContributionPeriod,
  type BorangAForm,
  type BorangARow,
} from '@/lib/borang-a';
import {
  borangAFileEmployeesFrom,
  borangAFileReadiness,
  buildBorangAFile,
  BorangAFileError,
  type BorangAFileReadiness,
} from '@/lib/kwsp-borang-a-file';

/** The catalog id this screen is the form for. One literal, shared, rather than four. */
export const BORANG_A_REPORT_ID = 'my.borang-a';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export type BorangAMissing = { employmentId: string; name: string; missing: string[] };

export type BorangALoad =
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'no-batch' }
  | {
      ok: false;
      reason: 'not-ready';
      missing: BorangAMissing[];
      /** Employer-level header fields the form cannot be filed without. See `missingBorangAHeader`. */
      headerMissing: string[];
    }
  | {
      ok: true;
      form: BorangAForm;
      /**
       * Who cannot go on a filed form. ALWAYS EMPTY unless `includeIncomplete` was set — the download
       * routes never reach `ok: true` with anybody in here, which is what makes the gate a property of
       * this function rather than of each caller's discipline.
       */
      missing: BorangAMissing[];
      /** The employer-level gaps, same rule and same guarantee as `missing` above. */
      headerMissing: string[];
      /** The representative block's gaps. ADVISORY — never blocks. See `missingBorangARep`. */
      repMissing: string[];
      /** What additionally stops the i-AKAUN FILE, which is a stricter list than the paper form's. */
      fileReadiness: BorangAFileReadiness;
      /** True when the contribution month was moved off payroll + 1. A warning, never a refusal. */
      periodOverridden: boolean;
      /** Reconciliation tiles: the run's own figures beside the form's. */
      summary: { label: string; value: string | number }[];
      notes: string[];
      statutoryVersion: string;
    };

/** Every row on the form, in printed order. Used by the file builder and the readiness checks. */
export function borangARows(form: BorangAForm): BorangARow[] {
  return form.pages.flatMap((p) => p.rows);
}

/**
 * Resolve, validate, generate and gate — for a caller that already holds the request's query.
 *
 * FAILS CLOSED TWICE, and answers the SAME 'not-found' for every way of being refused: a malformed id, a
 * period that is not YYYY-MM, a company this admin does not administer, and a company whose jurisdiction
 * does not register this form. `isAdmin` is deliberately not used — it is true for an hr_admin grant on
 * ANY company, so it would let a guessed companyId export another company's employee names, identity card
 * numbers, wages and contributions.
 *
 * READINESS IS ENFORCED HERE, NOT ONLY ON THE SCREEN. A URL is not a screen: hiding the download button
 * while the route still answers 200 means a bookmarked link files a Borang A with somebody's No. Ahli box
 * empty. `includeIncomplete` exists for the REVIEW screen alone, which must be able to render the table
 * in order to name who is missing.
 */
export async function loadBorangA(p: {
  companyId: string;
  periodKey: string;
  query: URLSearchParams;
  includeIncomplete?: boolean;
}): Promise<BorangALoad> {
  if (!UUID.test(p.companyId) || !PERIOD.test(p.periodKey)) return { ok: false, reason: 'not-found' };
  const { s, scopeIds } = await scopedAdmin();
  if (!scopeIds.includes(p.companyId)) return { ok: false, reason: 'not-found' };

  let result;
  try {
    result = await reportPreview(s, {
      companyId: p.companyId,
      reportId: BORANG_A_REPORT_ID,
      periodKey: p.periodKey,
    });
  } catch {
    // `resolveDef` throws for a jurisdiction whose pack does not register this form. Same bare answer as
    // an out-of-scope company, so the URL cannot be used to enumerate either.
    return { ok: false, reason: 'not-found' };
  }
  if (!result.meta.hasBatch) return { ok: false, reason: 'no-batch' };

  const missing = result.readiness.map((r) => ({ employmentId: r.employmentId, name: r.name, missing: r.missing }));
  // TWO KINDS OF GAP, ONE GATE. `missing` is per-employee; `headerMissing` is employer-level (no EPF
  // employer reference) and gaps EVERY page at once. Either one means the document cannot be filed, so
  // either one blocks the download — and the review screen shows both, which is the entire reason it must
  // still render when they exist.
  const headerMissing = missingBorangAHeader(result.meta.formHeader);
  if ((missing.length > 0 || headerMissing.length > 0) && !p.includeIncomplete) {
    return { ok: false, reason: 'not-ready', missing, headerMissing };
  }

  const base = borangAFrom({ header: result.meta.formHeader, rows: result.rows });
  // The operator's contribution month, applied to the FORM rather than passed into the read. An invalid
  // value is ignored rather than throwing: this is a render path and a junk query string must not 500.
  const requested = p.query.get('epfPeriod') ?? '';
  const form = isEpfPeriodKey(requested) ? withContributionPeriod(base, requested) : base;

  return {
    ok: true,
    form,
    missing,
    headerMissing,
    repMissing: missingBorangARep(result.meta.formHeader),
    fileReadiness: borangAFileReadiness({ employerRef: form.employerRef, rows: borangARows(form) }),
    periodOverridden: contributionPeriodOverridden(form.payrollPeriodKey, form.contributionPeriodKey),
    summary: result.meta.summary ?? [],
    notes: result.meta.notes ?? [],
    statutoryVersion: result.meta.statutoryVersion,
  };
}

export type BorangAFileLoad =
  | { ok: false; status: number; message: string }
  | { ok: true; form: BorangAForm; text: string };

/**
 * The i-Akaun upload file, gated by BOTH readiness lists and then by the file's own totals check.
 *
 * THREE REFUSALS, IN ORDER, AND ALL OF THEM BEFORE ANYTHING IS OFFERED:
 *   1. the paper form's gate (`loadBorangA` above), so the file cannot be produced from a form that
 *      could not itself be filed;
 *   2. the file's own stricter gate — a member number that is not digits, an identity card number that
 *      is not twelve digits, an employer reference that is not numeric;
 *   3. `buildBorangAFile`'s self-check, which re-reads its own emitted bytes and refuses when the header
 *      totals, the trailer totals and the sum over the 02 records do not all agree.
 * "Refuse to emit rather than emit a file i-Akaun will reject" is the requirement, and each of the three
 * catches a different way of failing it.
 */
export async function loadBorangAFile(p: {
  companyId: string;
  periodKey: string;
  query: URLSearchParams;
}): Promise<BorangAFileLoad> {
  const loaded = await loadBorangA({ companyId: p.companyId, periodKey: p.periodKey, query: p.query });
  if (!loaded.ok) {
    if (loaded.reason === 'not-found') return { ok: false, status: 404, message: 'Not found' };
    if (loaded.reason === 'no-batch') {
      return { ok: false, status: 422, message: 'No payroll run for this month — run payroll first.' };
    }
    return { ok: false, status: 422, message: `Cannot produce a Borang A upload file: ${describeGaps(loaded)}.` };
  }

  const { fileReadiness } = loaded;
  if (!fileReadiness.ok) {
    const why = [
      ...fileReadiness.employer,
      ...fileReadiness.employees.map((e) => `${e.name}: ${e.problem}`),
    ].join('; ');
    return { ok: false, status: 422, message: `Cannot produce a Borang A upload file: ${why}.` };
  }

  const form = loaded.form;
  const rows = borangARows(form);
  const period = form.contributionPeriodKey;
  const batchRaw = p.query.get('batch') ?? '';
  const batchNo = /^\d{1,5}$/.test(batchRaw) ? Number(batchRaw) : 1;

  try {
    const text = buildBorangAFile({
      employer: {
        epfRefNo: form.employerRef,
        // Typed per generation; no column exists and none is added. See the header comment.
        code: p.query.get('code') ?? '',
        periodMonth: Number(period.slice(5, 7)),
        periodYear: Number(period.slice(0, 4)),
      },
      // THREE AMOUNTS, NOT TWO, AND NEVER ADDED TOGETHER — employer, then employee, then the wage they
      // were worked out from (672.00 / 616.00 / 5,600.00 on one of the sample's lines, which is 12% and
      // 11% of 5,600). Summing the two shares into one box, as this used to, filed a number KWSP has no
      // field for. The mapping itself lives in borangAFileEmployeesFrom and is NOT restated here: two
      // adjacent nine-wide digit fields are transposable without anything downstream noticing, so there
      // is exactly one copy of which share goes where, and the golden test drives that copy.
      employees: borangAFileEmployeesFrom(rows),
      batchNo,
      trailerControlNumber: p.query.get('control') ?? '',
    });
    return { ok: true, form, text };
  } catch (e) {
    // A BorangAFileError is an operator-fixable refusal and says exactly what did not fit. Anything else
    // is a bug and must not be dressed up as one.
    if (e instanceof BorangAFileError) {
      return { ok: false, status: 422, message: `Cannot produce a Borang A upload file: ${e.message}` };
    }
    throw e;
  }
}

/** The two kinds of gap, named, for a route that has to answer in plain text. */
export function describeGaps(loaded: { missing: BorangAMissing[]; headerMissing: string[] }): string {
  return [
    loaded.headerMissing.length ? `the company is missing: ${loaded.headerMissing.join(', ')}` : null,
    loaded.missing.length
      ? loaded.missing.map((m) => `${m.name} (${m.missing.join(', ')})`).join('; ')
      : null,
  ]
    .filter(Boolean)
    .join('; ');
}
