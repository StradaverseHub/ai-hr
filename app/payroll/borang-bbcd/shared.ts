/**
 * r411 (item 4f45f9b0) — what the BBCD preview and its PDF route both have to do, in one place.
 *
 * ⚠️ THERE IS NO BBCD READ. Both call `loadBorangA` — the very loader the Borang A screen, its PDF, its text
 * copy and its i-Akaun file call — with the same company, payroll month and `run` selection, and then
 * project the built form (`borangBbcdFrom`). So the BBCD's Amaun Caruman IS that Borang A's total, and the
 * two documents refuse the same requests the same way: a bad company or period (404), no payroll run
 * (`no-batch`), a selection that names no run of the month or is malformed, nothing to file
 * (`no-contributions`), and a Borang A that cannot be filed yet (`not-ready` — a BBCD is the cover for that
 * Borang A's payment, and a cover for a form nobody can download would certify a filing that cannot exist).
 *
 * The SIGNATORY is not a refusal: `signatoryMissing` is a readiness note shown before the download, and the
 * form prints the lines empty.
 */
import { borangBbcdFrom, missingBbcdSignatory, type BbcdSignatoryField, type BorangBbcdForm } from '@/lib/borang-bbcd';
import { loadBorangA, type BorangALoad } from '../borang-a/shared';

/** The catalog id the BBCD criteria step is addressed by. */
export const BORANG_BBCD_REPORT_ID = 'my.borang-bbcd';

export type BorangBbcdLoad =
  | Exclude<BorangALoad, { ok: true }>
  | (Extract<BorangALoad, { ok: true }> & { bbcd: BorangBbcdForm; signatoryMissing: BbcdSignatoryField[] });

export async function loadBorangBbcd(p: {
  companyId: string;
  periodKey: string;
  query: URLSearchParams;
  includeIncomplete?: boolean;
}): Promise<BorangBbcdLoad> {
  const loaded = await loadBorangA(p);
  if (!loaded.ok) return loaded;
  const bbcd = borangBbcdFrom(loaded.form);
  return { ...loaded, bbcd, signatoryMissing: missingBbcdSignatory(bbcd) };
}
