/**
 * 8ca344bf — what the Borang 8A review screen and its two download routes ALL have to do, in one place.
 *
 * THE THREE SURFACES MUST NOT BE ABLE TO DISAGREE. The screen says who is missing an IC and hides the
 * buttons; the PDF route draws the form; the text route writes the same content out for keying into
 * PERKESO's portal. If any one of them resolved the company, validated the period, gated on readiness or
 * merged the typed statuses differently from the others, the operator would check one document and
 * download another. So all three call `loadBorang8A` and there is exactly one of each decision.
 *
 * NO PACK IMPORT (ADR-0080 D1). Everything here goes through `reportPreview` — the generic core seam — so
 * `app/` never names `localization/my`. The form's own header rides on `ReportResult.meta.formHeader` and
 * is turned back into a printable form by `lib/borang-8a.ts`.
 */
import { reportPreview } from '@/core/reporting';
import { scopedAdmin } from '@/lib/scope';
import {
  applyStatusOverrides,
  borang8AFrom,
  missingBorang8AHeader,
  statusOverridesFrom,
  type Borang8AForm,
} from '@/lib/borang-8a';
import {
  PerkesoFileError,
  buildPerkesoSocsoFile,
  perkesoFileEmployeesFrom,
  perkesoLayoutForPeriod,
  perkesoSkbbkNotCarried,
  type PerkesoFileLayout,
} from '@/lib/perkeso-socso-file';

/**
 * 18c1d92b — THE PERKESO ASSIST UPLOAD FILE, gated by the paper form's own readiness and then by the
 * file's stricter one.
 *
 * TWO REFUSALS, IN ORDER, BOTH BEFORE ANYTHING IS OFFERED: the paper form's gate (`loadBorang8A`), so a
 * file cannot be produced from a form that could not itself be filed; then `buildPerkesoSocsoFile`'s own
 * — a twelve-character identity number, an amount that fits its box, and a recorded SOCSO wage for every
 * employee. A file that PERKESO would reject is never handed over; being told at the portal is a slower
 * way to learn the same thing.
 */
export type Borang8AFileLoad =
  | { ok: false; status: number; message: string }
  | {
      ok: true;
      form: Borang8AForm;
      text: string;
      /** r296 — which revision of the format these bytes are, decided by the contribution month. */
      layout: PerkesoFileLayout;
      /** r296 — SKBBK in RM that this revision has no box for. 0 once the v2.0 column exists. */
      skbbkNotCarried: number;
    };

