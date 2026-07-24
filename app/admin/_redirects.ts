/**
 * Shared post-action redirect helpers for the admin server actions (4e9a4d59).
 *
 * These four helpers used to be module-private in app/admin/actions.ts. That file is `'use server'`,
 * so it can only export async functions — the helpers could never be exported from it, and a second
 * actions file (app/admin/leave-approval/actions.ts) that needed the SAME "stay on the Entitlements
 * panel" contract had no way to reach them. Rather than hand-re-implement okEntitlements' fragile URL
 * contract (the #type fragment MUST ride AFTER the query so ToastFromQuery still parses ?toast=, and
 * an empty id must degrade to the bare route) in a second place, the definitions live here — a plain
 * module, NOT 'use server' — and both actions files import them. Call sites are unchanged.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

/** The Leave Type configuration workspace (General / Condition / Entitlement / Custom Setting steps). */
export const ENTITLEMENTS = '/admin/leave/entitlements';

export function fail(path: string, e: unknown): never {
  redirect(`${path}?error=${encodeURIComponent((e as Error).message)}`);
}

export function ok(path: string): never {
  revalidatePath(path);
  redirect(path);
}

/** Cluster dcd8e32f — like ok(), but also surfaces an ALREADY-LOCALISED success message through the
 *  globally mounted ToastFromQuery (app/layout.tsx reads ?toast= via useSearchParams). Localise the text
 *  before calling — ToastFromQuery renders the raw string, so never pass an i18n key/code in the URL. */
export function okToast(path: string, msg: string): never {
  revalidatePath(path);
  redirect(`${path}?toast=${encodeURIComponent(msg)}`);
}

/** 9b0503ac — success return for entitlement-area saves (policy add/edit/remove, scheme-entitlement
 *  upserts): stay on the Entitlements config panel with a success toast AND preserve the workspace's
 *  #type-<id> selection anchor (the updateLeaveTypeAction / b9dac2d1 stay-on-page keystone), so HR lands
 *  back on the exact leave type + step they were configuring instead of being bounced to /admin/leave.
 *  The anchor rides AFTER the query string so ToastFromQuery still sees ?toast=; an empty leaveTypeId
 *  (form didn't carry one) degrades to the bare Entitlements path — same route, so the workspace's client
 *  selection state still survives the soft navigation.
 *
 *  4e9a4d59 widened the callers: the grade catalog's four saves and the leave-type workspace's embedded
 *  Approval Workflow saves now return through here too, so EVERY save inside the Leave Type setup flow
 *  lands back on the same type + step. */
export function okEntitlements(msg: string, leaveTypeId: string): never {
  revalidatePath(ENTITLEMENTS);
  redirect(`${ENTITLEMENTS}?toast=${encodeURIComponent(msg)}${leaveTypeId ? `#type-${leaveTypeId}` : ''}`);
}
