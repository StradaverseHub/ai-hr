/**
 * r412 (item e74af58c, step 2) — what the EIS (SIP) schedule's review screen and its PDF route BOTH do, in
 * one place, so the screen and the download cannot disagree (the Borang 8A loader's rule, and its shape).
 *
 * THE SAME REFUSALS AS THE 8A, IN THE SAME ORDER: not-found (a malformed id or month, a company outside this
 * admin's scope, a jurisdiction without the form — one answer, so the URL enumerates nothing); bad-selection;
 * no-batch; selection-empty; NOT-READY with names (a missing IC, inconsistent SOCSO/EIS wages, or — a
 * bonus-only selection — SOCSO/EIS not in this selection, the r373 refusal the reporter was told about);
 * then no-contributions, asked only when nobody is named. The readiness list is the 8A read's, carried
 * through `sipContributionReport` unchanged.
 *
 * NO PACK IMPORT (ADR-0080 D1): everything goes through `reportPreview`.
 */
import { reportPreview } from '@/core/reporting';
import { scopedAdmin } from '@/lib/scope';
import { parseRunSelection } from '@/lib/payroll-run-selection';
import { missingSipHeader, sipFrom, type SipForm } from '@/lib/sip-contribution';
import { sipHasContributions } from './query';

/** The catalog id this screen is the form for. */
export const SIP_REPORT_ID = 'my.sip-contribution';

/** The route's plain-text refusal for a selection with no EIS on it. */
export const NO_EIS_CONTRIBUTIONS =
  'No processed EIS contributions for this month and these payroll cycles — no EIS (SIP) schedule is produced.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export type SipMissing = { employmentId: string; name: string; missing: string[] };

/** Both kinds of gap, named, for a route that answers in plain text. */
export function describeSipGaps(loaded: { missing: SipMissing[]; headerMissing: string[] }): string {
  return [
    loaded.headerMissing.length ? `the company is missing: ${loaded.headerMissing.join(', ')}` : null,
    loaded.missing.length ? loaded.missing.map((m) => `${m.name} (${m.missing.join(', ')})`).join('; ') : null,
  ]
    .filter(Boolean)
    .join('; ');
}

export type SipLoad =
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'no-batch' }
  | { ok: false; reason: 'selection-empty' }
  | { ok: false; reason: 'bad-selection'; message: string }
  | { ok: false; reason: 'no-contributions' }
  | { ok: false; reason: 'not-ready'; missing: SipMissing[]; headerMissing: string[] }
  | {
      ok: true;
      form: SipForm;
      /** ALWAYS EMPTY unless `includeIncomplete` — the download never reaches `ok: true` with anyone here. */
      missing: SipMissing[];
      headerMissing: string[];
      summary: { label: string; value: string | number }[];
      notes: string[];
    };

export async function loadSip(p: {
  companyId: string;
  periodKey: string;
  query: URLSearchParams;
  includeIncomplete?: boolean;
}): Promise<SipLoad> {
  if (!UUID.test(p.companyId) || !PERIOD.test(p.periodKey)) return { ok: false, reason: 'not-found' };
  const { s, scopeIds } = await scopedAdmin();
  if (!scopeIds.includes(p.companyId)) return { ok: false, reason: 'not-found' };

  const selection = parseRunSelection(p.query);
  if (!selection.ok) return { ok: false, reason: 'bad-selection', message: selection.reason };

  let result;
  try {
    result = await reportPreview(s, {
      companyId: p.companyId,
      reportId: SIP_REPORT_ID,
      periodKey: p.periodKey,
      runSeqs: selection.runSeqs,
    });
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  if (!result.meta.hasBatch) return { ok: false, reason: 'no-batch' };
  if (result.meta.selectionEmpty) return { ok: false, reason: 'selection-empty' };

  const missing = result.readiness.map((r) => ({ employmentId: r.employmentId, name: r.name, missing: r.missing }));
  const headerMissing = missingSipHeader(result.meta.formHeader);
  // NOTHING TO FILE — asked only when nobody is named (a bonus-only selection keeps its named refusal).
  if (missing.length === 0 && !sipHasContributions(result.rows)) return { ok: false, reason: 'no-contributions' };
  if ((missing.length > 0 || headerMissing.length > 0) && !p.includeIncomplete) {
    return { ok: false, reason: 'not-ready', missing, headerMissing };
  }

  return {
    ok: true,
    form: sipFrom({ header: result.meta.formHeader, rows: result.rows }),
    missing,
    headerMissing,
    summary: result.meta.summary ?? [],
    notes: result.meta.notes ?? [],
  };
}
