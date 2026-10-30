'use server';

/**
 * 476f23ed — Movement Settings write path. Server actions over core/movement-type.ts and (1d58019a) core/
 * termination-reason-catalog.ts, all requireAdmin-gated — defence in depth over the services' own admin
 * check and the tables' admin-only write policies.
 *
 * TWO SHAPES, ON PURPOSE (1b87e8a0 re-build). The row actions redirect; the save returns a value. A
 * redirecting action is right where there is nothing on screen to lose and wrong where a modal is open
 * over the list holding half-typed input. Each is documented at its own definition.
 *
 * Where an action DOES redirect it follows the house pattern: the redirect ALWAYS happens outside the
 * try/catch, so a NEXT_REDIRECT thrown by a successful redirect is never swallowed as a service error.
 */
import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import type { MovementFieldRule } from '@/lib/movement-field-rules';
import {
  deleteMovementEventType,
  saveMovementEventType,
  setMovementEventTypeActive,
} from '@/core/movement-type';

import {
  deleteTerminationReason,
  saveTerminationReason,
  setTerminationReasonActive,
} from '@/core/termination-reason-catalog';

const PAGE = '/admin/settings/movement';
/** 1d58019a — the Termination Reasons tab. Its row actions return HERE, not to the Event Types tab. */
const REASONS_PAGE = '/admin/settings/movement/reasons';

/** Every write owes the same revalidations: both Movement Settings tabs (and the configuration pages under
 *  them), and the New Event form on a personnel page, which reads the same catalogues — a type or reason
 *  renamed or switched off here must not linger behind a cache. */
function revalidate() {
  revalidatePath(PAGE, 'layout');
  revalidatePath('/admin/personnel', 'layout');
}

/**
 * The ROW actions (switch on/off, delete) are plain `<form action>` posts with no state to keep: each
 * flips one flag, so a redirect carrying `?error=` is the whole error surface it needs.
 *
 * The SAVE deliberately does not use this — see saveMovementEventTypeAction.
 */
async function run(write: () => Promise<void>, page: string = PAGE) {
  let errMsg: string | null = null;
  try {
    await write();
    revalidate();
  } catch (e) {
    errMsg = publicErrorMessage(e);
  }
  if (errMsg) redirect(`${page}?error=${encodeURIComponent(errMsg)}`);
  redirect(`${page}?toast=Saved`);
}

/**
 * 1d58019a Step 2 — the Field Controls grid as posted. Shape only (an array of plain rule objects, bounded);
 * whether each rule is allowed for the type is the service's decision. Absent = leave as stored.
 */
function parseFieldRules(raw: FormDataEntryValue | null): MovementFieldRule[] | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error('The Field Controls could not be read. Reload the page and try again.');
  }
  if (!Array.isArray(parsed) || parsed.length > 64) throw new Error('The Field Controls could not be read. Reload the page and try again.');
  return parsed.map((r) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    return {
      field: String(o.field ?? '') as MovementFieldRule['field'],
      included: o.included === true,
      editable: o.editable === true,
      mustChange: o.mustChange === true,
      document: String(o.document ?? 'none') as MovementFieldRule['document'],
    };
  });
}

/** What a save tells the form. Returned, never redirected — see below. */
export type MovementTypeSaveResult = { ok: true } | { ok: false; error: string };

/**
 * Rename an existing type (built-in or custom), or add one of the organisation's own.
 *
 * RETURNS ITS OUTCOME rather than redirecting. 1d58019a moved the form from a modal onto its own
 * configuration page (types/[code], types/new — event-type-form.tsx), and the reason is unchanged: on a
 * REFUSAL — a name already taken, a behaviour the service will not allow — a redirect would reload the page
 * and throw away everything the admin had typed. Returning `{ ok: false, error }` keeps the typing intact
 * and the message on screen; on success the form itself navigates back to the list.
 *
 * `requireAdmin()` stays OUTSIDE the try: a caller with no admin role is not a validation message to
 * paint in a dialog, it is a request that must fail.
 */
export async function saveMovementEventTypeAction(
  _prev: MovementTypeSaveResult | null,
  formData: FormData,
): Promise<MovementTypeSaveResult> {
  const s = await requireAdmin();
  try {
    await saveMovementEventType(s, {
      code: String(formData.get('code') ?? '').trim() || null,
      label: String(formData.get('label') ?? ''),
      behaviourKind: String(formData.get('behaviourKind') ?? '').trim() || null,
      // 1d58019a — always posted by the configuration page; blank clears it.
      description: String(formData.get('description') ?? ''),
      // 1d58019a Step 2 — the Termination Reasons card posts its ticks plus a marker, so "none ticked"
      // (= every active reason) is distinguishable from "card not shown" (= leave as stored).
      reasonCodes: formData.get('reasonsPosted') === '1' ? formData.getAll('reasonCode').map(String) : undefined,
      // The Field Controls grid travels as one JSON value; the service validates every entry.
      fieldRules: parseFieldRules(formData.get('fieldRules')),
    });
  } catch (e) {
    return { ok: false, error: publicErrorMessage(e) };
  }
  revalidate();
  return { ok: true };
}

/** Switch a type on or off. Records that already use it are untouched. */
export async function setMovementEventTypeActiveAction(formData: FormData) {
  const s = await requireAdmin();
  const code = String(formData.get('code') ?? '');
  const active = String(formData.get('active') ?? '') === 'true';
  await run(() => setMovementEventTypeActive(s, { code, active }));
}

/** Delete a custom type. Refused by the service for a built-in and for anything the ledger references. */
export async function deleteMovementEventTypeAction(formData: FormData) {
  const s = await requireAdmin();
  await run(() => deleteMovementEventType(s, String(formData.get('code') ?? '')));
}

/**
 * 1d58019a — add one of the organisation's own termination reasons, or rename one. Value-returning for the
 * same reason as saveMovementEventTypeAction: the form is a dialog over the list, and a refusal must keep it
 * open with the typing intact.
 */
export async function saveTerminationReasonAction(
  _prev: MovementTypeSaveResult | null,
  formData: FormData,
): Promise<MovementTypeSaveResult> {
  const s = await requireAdmin();
  try {
    await saveTerminationReason(s, {
      code: String(formData.get('code') ?? '').trim() || null,
      label: String(formData.get('label') ?? ''),
      category: String(formData.get('category') ?? '').trim() || null,
    });
  } catch (e) {
    return { ok: false, error: publicErrorMessage(e) };
  }
  revalidate();
  return { ok: true };
}

/** 1d58019a — switch a termination reason on or off. Records that already carry it are untouched. */
export async function setTerminationReasonActiveAction(formData: FormData) {
  const s = await requireAdmin();
  const code = String(formData.get('code') ?? '');
  const active = String(formData.get('active') ?? '') === 'true';
  await run(() => setTerminationReasonActive(s, { code, active }), REASONS_PAGE);
}

/** 1d58019a — delete one of the organisation's own reasons. Refused by the service for a built-in and for
 *  anything history references. */
export async function deleteTerminationReasonAction(formData: FormData) {
  const s = await requireAdmin();
  await run(() => deleteTerminationReason(s, String(formData.get('code') ?? '')), REASONS_PAGE);
}
