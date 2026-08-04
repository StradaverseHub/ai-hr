'use server';

/**
 * 476f23ed — Movement Settings write path. Four server actions over core/movement-type.ts, all
 * requireAdmin-gated (defence in depth over the table's own admin-only RLS WITH CHECK).
 *
 * Every action follows the house pattern: the redirect ALWAYS happens outside the try/catch, so a
 * NEXT_REDIRECT thrown by a successful redirect is never swallowed as a service error.
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

/**
 * `keepOnError` carries the maintenance panel back with the message (1b87e8a0). Since the redesign the
 * Add/Edit form lives behind `?new=1` / `?edit=CODE`, so a bare `?error=` redirect would close the panel
 * and throw away what the admin had typed — the old screen had the form permanently on the page and did
 * not have this problem. Success still lands on the plain list, which is the whole point of a panel.
 */
async function run(write: () => Promise<void>, keepOnError?: string) {
  let errMsg: string | null = null;
  try {
    await write();
    revalidatePath(PAGE);
    // The New Event form reads the catalogue too — a type renamed or switched off here must not linger
    // behind a cached personnel page.
    revalidatePath('/admin/personnel', 'layout');
  } catch (e) {
    errMsg = (e as Error).message;
  }
  if (errMsg) {
    const back = keepOnError ? `&${keepOnError}` : '';
    redirect(`${PAGE}?error=${encodeURIComponent(errMsg)}${back}`);
  }
  redirect(`${PAGE}?toast=Saved`);
}

/** Rename an existing type (built-in or custom), or add one of the organisation's own. */
export async function saveMovementEventTypeAction(formData: FormData) {
  const s = await requireAdmin();
  const code = String(formData.get('code') ?? '').trim() || null;
  await run(
    () =>
      saveMovementEventType(s, {
        code,
        label: String(formData.get('label') ?? ''),
        behaviourKind: String(formData.get('behaviourKind') ?? '').trim() || null,
      }).then(() => undefined),
    code ? `edit=${encodeURIComponent(code)}` : 'new=1',
  );
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
