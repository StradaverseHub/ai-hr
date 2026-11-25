/**
 * Board 66175cd2 — WHICH PAYROLL MONTHS THE OPEN FORM STEP MAY OFFER, for one form and one company.
 *
 * The reporter asked that Payroll Year and Payroll Month on Borang A and BBCD show only periods with
 * successfully processed payroll carrying EPF for the chosen company, and that the lists refresh when the
 * company changes. The step server-renders the default company's list; this route answers the same question
 * for the company chosen afterwards. Beside `/payroll/payment-submission/runs` (CYCLES_ENDPOINT), which
 * answers the Payroll Cycle list for one month, and built the same way.
 *
 * A `route.ts` NEEDS NO SCREENS COLUMN in lib/permissions.ts — test/function-access.test.ts walks `page.tsx`
 * files, and the guarded criteria step this serves is already registered.
 *
 * ── GATED `scopedAdmin`, NEVER `isAdmin` ─────────────────────────────────────────────────────────
 * The same gate as the criteria step and the form's own preview. An out-of-scope company, a malformed id, an
 * unknown form or a form that declares no period list all answer the SAME empty list, with no new screen key
 * and no distinguishable error, so the parameters cannot be used to enumerate companies or forms.
 *
 * ── NO PACK IMPORT (ADR-0080 D1) ─────────────────────────────────────────────────────────────────
 * It reaches the form's period list through `reportAvailablePeriods` (core/reporting), which resolves the
 * form from the company's own jurisdiction. NOTHING IS WRITTEN and no form is generated.
 */
import { scopedAdmin } from '@/lib/scope';
import { reportAvailablePeriods } from '@/core/reporting';

export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A catalog id: `my.borang-a`. Anything else is refused before it reaches the catalog. */
const FORM_ID = /^[a-z]{2}\.[a-z0-9.-]{1,60}$/;

export type AvailablePeriodsResponse = { periods: string[] };

const empty = () =>
  Response.json({ periods: [] } satisfies AvailablePeriodsResponse, { headers: { 'Cache-Control': 'private, no-store' } });

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const companyId = q.get('companyId') ?? '';
  const reportId = q.get('form') ?? '';
  if (!UUID.test(companyId) || !FORM_ID.test(reportId)) return empty();

  const { s, scopeIds } = await scopedAdmin();
  const periods = await reportAvailablePeriods(s, { companyIds: scopeIds, companyId, reportId });

  return Response.json({ periods } satisfies AvailablePeriodsResponse, {
    // `no-store`: the list changes the moment a payroll run is processed, and it describes a company's payroll.
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
