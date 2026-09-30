/**
 * 0d02d4a1 — HOW A COUNTRY-NEUTRAL SHELF REACHES A COUNTRY-SPECIFIC STATUTORY FILE.
 *
 * ── WHAT THIS REPLACES, AND WHY THE ROW WAS DARK FOR A ROUND ──────────────────────────────────────
 * The e-Data PCB row on Payment Submission shipped as `available: false` for exactly one reason: the file's
 * writer lives inside a country pack, this directory is generic, and the drift ratchet
 * (test/country-pack-drift.test.ts, ADR-0080 D1/D7) refuses generic code any direct reach into a pack —
 * correctly, and its allowlist only ever shrinks. So the screen said "not available" while
 * `/payroll/reports/*` handed over the identical file one menu row away, which is the r296 defect
 * (readiness 3.1) in slow motion: two surfaces disagreeing about one capability.
 *
 * This module is the missing door. `CountryPack.paymentFiles` is a DECLARED member of the pack contract
 * (ADR-0080 D6), resolved here through `packFor()` — the one seam the ratchet exists to funnel everything
 * into. Nothing under `app/` names a pack, the allowlist neither grew nor was consulted, and the next
 * country's file needs no exception either: it declares the member and its row lights up.
 *
 * ⚠️ IT IS ONE READ, NOT A SECOND ONE, AND THAT IS THE MONEY-SAFE PART. The pack's builder is an adapter
 * over the very function the shipped report route calls, so this shelf and that route cannot emit different
 * bytes for one employer's month. The tempting alternative — a generic read of the same figures assembled
 * above a pure builder — would have put a SECOND set of numbers behind one government file, which is
 * precisely what r296 spent a round removing after two writers were found disagreeing about one month.
 *
 * ── FAILS CLOSED, AND ANSWERS ONE BARE 404 FOR EVERY WAY OF BEING REFUSED ─────────────────────────
 * A malformed id, a period that is not YYYY-MM, a company this admin does not administer, a company with no
 * country on file, and a jurisdiction whose pack does not produce this file ALL answer `404 Not found` —
 * the rule `loadBorangA` (app/payroll/borang-a/shared.ts) already sets, so a guessed parameter cannot be
 * used to enumerate companies or capabilities.
 *
 * `scopedAdmin`, NEVER `isAdmin`: an `hr_admin` grant on ANY company makes `isAdmin` true, and these files
 * carry every employee's name, identity number and deductions. (The shipped report route gates on `isAdmin`
 * and is saved by RLS alone — audited, not a hole, and not a pattern to copy.)
 *
 * READINESS IS THE PACK'S ANSWER, NOT THIS FILE'S OPINION. An operator-fixable refusal comes back as
 * `{ ok: false, reason }` already phrased in the operator's words and is returned as a 422 verbatim; a real
 * bug propagates as a thrown error, because a 422 saying "fix your data" about a driver fault sends someone
 * to correct records that are perfectly correct.
 */
import { eq } from 'drizzle-orm';
import { withTenant } from '@/db/client';
import { company } from '@/db/schema';
import { packFor } from '@/localization/registry';
import { scopedAdmin } from '@/lib/scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The same shape `loadBorangAFile` returns, so a registry builder handles both identically. */
export type PackFileLoad =
  | { ok: true; filename: string; bytes: string; contentType: string }
  | { ok: false; status: number; message: string };

/**
 * One month's statutory upload file for one employer, from that employer's own jurisdiction pack.
 *
 * `fileKey` is the format id the registry entry declares. It is a string crossing the pack seam — the same
 * way a report catalog id already does — and a test pins both sides of it, so a rename on either side fails
 * loudly instead of quietly taking a download away from the screen.
 */
export async function loadPackPaymentFile(p: {
  companyId: string;
  periodKey: string;
  fileKey: string;
  /**
   * r372 (item f022dd70) — the payroll runs of that month the operator ticked, or ABSENT for all of them.
   * Passed straight to the pack's builder; nothing here interprets it, and a pack that ignores it keeps
   * producing the whole month. Validating it is the CALLER'S job and is done once, in
   * `lib/payroll-run-selection.ts`, so the three formats cannot disagree about what a bad value means.
   */
  runSeqs?: number[];
}): Promise<PackFileLoad> {
  const notFound = { ok: false, status: 404, message: 'Not found' } as const;
  if (!UUID.test(p.companyId) || !PERIOD.test(p.periodKey)) return notFound;

  const { s, scopeIds } = await scopedAdmin();
  if (!scopeIds.includes(p.companyId)) return notFound;

  // The EMPLOYER'S jurisdiction, read from the employer — never assumed, and never taken from the acting
  // user. `core/reporting.ts` resolves an EA form's pack exactly this way and for the same reason: a file
  // is one company's filing, and rendering it under another jurisdiction's rules is a silent wrong answer.
  const country = await withTenant(s, async (tx) => {
    const [co] = await tx
      .select({ country: company.country })
      .from(company)
      .where(eq(company.id, p.companyId))
      .limit(1);
    return co?.country ?? null;
  });
  if (!country) return notFound;

  // `packFor`, not `requirePackFor`: a company in a jurisdiction we have no pack for has no file to offer,
  // which is a 404 and not a 500. The same bare answer as an out-of-scope company, so the URL does not
  // reveal which countries this deployment can file for.
  const build = packFor(country)?.paymentFiles?.[p.fileKey];
  if (!build) return notFound;

  const file = await build(s, { companyId: p.companyId, periodKey: p.periodKey, runSeqs: p.runSeqs });
  // The pack's own refusal, in the operator's words, as a 422. Never a partial or patched file: a
  // fixed-width record has no way to say "this value did not fit".
  if (!file.ok) return { ok: false, status: 422, message: file.reason };
  return { ok: true, filename: file.filename, bytes: file.content, contentType: file.contentType };
}
