'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { rosterFormCopyTargets, rosterFormGenerationTargets } from './command-targets';
import {
  assertRosterAdmin,
  assertRosterDatesWritable,
  assignRosterRow,
  assignShift,
  assignShiftBulk,
  clearRoster,
  RosterAdminRequiredError,
  setRestDay,
} from '@/core/roster';
import { enqueueRosterAssignJob, enqueueRosterCopyJob, enqueueRosterGenerateJob, RosterBulkJobError } from '@/core/roster-bulk-job';
import { ROSTER_BRUSH_INLINE_CELLS, ROSTER_BULK_ALREADY_RUNNING, rosterReadableError } from '@/lib/roster-bulk-job';
import { accrueToil, ToilFirstScheduleConsentRequiredError } from '@/core/toil';

export type CellResult = { ok: true } | { ok: false; error: string };

/**
 * 23390097 BLOCKER — NOTHING IN THIS FILE MAY PRINT THE DATABASE'S OWN WORDS.
 *
 * Every roster write action reports failure by handing `(e as Error).message` to the caller: the three
 * cell actions return it for `toast.error`, and Generate / Copy encode it into `?error=`, which
 * app/roster/page.tsx renders in ErrorBanner. drizzle wraps a driver failure as
 * `Failed query: insert into "roster_assignment" … params: <tenant uuid>,<employment uuid>,…`, so a
 * refused write printed the statement and the identifiers straight onto an HR screen.
 *
 * `assertRosterAdmin` (below, first line of all five actions) closes the case that made this reachable
 * for anyone who is not an administrator. This is the backstop for every OTHER way the driver can
 * refuse — a company-scoped hr_admin reaching across companies, a constraint, a lost connection — where
 * the write genuinely fails and the message still must not be raw SQL.
 *
 * Same shape as core/location.ts's typed errors and the RAW_SQL negative in test/location-branch.ts:
 * an error we RAISED speaks for itself and passes through; anything that smells of the driver is
 * replaced. It never swallows a refusal — the action still reports failure — only its wording.
 */
// The driver-text check itself lives in lib/roster-bulk-job.ts (rosterReadableError), shared with the background
// roster worker so a job's stored refusal is the same sentence this file would have shown.
function readableError(e: unknown): string {
  const message = e instanceof Error ? e.message : '';
  return rosterReadableError(message);
}
/** A roster bulk job refused at admission because the tenant already runs one: said in the reader's language. */
async function admissionError(e: unknown): Promise<string> {
  if (e instanceof RosterBulkJobError && e.message === ROSTER_BULK_ALREADY_RUNNING) return (await getTranslations('bulkJobs.roster'))('otherRunning');
  return readableError(e);
}

export type AccrueToilResult =
  | { ok: true; daysCredited: number; warning?: string; premiumEquivalentWarning?: string }
  // Phase-B #14: a First-Schedule election refused for want of per-election consent — the UI prompts for the
  // employee's agreement and retries with firstScheduleConsent:true.
  | { ok: false; needsConsent: true }
  | { ok: false; error: string };

/** ADR-0033 — bank a worked rest day as time in lieu from the roster variance card. Phase-B #14: a
 *  First-Schedule (≤ RM4,000) election requires explicit per-election consent (`firstScheduleConsent`); the
 *  service refuses without it so the UI can prompt for the employee's agreement before retrying. */
export async function accrueToilAction(input: {
  employmentId: string;
  workedDate: string;
  firstScheduleConsent?: boolean;
}): Promise<AccrueToilResult> {
  const s = await getSession();
  try {
    const r = await accrueToil(s, input);
    revalidatePath('/roster');
    return {
      ok: true,
      daysCredited: r.daysCredited,
      warning: r.complianceWarning,
      premiumEquivalentWarning: r.premiumEquivalentWarning,
    };
  } catch (e) {
    if (e instanceof ToilFirstScheduleConsentRequiredError) return { ok: false, needsConsent: true };
    // Same treatment as its neighbours: this message is toasted too, and the file's rule is that none of
    // them may be the driver's. No GATING is added here — who may bank a rest day in lieu is TOIL's
    // question, not the roster's, and answering it in this file would be a different change.
    return { ok: false, error: readableError(e) };
  }
}

/** Apply a "brush" to one (employee, date) cell of the roster grid: a shift id, 'rest', or 'clear'.
 *  Returns the outcome to the client island (no navigation).
 *
 *  23390097 — BOTH rights are re-checked here, in order: may this session write the roster at all
 *  (`assertRosterAdmin`), then may it write this date (`assertRosterDatesWritable`). The grid renders a
 *  supervisor a read-only month and disables past cells for everyone else, but a missing button is an
 *  affordance, not a guard — this action id ships in the supervisor's own bundle and is a POST endpoint. */
