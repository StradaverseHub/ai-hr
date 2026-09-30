/**
 * r372 (item f022dd70) — WHICH PAYROLL CYCLES THE DOWNLOAD POP-UP MAY OFFER, for one company and month.
 *
 * The reporter asked that the Payroll Cycle field "shall only display Payroll Cycles that are applicable
 * to the selected Company, Year and Payroll Month" and that it "should not display unrelated Payroll
 * Cycles from another company, month, or year". That is a database question, and this is where it is
 * asked — not in `../page.tsx`.
 *
 * ── WHY A ROUTE AND NOT THE PAGE ─────────────────────────────────────────────────────────────────
 * `test/payment-submission-screen-seam.test.ts` renders that page with NO DATABASE AT ALL, which is what
 * makes "the registry drives the screen" a property somebody can actually check rather than a claim. The
 * pop-up's company, year and month are also chosen AFTER the page has rendered, so a server-rendered list
 * would be the wrong month the moment the operator changed the dropdown. The dialog fetches this when it
 * opens and again whenever one of the three changes.
 *
 * A `route.ts` NEEDS NO SCREENS COLUMN in lib/permissions.ts — `test/function-access.test.ts`'s
 * reverse-completeness check walks `page.tsx` files, and the guarded page this sits under is already
 * registered. Its siblings `./download`, `../borang-a/file` and `../borang-8a/file` are the precedents.
 *
 * ── GATED `scopedAdmin`, NEVER `isAdmin` ─────────────────────────────────────────────────────────
 * An `hr_admin` grant on ANY company makes `isAdmin` true. This list names a particular company's payroll
 * runs and the cycle names its administrator configured, so it is fenced to the companies this caller
 * actually administers — the same rule `./pack-file` and both `shared.ts` loaders apply, and for the same
 * reason. An out-of-scope company answers the SAME empty list as a month with no completed runs, so the
 * parameter cannot be used to find out which companies exist.
 *
 * ── AND IT REACHES PAYROLL THROUGH THE FACADE ────────────────────────────────────────────────────
 * `packs/payroll/service`, never `core/payroll-view` — ADR-0080 D9, enforced by
 * test/payroll-pack-drift.test.ts, whose allowlist only ever shrinks. The eligibility rule itself
 * (processed or closed, and it actually paid somebody) lives in the pack beside the runs, so this handler
 * holds no opinion about which runs are filable and cannot drift from the download that follows.
 *
 * NOTHING IS WRITTEN. A GET that lists runs records no artefact and appends no domain event, exactly like
 * the download beside it — see the registry header for why generating a file must write nothing.
 */
import { scopedAdmin } from '@/lib/scope';
import { listFilableRunsForPeriod } from '@/packs/payroll/service';

export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/** One run, as the pop-up needs it. The LABEL is composed on the client, from `cycleName` + `runType`. */
export type FilableRunResponse = {
  runs: { runSeq: number; runType: string; cycleName: string | null; status: string }[];
};

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const companyId = q.get('companyId') ?? '';
  const periodKey = q.get('periodKey') ?? '';
  // A malformed parameter answers an EMPTY LIST, not a 400. The pop-up's only sensible response to either
  // is the same one — "this month has no completed payroll run" — and a distinguishable error would let a
  // caller probe which ids are well formed. Nothing is produced from this list without the download route
  // validating the same values again.
  if (!UUID.test(companyId) || !PERIOD.test(periodKey)) {
    return Response.json({ runs: [] } satisfies FilableRunResponse, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  const { s, scopeIds } = await scopedAdmin();
  const runs = await listFilableRunsForPeriod(s, { companyIds: scopeIds, companyId, periodKey });

  return Response.json({ runs } satisfies FilableRunResponse, {
    // `no-store`: the list changes the moment a payroll run is processed, and it names a company's runs.
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
