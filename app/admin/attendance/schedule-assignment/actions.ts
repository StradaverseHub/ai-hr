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
  ShiftArrangementOnlyPeriodError,
  ShiftBackInsertError,
  ShiftEffectiveBeforeStartError,
} from '@/core/shift-arrangement';

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

/** The service's refusal, in the reader's language. Unknown errors keep their own message. */
async function messageFor(e: unknown): Promise<string> {
  const td = await getTranslations('people.detail');
  if (e instanceof ShiftBackInsertError) return td('shiftBackInsertRefused', { date: e.lastEffectiveFrom });
  if (e instanceof ShiftEffectiveBeforeStartError) return td('shiftEffectiveBeforeStart', { date: e.startDate });
  if (e instanceof InvalidEffectiveDateError) return td('shiftEffectiveDateInvalid');
  const ts = await getTranslations('admin.scheduleAssignment');
  if (e instanceof ShiftArrangementOnlyPeriodError) return ts('removeOnlyRefused');
  if (e instanceof ShiftArrangementNotFoundError) return ts('removeNotFound');
  return (e as Error).message;
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
 * REMOVE one dated arrangement from the employee's ladder. The service supersedes the period and re-opens
 * its predecessor; it refuses to remove the last one on file, because an employee with no dated period falls
 * back to the cache this ladder replaced.
 */
export async function removeScheduleArrangementAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId') ?? '').trim();
  const arrangementId = String(formData.get('arrangementId') ?? '').trim();
  try {
    await removeShiftArrangement(s, { employmentId, arrangementId });
  } catch (e) {
    redirect(backTo(formData, { error: await messageFor(e) }));
  }
  revalidatePath(PAGE);
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(backTo(formData, { removed: '1' }));
}
