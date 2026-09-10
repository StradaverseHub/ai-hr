'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import {
  assignEmployeeShiftDated,
  removeShiftArrangement,
  InvalidEffectiveDateError,
  ShiftArrangementNotFoundError,
  ShiftArrangementNotNewestError,
  ShiftArrangementOnlyPeriodError,
  ShiftBackInsertError,
  ShiftEffectiveBeforeStartError,
} from '@/core/shift-arrangement';
import { ArchivedShiftError, BackupShiftRequiredError, ShiftHasNoWorkingPatternError } from '@/core/roster';

/**
 * a485afa1 — the Schedule Assignment screen's own Save and Remove.
 *
 * ⚠️ THESE ARE ADAPTERS, NOT WRITERS, AND THE DISTINCTION IS THE ITEM. The reporter was promised that the
 * Attendance screen and the personnel card "cannot drift apart" because they are two doors onto ONE record.
 * That is true only while there is one writer, so every byte that decides WHAT is stored — the effective
 * dating, the supersede-vs-close rule, the archived-shift and working-pattern refusals, the employment cache
 * and the DomainEvent — stays in core/shift-arrangement.ts, called here with the identical argument shape
 * app/admin/personnel/[employmentId]/actions.ts setDefaultShiftAction uses. What lives in this file is only
 * what a form needs and a service must not know: which URL to come back to, and which sentence to show.
 *
 * WHY NOT SIMPLY CALL setDefaultShiftAction. It redirects to `/admin/personnel/<id>` on both paths, which is
 * the trip this item exists to remove — an administrator saving from the Attendance list would be thrown into
 * Personnel Management by the save itself. The personnel action is otherwise untouched: that card keeps its
 * copy (the reporter asked for a second entry point, not for the first to be taken away).
 *
 * The three date refusals are localized here for the same reason they are localized there: core throws in
 * English for the log, and the screen speaks the user's language. `date` is always passed — an ICU
 * placeholder called without its argument throws at render.
 */

const PAGE = '/admin/attendance/schedule-assignment';

/**
 * `employmentId` and `arrangementId` ARE POSTED FIELDS AND SO ARE UNTRUSTED, and both address uuid
 * columns. A malformed one is not a database question — it is a bad field on a form — so it is refused
 * here, by shape, before any query is built. Two things go wrong without this: the value reaches
 * `eq(employment.id, …)` and Postgres throws, and what it throws carries the STATEMENT and its bound
 * parameters in `message`, which `messageFor` would then print in the error banner. See `messageFor`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Back to the list the administrator was actually looking at — same filters, same open panel — with the
 * outcome of this save on it.
 *
 * `returnTo` IS A POSTED FIELD AND SO IS UNTRUSTED. It is accepted only when it IS this page or begins
 * `<this page>?`, and anything else falls back to the bare page: a form field that can name any URL is an
 * open redirect, and this one is submitted by an admin session. The three outcome params are cleared before
 * the new one is set so a second save cannot land on a page still showing the first one's error.
 */
function backTo(formData: FormData, outcome: Record<string, string>): string {
  const raw = String(formData.get('returnTo') ?? '');
  const safe = raw === PAGE || raw.startsWith(`${PAGE}?`) ? raw : PAGE;
  const [pathname, query = ''] = safe.split('#')[0].split('?');
  const params = new URLSearchParams(query);
  for (const stale of ['error', 'saved', 'removed']) params.delete(stale);
  for (const [k, v] of Object.entries(outcome)) params.set(k, v);
  const qs = params.toString();
  return `${pathname}${qs ? `?${qs}` : ''}#assign-panel`;
}

/** A bad field on the posted form, in the reader's language — no query was attempted. */
async function badField(key: 'badEmployment' | 'removeNotFound'): Promise<string> {
  const ts = await getTranslations('admin.scheduleAssignment');
  return ts(key);
}

/**
 * The service's refusal, in the reader's language.
 *
 * ⚠️ THE FALLTHROUGH IS NOT `e.message`, AND THAT IS DELIBERATE. A Drizzle/Postgres failure puts the whole
 * statement in its message — "Failed query: select "id", "hired_on", … from "employment" where … params:
 * junk,1" — and this string is put in the URL and rendered by ErrorBanner. Echoing a table's column list
 * and someone's bound parameters onto an HR screen is not something an admin session should be able to
 * ask for, so a database failure gets one flat sentence and the detail stays in the server log, where the
 * error is still thrown and still captured. The domain refusals ABOVE this line are the ones with
 * something to say to the user, and each is mapped by class.
 *
 * (The personnel card's setDefaultShiftAction still has the raw fallthrough. Fixed at the NEW door only:
 * that file belongs to another round this cycle and the scope fence forbids touching it. Whoever next
 * owns app/admin/personnel/[employmentId]/actions.ts should copy this.)
 */
