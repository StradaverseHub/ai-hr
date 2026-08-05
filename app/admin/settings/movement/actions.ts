'use server';

/**
 * 476f23ed — Movement Settings write path. Three server actions over core/movement-type.ts, all
 * requireAdmin-gated (defence in depth over the table's own admin-only RLS WITH CHECK).
 *
 * TWO SHAPES, ON PURPOSE (1b87e8a0 re-build). The row actions redirect; the save returns a value. A
 * redirecting action is right where there is nothing on screen to lose and wrong where a modal is open
 * over the list holding half-typed input. Each is documented at its own definition.
 *
 * Where an action DOES redirect it follows the house pattern: the redirect ALWAYS happens outside the
 * try/catch, so a NEXT_REDIRECT thrown by a successful redirect is never swallowed as a service error.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import {
  deleteMovementEventType,
  saveMovementEventType,
  setMovementEventTypeActive,
} from '@/core/movement-type';

const PAGE = '/admin/settings/movement';

/** Both writes owe the same two revalidations: this screen, and the New Event form on a personnel page,
 *  which reads the same catalogue — a type renamed or switched off here must not linger behind a cache. */
function revalidate() {
  revalidatePath(PAGE);
  revalidatePath('/admin/personnel', 'layout');
}

/**
 * The ROW actions (switch on/off, delete) are plain `<form action>` posts with no state to keep: each
 * flips one flag, so a redirect carrying `?error=` is the whole error surface it needs.
 *
 * The SAVE deliberately does not use this — see saveMovementEventTypeAction.
 */
async function run(write: () => Promise<void>) {
  let errMsg: string | null = null;
  try {
    await write();
    revalidate();
  } catch (e) {
    errMsg = (e as Error).message;
  }
  if (errMsg) redirect(`${PAGE}?error=${encodeURIComponent(errMsg)}`);
  redirect(`${PAGE}?toast=Saved`);
}

/** What a save tells the dialog. Returned, never redirected — see below. */
export type MovementTypeSaveResult = { ok: true } | { ok: false; error: string };

/**
 * Rename an existing type (built-in or custom), or add one of the organisation's own.
 *
 * RETURNS ITS OUTCOME rather than redirecting, because since the 1b87e8a0 re-build the form lives in a
 * modal (movement-type-dialog.tsx) driven by useActionState. A redirect would navigate the route out
 * from under an open dialog: on success it would reset the list's scroll, and on a REFUSAL — a name
 * already taken, a behaviour the service will not allow — it would close the dialog and throw away
 * everything the admin had typed. Returning `{ ok: false, error }` keeps the dialog open, the typing
 * intact and the message next to the field it is about.
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
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
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