export async function loadBorang8AFile(p: {
  companyId: string;
  periodKey: string;
  query: URLSearchParams;
}): Promise<Borang8AFileLoad> {
  const loaded = await loadBorang8A(p);
  if (!loaded.ok) {
    if (loaded.reason === 'not-found') return { ok: false, status: 404, message: 'Not found' };
    if (loaded.reason === 'no-batch') {
      return { ok: false, status: 422, message: 'No payroll run for this month — run payroll first.' };
    }
    const why = [
      loaded.headerMissing.length ? `the company is missing: ${loaded.headerMissing.join(', ')}` : null,
      loaded.missing.length ? `no identity card number on file for ${loaded.missing.map((m) => m.name).join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    return { ok: false, status: 422, message: `Cannot produce a PERKESO upload file: ${why}.` };
  }

  const form = loaded.form;
  const period = form.contributionPeriodKey;
  const periodMonth = Number(period.slice(5, 7));
  const periodYear = Number(period.slice(0, 4));
  // r296 — THE REVISION IS A PROPERTY OF THE CONTRIBUTION MONTH, not of this screen. Resolved here only
  // so the same answer can be handed to the writer, to the validation report and to the artefact record;
  // `perkesoLayoutForPeriod` is the one place the 1 Oct 2026 cutover lives.
  const layout = perkesoLayoutForPeriod(periodYear, periodMonth);
  const rows = form.pages.flatMap((pg) => pg.rows);
  try {
    const text = buildPerkesoSocsoFile({
      employer: {
        employerCode: form.employerCode,
        myCoId: form.mycoid,
        periodMonth,
        periodYear,
      },
      // The mapping itself lives in perkesoFileEmployeesFrom and is NOT restated here: four of the six
      // numeric boxes are six wide and adjacent, so a transposition would produce a file of exactly the
      // right length carrying the wrong money. One copy, driven by the golden test.
      employees: perkesoFileEmployeesFrom(rows),
      layout,
    });
    return { ok: true, form, text, layout, skbbkNotCarried: perkesoSkbbkNotCarried(layout, rows) };
  } catch (e) {
    if (e instanceof PerkesoFileError) {
      return { ok: false, status: 422, message: `Cannot produce a PERKESO upload file: ${e.message}` };
    }
    throw e;
  }
}

/** The catalog id this screen is the form for. One literal, shared, rather than three. */
export const BORANG_8A_REPORT_ID = 'my.borang-8a';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export type Borang8ALoad =
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'no-batch' }
  | {
      ok: false;
      reason: 'not-ready';
      missing: { employmentId: string; name: string }[];
      /** Employer-level header fields the form cannot be filed without. See `missingBorang8AHeader`. */
      headerMissing: string[];
    }
  | {
      ok: true;
      form: Borang8AForm;
      /**
       * Who has no IC on file. ALWAYS EMPTY unless `includeIncomplete` was set — the download routes
       * never reach `ok: true` with anybody in here, which is what makes the gate a property of this
       * function rather than of each caller's discipline.
       */
      missing: { employmentId: string; name: string }[];
      /** The employer-level gaps, same rule and same guarantee as `missing` above. */
      headerMissing: string[];
      /** Reconciliation tiles: the run's own figures beside the form's. */
      summary: { label: string; value: string | number }[];
      notes: string[];
      statutoryVersion: string;
    };

/**
 * Resolve, validate, generate, gate and merge — for a caller that already holds the request's query.
 *
 * FAILS CLOSED TWICE, and answers the SAME 'not-found' for every way of being refused: a malformed id, a
 * period that is not YYYY-MM, a company this admin does not administer, and a company whose jurisdiction
 * does not register this form. `isAdmin` is deliberately not used — it is true for an hr_admin grant on
 * ANY company, so it would let a guessed companyId export another company's employee names, ICs and
 * contributions.
 *
 * READINESS IS ENFORCED HERE, NOT ONLY ON THE SCREEN. A URL is not a screen: hiding the download button
 * while the route still answers 200 means a bookmarked link files a Borang 8A with somebody's IC box
 * empty. `includeIncomplete` exists for the REVIEW screen alone, which must be able to render the table
 * in order to name who is missing.
 */
export async function loadBorang8A(p: {
  companyId: string;
  periodKey: string;
  query: URLSearchParams;
  includeIncomplete?: boolean;
}): Promise<Borang8ALoad> {
  if (!UUID.test(p.companyId) || !PERIOD.test(p.periodKey)) return { ok: false, reason: 'not-found' };
  const { s, scopeIds } = await scopedAdmin();
  if (!scopeIds.includes(p.companyId)) return { ok: false, reason: 'not-found' };

  let result;
  try {
    result = await reportPreview(s, {
      companyId: p.companyId,
      reportId: BORANG_8A_REPORT_ID,
      periodKey: p.periodKey,
    });
  } catch {
    // `resolveDef` throws for a jurisdiction whose pack does not register this form. Same bare answer as
    // an out-of-scope company, so the URL cannot be used to enumerate either.
    return { ok: false, reason: 'not-found' };
  }
  if (!result.meta.hasBatch) return { ok: false, reason: 'no-batch' };

  const missing = result.readiness.map((r) => ({ employmentId: r.employmentId, name: r.name }));
  // TWO KINDS OF GAP, ONE GATE. `missing` is per-employee (no identity card number); `headerMissing` is
  // employer-level (no SOCSO employer code) and gaps EVERY page at once. Either one means the document
  // cannot be filed, so either one blocks the download — and the review screen shows both, which is the
  // entire reason it must still render when they exist.
  const headerMissing = missingBorang8AHeader(result.meta.formHeader);
  if ((missing.length > 0 || headerMissing.length > 0) && !p.includeIncomplete) {
    return { ok: false, reason: 'not-ready', missing, headerMissing };
  }

  const base = borang8AFrom({ header: result.meta.formHeader, rows: result.rows });
  // The statuses typed on the review screen, read BY VALUE — every row submits its box whether or not
  // anything was typed into it, so presence would stamp a status on all 33 people. See statusOverridesFrom.
  const overrides = statusOverridesFrom(p.query);
  const form: Borang8AForm = overrides.size
    ? borang8AFrom({
        header: result.meta.formHeader,
        rows: applyStatusOverrides(
          base.pages.flatMap((pg) => pg.rows),
          overrides,
        ),
      })
    : base;

  return {
    ok: true,
    form,
    missing,
    headerMissing,
    summary: result.meta.summary ?? [],
    notes: result.meta.notes ?? [],
    statutoryVersion: result.meta.statutoryVersion,
  };
}