export async function assignCellAction(input: { employmentId: string; shiftDate: string; brush: string }): Promise<CellResult> {
  const s = await getSession();
  const { employmentId, shiftDate, brush } = input;
  try {
    assertRosterAdmin(s);
    assertRosterDatesWritable(s, [shiftDate]);
    if (brush === 'rest') await setRestDay(s, { employmentId, shiftDate });
    else if (brush === 'clear') await clearRoster(s, { employmentId, shiftDate });
    else await assignShift(s, { employmentId, shiftDate, shiftId: brush });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: readableError(e) };
  }
}

export type BulkAssignResult = { ok: true; jobId?: string } | { ok: false; error: string };

/** Bulk-apply a brush to many employees across a date range (the roster-grid bulk bar).
 *  Administrators only, re-checked here — see assignCellAction.
 *
 *  A SMALL brush (at most ROSTER_BRUSH_INLINE_CELLS employee-days) is written here, inline, exactly as before: one
 *  short transaction for a shift brush, one per cell for rest and clear, no job and no notice. A larger brush runs as
 *  a background roster job (core/roster-bulk-worker.ts): one employee's rows per step in short transactions, the same
 *  writers and events, and the same all-or-nothing refusal for a shift brush. The grid waits for the job
 *  (components/roster-grid.tsx) and reports its outcome exactly as it reported this action's. */
export async function bulkAssignAction(input: {
  employmentIds: string[];
  shiftDates: string[];
  brush: string;
  companyId?: string | null;
  operationKey?: string;
}): Promise<BulkAssignResult> {
  const s = await getSession();
  if (input.employmentIds.length * input.shiftDates.length > ROSTER_BRUSH_INLINE_CELLS) {
    try {
      const job = await enqueueRosterAssignJob(s, input);
      return { ok: true, jobId: job.id };
    } catch (e) {
      return { ok: false, error: await admissionError(e) };
    }
  }
  try {
    assertRosterAdmin(s);
    assertRosterDatesWritable(s, input.shiftDates);
    if (input.brush === 'clear') {
      for (const employmentId of input.employmentIds) {
        for (const shiftDate of input.shiftDates) await clearRoster(s, { employmentId, shiftDate });
      }
    } else if (input.brush === 'rest') {
      for (const employmentId of input.employmentIds) {
        for (const shiftDate of input.shiftDates) await setRestDay(s, { employmentId, shiftDate });
      }
    } else {
      await assignShiftBulk(s, { employmentIds: input.employmentIds, shiftDates: input.shiftDates, shiftId: input.brush });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: readableError(e) };
  }
}

/**
 * 23390097 — the row Edit panel: ONE employee, several ticked dates, one shift.
 *
 * It routes through assignRosterRow, NOT bulkAssignAction. The bulk primitives write a single summary
 * event with a shift id and counts — no per-date row and no previous shift — and requirement 10 asks the
 * Audit Trail for exactly those. One employee × at most 31 dates is bounded, so the per-date events the
 * bulk path exists to avoid are affordable here. assignRosterRow re-checks BOTH rights itself — the
 * administrator right and the past-date right — and this action asserts the first one again so that the
 * refusal is decided in the same place as its two siblings, whatever the core entry point does.
 */
export async function rowAssignAction(input: {
  employmentId: string;
  shiftDates: string[];
  brush: string;
}): Promise<CellResult> {
  const s = await getSession();
  try {
    assertRosterAdmin(s);
    await assignRosterRow(s, input);
    revalidatePath('/roster');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: readableError(e) };
  }
}

/**
 * a57f0584 rev 2 — SAVE, from the per-employee Edit SCREEN.
 *
 * The row editor used to be a panel at the foot of /roster that called `rowAssignAction` from the client
 * and patched the grid optimistically. It is now a page of its own, so the save is a FORM POST that
 * redirects back to the roster (the "own page, return to the list" shape of the TP1 declaration form and
 * app/admin/attendance/schedule-assignment/[employmentId]). Nothing about WHO may write or WHAT is
 * written changes: this is a thin wrapper over `rowAssignAction`, which is still the only entry point and
 * still re-checks the administrator right and the past-date right through `assignRosterRow`.
 *
 * A REFUSAL COMES BACK TO THE EDIT SCREEN, not to the roster, and carries the reason plus what was
 * ticked — the administrator does not re-tick eleven dates because the save was refused. Same contract as
 * shift-actions.ts's errTarget.
 */
