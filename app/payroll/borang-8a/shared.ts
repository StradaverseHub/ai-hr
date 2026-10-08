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
import { borang8AHasContributions } from './query';
import { scopedAdmin } from '@/lib/scope';
import { parseRunSelection } from '@/lib/payroll-run-selection';
import {
  applyStatusOverrides,
  borang8AFrom,
  missingBorang8AHeader,
  statusOverridesFrom,
  type Borang8AForm,
  type Borang8ARow,
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

/**
 * r418 (item e74af58c) — THE ROWS AS THE ASSIST FILE SEES THEM: the IC FIELD as stored in the `ic` slot, never
 * the printed identity number. The paper form's column (3) now follows the EPF citizenship status (a
 * non-citizen's passport), but this file's field 3 is "Identification Number / SOCSO Foreign Worker Number" on
 * PERKESO's own specification (PERKESO_FILE_FIELDS in lib/perkeso-socso-file.ts), which names no passport, so
 * the file carries exactly what it carried before r418. `passportOnly` names whoever the paper form shows by
 * passport alone, so the file refuses them in words that say why rather than by the writer's bare width check.
 * Pure: one place, pinned by test/r418-statutory-identity.test.ts.
 */
export function borang8AFileRows(form: Borang8AForm): { rows: Borang8ARow[]; passportOnly: string[] } {
  const all = form.pages.flatMap((pg) => pg.rows);
  return {
    rows: all.map((r) => ({ ...r, ic: r.icNumber })),
    passportOnly: all.filter((r) => r.idKind === 'passport' && !r.icNumber.trim()).map((r) => r.name),
  };
}

export async function loadBorang8AFile(p: {
  companyId: string;
  periodKey: string;
  query: URLSearchParams;
}): Promise<Borang8AFileLoad> {
  const loaded = await loadBorang8A({ ...p, refuseEmpty: false });
  if (!loaded.ok) {
    if (loaded.reason === 'not-found') return { ok: false, status: 404, message: 'Not found' };
    if (loaded.reason === 'no-batch') {
      return { ok: false, status: 422, message: 'No payroll run for this month — run payroll first.' };
    }
    // r372 (item f022dd70) — two more refusals, both about the payroll-cycle selection and both
    // 422 rather than 404: the operator can fix each of them from the pop-up they came from.
    if (loaded.reason === 'selection-empty') {
      return {
        ok: false,
        status: 422,
        message: 'No payroll run for this month matches the payroll cycles you selected.',
      };
    }
    if (loaded.reason === 'bad-selection') return { ok: false, status: 422, message: loaded.message };
    if (loaded.reason === 'no-contributions') return { ok: false, status: 422, message: NO_CONTRIBUTIONS };
    return {
      ok: false,
      status: 422,
      message: `Cannot produce a PERKESO upload file: ${describeGaps(loaded)}.`,
    };
  }

  const form = loaded.form;
  const period = form.contributionPeriodKey;
  const periodMonth = Number(period.slice(5, 7));
  const periodYear = Number(period.slice(0, 4));
  // r296 — THE REVISION IS A PROPERTY OF THE CONTRIBUTION MONTH, not of this screen. Resolved here only
  // so the same answer can be handed to the writer, to the validation report and to the artefact record;
  // `perkesoLayoutForPeriod` is the one place the 1 Oct 2026 cutover lives.
  const layout = perkesoLayoutForPeriod(periodYear, periodMonth);
  // r418 (item e74af58c) — the IC field, never the printed passport. See `borang8AFileRows`.
  const { rows, passportOnly } = borang8AFileRows(form);
  if (passportOnly.length > 0) {
    return {
      ok: false,
      status: 422,
      message:
        `Cannot produce a PERKESO upload file: ${passportOnly.join(', ')} — only a passport number is on file, and ` +
        "the file's identity field holds an identity card number or a SOCSO foreign worker number.",
    };
  }
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

/** r408 — the routes' plain-text refusal for a selection with no SOCSO contribution on it. */
export const NO_CONTRIBUTIONS =
  'No processed SOCSO contributions for this month and these payroll cycles — no Borang 8A is produced.';

/** The catalog id this screen is the form for. One literal, shared, rather than three. */
export const BORANG_8A_REPORT_ID = 'my.borang-8a';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * r372 — WHO CANNOT GO ON A FILED RETURN, AND WHY, carried as the pack's own reasons.
 *
 * IT USED TO BE `{ employmentId, name }` AND THREE PLACES SPELLED THE REASON OUT AS "no identity card
 * number on file". That was true while an absent IC was the only per-employee gap; r372 gave the read a
 * second one (a month whose payroll runs were charged on different SOCSO/EIS wages), and a caption that
 * names a cause it cannot know is exactly the assurance CLAUDE.md §8 forbids. The reasons come from the
 * pack, which is the only thing that knows them, and every surface prints the SAME ones — the Borang A
 * side already worked this way (`describeGaps` in app/payroll/borang-a/shared.ts).
 */
export type Borang8AMissing = { employmentId: string; name: string; missing: string[] };

/** The two kinds of gap, named, for a route that has to answer in plain text. One copy, three callers. */
export function describeGaps(loaded: { missing: Borang8AMissing[]; headerMissing: string[] }): string {
  return [
    loaded.headerMissing.length ? `the company is missing: ${loaded.headerMissing.join(', ')}` : null,
    loaded.missing.length
      ? loaded.missing.map((m) => `${m.name} (${m.missing.join(', ')})`).join('; ')
      : null,
  ]
    .filter(Boolean)
    .join('; ');
}

export type Borang8ALoad =
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'no-batch' }
  /**
   * r372 (item f022dd70) — the month has payroll runs, but none of them is a cycle the operator
   * ticked. NOT 'no-batch': that one tells them to run payroll, and this one tells them to look at
   * the pop-up. Reachable only from a hand-edited link, because the control offers what exists.
   */
  | { ok: false; reason: 'selection-empty' }
  /** r372 — the run parameters on the link are not run numbers. Refused, never quietly widened. */
  | { ok: false; reason: 'bad-selection'; message: string }
  /**
   * r408 (item e74af58c) — the runs exist and were ticked, but carry NO SOCSO contribution at all (nobody on
   * them, or not a sen charged) and nobody is named on the readiness list. A Borang 8A of empty boxes would
   * assert a filing of nothing. Refused HERE so the preview, the PDF and the text copy refuse it the same
   * way; the ASSIST file and the Payment Submission shelf pass `refuseEmpty: false` and keep building it, as
   * before r408 (whether PERKESO expects a nil filing is unknown). A BONUS-ONLY selection does not land here: the read
   * names everyone on it with the "not in this selection" reason, and that is the refusal it gets (r373).
   */
  | { ok: false; reason: 'no-contributions' }
  | {
      ok: false;
      reason: 'not-ready';
      missing: Borang8AMissing[];
      /** Employer-level header fields the form cannot be filed without. See `missingBorang8AHeader`. */
      headerMissing: string[];
    }
  | {
      ok: true;
      form: Borang8AForm;
      /**
       * Who cannot go on a filed return, and WHY. ALWAYS EMPTY unless `includeIncomplete` was set — the
       * download routes never reach `ok: true` with anybody in here, which is what makes the gate a
       * property of this function rather than of each caller's discipline.
       */
      missing: Borang8AMissing[];
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
 *
 * ── r372 (item f022dd70): THE PAYROLL CYCLES THIS DOWNLOAD COVERS ─────────────────────────────────
 * Read off the SAME query the rest of the per-generation inputs are read from, and validated in ONE place
 * (lib/payroll-run-selection.ts) so the three statutory formats cannot disagree about what a bad value
 * means. NO run parameters ⇒ `undefined` ⇒ the whole month, which is what every link written before r372
 * is. Since r408 (item e74af58c) the review screen, its framed PDF and every download carry the criteria
 * step's selection, through ONE list (`./query.ts`). An
 * INVALID one is REFUSED rather than dropped: dropping it would build the file over a different population
 * from the one the URL named, which is the reporter's acceptance criterion read backwards.
 */
export async function loadBorang8A(p: {
  companyId: string;
  periodKey: string;
  query: URLSearchParams;
  includeIncomplete?: boolean;
  /**
   * r408 — the "nothing to file" refusal is the FORM's (preview, PDF, text): the plan promises no empty
   * Borang 8A is drawn. The ASSIST upload file keeps its pre-r408 behaviour for a month with no SOCSO,
   * exactly as r407 left the KWSP file: whether PERKESO expects a nil filing is UNKNOWN, and refusing it
   * would block a filing nobody asked us to stop. `loadBorang8AFile` passes false.
   */
  refuseEmpty?: boolean;
}): Promise<Borang8ALoad> {
  if (!UUID.test(p.companyId) || !PERIOD.test(p.periodKey)) return { ok: false, reason: 'not-found' };
  const { s, scopeIds } = await scopedAdmin();
  if (!scopeIds.includes(p.companyId)) return { ok: false, reason: 'not-found' };

  const selection = parseRunSelection(p.query);
  if (!selection.ok) return { ok: false, reason: 'bad-selection', message: selection.reason };

  let result;
  try {
    result = await reportPreview(s, {
      companyId: p.companyId,
      reportId: BORANG_8A_REPORT_ID,
      periodKey: p.periodKey,
      runSeqs: selection.runSeqs,
    });
  } catch {
    // `resolveDef` throws for a jurisdiction whose pack does not register this form. Same bare answer as
    // an out-of-scope company, so the URL cannot be used to enumerate either.
    return { ok: false, reason: 'not-found' };
  }
  if (!result.meta.hasBatch) return { ok: false, reason: 'no-batch' };
  // r372 — the month ran, the ticked cycles are not in it. Answered apart from 'no-batch' so the
  // operator is sent to the control they got wrong rather than to a payroll run that already exists.
  if (result.meta.selectionEmpty) return { ok: false, reason: 'selection-empty' };

  const missing = result.readiness.map((r) => ({ employmentId: r.employmentId, name: r.name, missing: r.missing }));
  // TWO KINDS OF GAP, ONE GATE. `missing` is per-employee (no identity card number, or — r372 — a month
  // whose runs were charged on different SOCSO/EIS wages); `headerMissing` is employer-level (no SOCSO
  // employer code) and gaps EVERY page at once. Either one means the document cannot be filed, so either
  // one blocks the download — and the review screen shows both, which is the entire reason it must still
  // render when they exist.
  const headerMissing = missingBorang8AHeader(result.meta.formHeader);
  // r408 — NOTHING TO FILE. Asked only when nobody is named: a bonus-only selection names every person with
  // the SOCSO-not-in-this-selection reason, and that named refusal is the one it has always had.
  if (p.refuseEmpty !== false && missing.length === 0 && !borang8AHasContributions(result.rows)) return { ok: false, reason: 'no-contributions' };
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