async function messageFor(e: unknown): Promise<string> {
  const td = await getTranslations('people.detail');
  if (e instanceof ShiftBackInsertError) return td('shiftBackInsertRefused', { date: e.lastEffectiveFrom });
  if (e instanceof ShiftEffectiveBeforeStartError) return td('shiftEffectiveBeforeStart', { date: e.startDate });
  if (e instanceof InvalidEffectiveDateError) return td('shiftEffectiveDateInvalid');
  const ts = await getTranslations('admin.scheduleAssignment');
  if (e instanceof ShiftArrangementOnlyPeriodError) return ts('removeOnlyRefused');
  if (e instanceof ShiftArrangementNotFoundError) return ts('removeNotFound');
  if (e instanceof ShiftArrangementNotNewestError) {
    return ts('removeNotNewestRefused', { date: e.newestEffectiveFrom });
  }
  // The three refusals the writer raises from core/roster.ts are written for a person and are shown as
  // they are, exactly as the personnel card shows them. Named one by one ON PURPOSE: a whitelist cannot
  // be walked through by a class nobody thought about, which is how the SQL got on screen in the first
  // place.
  if (
    e instanceof ArchivedShiftError ||
    e instanceof BackupShiftRequiredError ||
    e instanceof ShiftHasNoWorkingPatternError
  ) {
    return e.message;
  }
  return ts('unexpectedError');
}

/**
 * ADD or CHANGE the employee's shift arrangement from the Attendance list. Parsed exactly as the personnel
 * card parses it, including the `rawType === 'fixed' ? 'fixed' : 'roster'` default and the blank-to-null
 * coercions, so the same form posted at either door produces the same call.
 */
export async function saveScheduleAssignmentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId') ?? '').trim();
  const rawType = String(formData.get('shiftType') ?? '').trim();
  const shiftType: 'fixed' | 'roster' = rawType === 'fixed' ? 'fixed' : 'roster';
  const rawShift = String(formData.get('shiftId') ?? '').trim();
  const rawEffective = String(formData.get('effectiveFrom') ?? '').trim();
  if (!UUID_RE.test(employmentId)) {
    redirect(backTo(formData, { error: await badField('badEmployment') }));
  }
  try {
    await assignEmployeeShiftDated(s, {
      employmentId,
      shiftType,
      shiftId: rawShift || null,
      effectiveFrom: rawEffective || null,
    });
  } catch (e) {
    redirect(backTo(formData, { error: await messageFor(e) }));
  }
  revalidatePath(PAGE);
  // The other door onto the same record: its cached page would otherwise still show the old arrangement.
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(backTo(formData, { saved: '1' }));
}

/**
 * TAKE BACK THE MOST RECENT change to the employee's ladder. The service supersedes that period and
 * re-opens its predecessor. It refuses three things: an entry not on this employee's live ladder, the last
 * one on file (an employee with no dated period falls back to the cache this ladder replaced), and — the
 * one to read before widening this — any entry that is NOT the newest, because re-saving it is the only
 * way to undo a removal and the writer will not accept a date earlier than the ladder's last. See
 * core/shift-arrangement.ts ShiftArrangementNotNewestError.
 */
export async function removeScheduleArrangementAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId') ?? '').trim();
  const arrangementId = String(formData.get('arrangementId') ?? '').trim();
  if (!UUID_RE.test(employmentId)) {
    redirect(backTo(formData, { error: await badField('badEmployment') }));
  }
  // A malformed arrangement id never reaches SQL (the ladder is matched in JS), but it can only have come
  // from a forged form, and "no longer on file" is the same true sentence the service would give.
  if (!UUID_RE.test(arrangementId)) {
    redirect(backTo(formData, { error: await badField('removeNotFound') }));
  }
  try {
    await removeShiftArrangement(s, { employmentId, arrangementId });
  } catch (e) {
    redirect(backTo(formData, { error: await messageFor(e) }));
  }
  revalidatePath(PAGE);
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(backTo(formData, { removed: '1' }));
}
