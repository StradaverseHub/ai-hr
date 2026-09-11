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
 * a485afa1 — the Schedule Assignment screens' own Save and Remove (posted from ./[employmentId]/page.tsx
 * since r265; from the inline panel on the list before that).
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

/** The detail page's own URL: PAGE/<uuid>, optionally with the list's filters as a query. */
const DETAIL_RE = /^\/admin\/attendance\/schedule-assignment\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\?|$)/i;
/** The only query keys carried from one screen to the other: the list's four filters. */
const FILTER_KEYS = ['q', 'shiftType', 'shiftId', 'status'] as const;

/**
 * WHERE EACH OUTCOME LANDS (a485afa1 rev 2, r265 — the shift library's shift-actions.ts idiom: success
 * back to the list, a refusal back onto the form the operator filled in, so nothing typed is lost):
 *
 *   save succeeded  → the LIST, same filters, `focus=<id>` and the `#row-<id>` fragment, `saved=1` —
 *                     the administrator lands on the row they just changed, highlighted, not at the top.
 *   save refused    → the DETAIL page, same filters, `error=<reason>` — the reason sits beside the fields.
 *   remove succeeded → the DETAIL page, `removed=1` — they are looking at the history they just changed.
 *   remove refused  → the DETAIL page, `error=<reason>`.
 *   a malformed employmentId → the LIST with `error=`: there is no detail page for an id that is not one.
 *
 * `returnTo` IS A POSTED FIELD AND SO IS UNTRUSTED. Only its QUERY is read, and only when its path IS
 * this list or this list's detail page (PAGE, PAGE?…, PAGE/<uuid>, PAGE/<uuid>?…); anything else — an
 * off-site URL, another screen — contributes nothing and the outcome lands on the bare list or the bare
 * detail page. The pathname is never taken from the field: a form field that can name any URL is an open
 * redirect, and this one is submitted by an admin session. Of the query, only the four filter keys are
 * kept, which also strips the previous outcome (error / saved / removed / focus) so a second save cannot
 * land on a page still showing the first one's error.
 */
function backTo(
  formData: FormData,
  target: { list: true; employmentId: string | null } | { list: false; employmentId: string },
  outcome: Record<string, string>,
): string {
  const raw = String(formData.get('returnTo') ?? '');
  const trusted = raw === PAGE || raw.startsWith(`${PAGE}?`) || DETAIL_RE.test(raw);
  const query = trusted ? (raw.split('#')[0].split('?')[1] ?? '') : '';
  const posted = new URLSearchParams(query);
  const params = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = posted.get(k);
    if (v) params.set(k, v);
  }
  if (target.list && target.employmentId) params.set('focus', target.employmentId);
  for (const [k, v] of Object.entries(outcome)) params.set(k, v);
  const qs = params.toString();
  const pathname = target.list ? PAGE : `${PAGE}/${target.employmentId}`;
  const fragment = target.list && target.employmentId ? `#row-${target.employmentId}` : '';
  return `${pathname}${qs ? `?${qs}` : ''}${fragment}`;
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

/** Both doors onto the record, and the list, are re-read after a write. */
function revalidateBothDoors(employmentId: string) {
  revalidatePath(PAGE);
  revalidatePath(`${PAGE}/${employmentId}`);
  // The other door onto the same record: its cached page would otherwise still show the old arrangement.
  revalidatePath(`/admin/personnel/${employmentId}`);
}

/**
 * ADD or CHANGE the employee's shift arrangement from the Attendance screens. Parsed exactly as the
 * personnel card parses it, including the `rawType === 'fixed' ? 'fixed' : 'roster'` default and the
 * blank-to-null coercions, so the same form posted at either door produces the same call.
 */
export async function saveScheduleAssignmentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId') ?? '').trim();
  const rawType = String(formData.get('shiftType') ?? '').trim();
  const shiftType: 'fixed' | 'roster' = rawType === 'fixed' ? 'fixed' : 'roster';
  const rawShift = String(formData.get('shiftId') ?? '').trim();
  const rawEffective = String(formData.get('effectiveFrom') ?? '').trim();
  if (!UUID_RE.test(employmentId)) {
    redirect(backTo(formData, { list: true, employmentId: null }, { error: await badField('badEmployment') }));
  }
  try {
    await assignEmployeeShiftDated(s, {
      employmentId,
      shiftType,
      shiftId: rawShift || null,
      effectiveFrom: rawEffective || null,
    });
  } catch (e) {
    // Refused: stay on the page, reason beside the fields, nothing typed is lost.
    redirect(backTo(formData, { list: false, employmentId }, { error: await messageFor(e) }));
  }
  revalidateBothDoors(employmentId);
  // Saved: back to the list, same filters, landed on this employee's row.
  redirect(backTo(formData, { list: true, employmentId }, { saved: '1' }));
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
    redirect(backTo(formData, { list: true, employmentId: null }, { error: await badField('badEmployment') }));
  }
  // A malformed arrangement id never reaches SQL (the ladder is matched in JS), but it can only have come
  // from a forged form, and "no longer on file" is the same true sentence the service would give.
  if (!UUID_RE.test(arrangementId)) {
    redirect(backTo(formData, { list: false, employmentId }, { error: await badField('removeNotFound') }));
  }
  try {
    await removeShiftArrangement(s, { employmentId, arrangementId });
  } catch (e) {
    redirect(backTo(formData, { list: false, employmentId }, { error: await messageFor(e) }));
  }
  revalidateBothDoors(employmentId);
  // Removed: stay on the page — the administrator is looking at the history they just changed.
  redirect(backTo(formData, { list: false, employmentId }, { removed: '1' }));
}
