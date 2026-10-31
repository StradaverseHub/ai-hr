/**
 * r412 (item e74af58c, step 2) — what the Borang 8B screen and its PDF route BOTH do, in one place.
 *
 * TWO REFUSALS ONLY, because the 8B is drawn from no payroll run (localization/my/borang-8b.ts):
 *   • not-found — a malformed company id or month, a company outside this admin's scope (`scopedAdmin`, never
 *     `isAdmin`), or a jurisdiction without the form: ONE answer, so the URL enumerates nothing;
 *   • not-ready — the header the form cannot be filed without (No. Kod Majikan, the company's legal name).
 *     The screen still renders, to say which; the download is refused.
 * There is no cycles criterion and no "nothing to file" refusal: the employee lines are the employer's to
 * fill, so an 8B for a month with no payroll is still an 8B.
 *
 * NO PACK IMPORT (ADR-0080 D1): through `reportPreview`.
 */
import { reportPreview } from '@/core/reporting';
import { scopedAdmin } from '@/lib/scope';
import { borang8BFrom, borang8BMonthHasEnded, missingBorang8BHeader, type Borang8BForm } from '@/lib/borang-8b';
import { todayInKualaLumpur } from '@/lib/hr-date';

export const BORANG_8B_REPORT_ID = 'my.borang-8b';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export type Borang8BLoad =
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'month-not-ended' }
  | { ok: false; reason: 'not-ready'; headerMissing: string[] }
  | { ok: true; form: Borang8BForm; headerMissing: string[]; notes: string[] };

export async function loadBorang8B(p: {
  companyId: string;
  periodKey: string;
  includeIncomplete?: boolean;
}): Promise<Borang8BLoad> {
  if (!UUID.test(p.companyId) || !PERIOD.test(p.periodKey)) return { ok: false, reason: 'not-found' };
  const { s, scopeIds } = await scopedAdmin();
  if (!scopeIds.includes(p.companyId)) return { ok: false, reason: 'not-found' };
  // r412 verify D1 — no under-payment can be declared for a month that has not ended.
  if (!borang8BMonthHasEnded(p.periodKey, todayInKualaLumpur())) return { ok: false, reason: 'month-not-ended' };
  let result;
  try {
    result = await reportPreview(s, { companyId: p.companyId, reportId: BORANG_8B_REPORT_ID, periodKey: p.periodKey });
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  const headerMissing = missingBorang8BHeader(result.meta.formHeader);
  if (headerMissing.length > 0 && !p.includeIncomplete) return { ok: false, reason: 'not-ready', headerMissing };
  return { ok: true, form: borang8BFrom(result.meta.formHeader), headerMissing, notes: result.meta.notes ?? [] };
}

/** The download query: company and the under-paid month. One spelling for the frame and the download. */
export function borang8BDocumentQuery(p: { companyId: string; periodKey: string }): string {
  return new URLSearchParams({ companyId: p.companyId, periodKey: p.periodKey }).toString();
}