export async function saveRosterRowAction(formData: FormData) {
  const employmentId = String(formData.get('employmentId') ?? '');
  const brush = String(formData.get('brush') ?? '');
  const shiftDates = formData.getAll('shiftDates').map(String).filter(Boolean);
  // The roster's own query string (month + filters), round-tripped so both ways out land where the
  // administrator was. Parsed through URLSearchParams rather than concatenated: it arrives from a form
  // field and ends up in a Location header.
  const listQuery = new URLSearchParams(String(formData.get('listQuery') ?? ''));
  const editQuery = new URLSearchParams(listQuery);

  // Outside the try on purpose: redirect() signals by throwing, and a catch here would swallow it.
  if (shiftDates.length === 0) {
    editQuery.set('error', 'noDates');
    redirect(`/roster/edit/${employmentId}?${editQuery.toString()}`);
  }
  const r = await rowAssignAction({ employmentId, shiftDates, brush });
  if (!r.ok) {
    editQuery.set('error', r.error);
    for (const d of shiftDates) editQuery.append('picked', d);
    editQuery.set('brush', brush);
    redirect(`/roster/edit/${employmentId}?${editQuery.toString()}`);
  }
  listQuery.set('rowSaved', String(shiftDates.length));
  redirect(`/roster?${listQuery.toString()}`);
}

/** R7 Phase 2 — generate a roster window from a shift's weekly pattern: shift + scope (explicit employees
 *  or a whole department; department wins when both are posted) + date range → the thin generator over the
 *  existing bulk primitives. Success redirects to the window's first week with a summary banner.
 *
 *  ADMINISTRATORS ONLY, refused HERE and not merely hidden. app/roster/page.tsx renders this form only for
 *  an admin, but a form action is a POST endpoint like any other; without this line a supervisor's POST
 *  reached the generator, was refused by RLS, and the raw `Failed query: insert into "roster_assignment"
 *  … params: …` came back in `?error=` and was rendered in ErrorBanner. */
export async function generateRosterAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const from = String(formData.get('from') ?? '');
  // Outside the try on purpose: redirect() signals by throwing, and a catch here would swallow it.
  if (!isAdmin(s)) redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent(new RosterAdminRequiredError().message)}`);
  let jobId: string;
  try {
    // Server-side admission of the posted targets (company write scope, fresh team scope, permitted
    // population) before the job is queued; a department still wins over the employee selection. The
    // generator itself runs in the background roster job, and the page shows its progress; when it ends the
    // page opens the same summary banner (or error) this action used to redirect to.
    const targets = await rosterFormGenerationTargets(s, formData);
    jobId = (await enqueueRosterGenerateJob(s, {
      companyId,
      input: { shiftId: String(formData.get('shiftId') ?? ''), ...targets, from, to: String(formData.get('to') ?? '') },
    })).id;
  } catch (e) {
    redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent(await admissionError(e))}`);
  }
  revalidatePath('/roster');
  redirect(`/roster?companyId=${companyId}&month=${from.slice(0, 7)}&rosterJob=${jobId}`);
}

/** R17 3e8350db — "Copy roster schedules from previous weeks or months". Copies every roster row from a
 *  source window forward onto a target window that starts at `targetFrom`, preserving each row's day-offset.
 *  Scope is the whole company's active employees (posted as employmentIds) so a manager copies exactly the
 *  team they see on the grid; RLS still gates each write. Success lands on the target week with a banner.
 *
 *  ADMINISTRATORS ONLY, refused here, for the same reason as generateRosterAction above. */
export async function copyRosterAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const targetFrom = String(formData.get('targetFrom') ?? '');
  if (!isAdmin(s)) redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent(new RosterAdminRequiredError().message)}`);
  let jobId: string;
  try {
    // Every posted employee is admitted against the current scope; an empty post is bounded to it. The copy
    // runs in the background roster job; the page shows its progress, then the same banner as before.
    const employmentIds = await rosterFormCopyTargets(s, formData);
    jobId = (await enqueueRosterCopyJob(s, {
      companyId,
      sourceFrom: String(formData.get('sourceFrom') ?? ''),
      sourceTo: String(formData.get('sourceTo') ?? ''),
      targetFrom,
      employmentIds,
    })).id;
  } catch (e) {
    redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent(await admissionError(e))}`);
  }
  revalidatePath('/roster');
  redirect(`/roster?companyId=${companyId}&month=${targetFrom.slice(0, 7)}&rosterJob=${jobId}`);
}
