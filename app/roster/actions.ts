'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import {
  assertRosterAdmin,
  assertRosterDatesWritable,
  assignRosterRow,
  assignShift,
  assignShiftBulk,
  clearRoster,
  copyRoster,
  generateRosterFromTemplate,
  RosterAdminRequiredError,
  setRestDay,
} from '@/core/roster';
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
const RAW_DRIVER_TEXT = /failed query|\bparams:|insert into\b|update\s+"|delete from\b/i;
const ROSTER_WRITE_FAILED = 'The roster change could not be saved. Please try again, or ask an HR administrator.';

function readableError(e: unknown): string {
  const message = e instanceof Error ? e.message : '';
  return message.trim() === '' || RAW_DRIVER_TEXT.test(message) ? ROSTER_WRITE_FAILED : message;
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

/** Bulk-apply a brush to many employees across a date range (the roster-grid bulk bar).
 *  Administrators only, re-checked here — see assignCellAction. */
export async function bulkAssignAction(input: {
  employmentIds: string[];
  shiftDates: string[];
  brush: string;
}): Promise<CellResult> {
  const s = await getSession();
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
  const departmentId = String(formData.get('departmentId') ?? '').trim();
  const employmentIds = formData.getAll('employmentIds').map(String).filter(Boolean);
  // Outside the try on purpose: redirect() signals by throwing, and a catch here would swallow it.
  if (!isAdmin(s)) redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent(new RosterAdminRequiredError().message)}`);
  let summary: { employments: number; workingRows: number; restRows: number };
  try {
    summary = await generateRosterFromTemplate(s, {
      shiftId: String(formData.get('shiftId') ?? ''),
      ...(departmentId ? { departmentId } : { employmentIds }),
      from,
      to: String(formData.get('to') ?? ''),
    });
  } catch (e) {
    redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent(readableError(e))}`);
  }
  revalidatePath('/roster');
  redirect(
    `/roster?companyId=${companyId}&month=${from.slice(0, 7)}&generated=${summary.employments}.${summary.workingRows}.${summary.restRows}`,
  );
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
  const employmentIds = formData.getAll('employmentIds').map(String).filter(Boolean);
  if (!isAdmin(s)) redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent(new RosterAdminRequiredError().message)}`);
  let summary: { copied: number; sourceRows: number };
  try {
    summary = await copyRoster(s, {
      sourceFrom: String(formData.get('sourceFrom') ?? ''),
      sourceTo: String(formData.get('sourceTo') ?? ''),
      targetFrom,
      ...(employmentIds.length > 0 ? { employmentIds } : {}),
    });
  } catch (e) {
    redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent(readableError(e))}`);
  }
  revalidatePath('/roster');
  redirect(`/roster?companyId=${companyId}&month=${targetFrom.slice(0, 7)}&copied=${summary.copied}`);
}
