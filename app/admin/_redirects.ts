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
/** 491c499f — the Leave Adjustments screen. Its saves return here with a toast carrying the two counts. */
export const ADJUSTMENTS = '/admin/leave/adjustments';
/** 4b0e76ae — the Generate Entitlement screen. openLeaveYearAction returns here with the grant counts. */
export const GENERATE = '/admin/leave/generate';
/** 6e9a126e release two — the Entitlement Tables + Employee Eligibility editor (the reporter's steps 1
 *  and 2). Its saves return here rather than to ENTITLEMENTS: the two steps are one screen and an operator
 *  writing a table then assigning it must not be bounced back into the Leave Type workspace between them.
 *
 *  a6fe37fc ROUND 5 (cutover) — REPOINTED at the new module. It named `/admin/leave/entitlements/templates`
 *  until that page became a redirect stub; a save would still have ARRIVED through the stub, but through a
 *  wasted hop, and a redirect constant naming an address that is no longer a screen is a statement about
 *  where a screen lives that has stopped being true (the LEAVE_APPROVAL note below says the same thing). */
export const ENTITLEMENT_TEMPLATES = '/admin/leave-config/entitlement-tables';
/**
 * 9a65f808 — System Labels → Organisation, and the home of the Grade Groups editor.
 *
 * THE THIRD ADDRESS THIS CARD HAS HAD, so the reasoning is worth keeping rather than re-deriving. It sat on
 * Settings → Leave → Entitlements (only because 6e9a126e deleted the workbench it lived in), moved to
 * Settings → Leave → Approval with f12d77e5 when grade groups were purely an approval-routing scope, and
 * now sits beside Job Grades on System Labels because it is neither: 9a65f808 made a grade group an
 * ENTITLEMENT-ELIGIBILITY vocabulary as well as an approval one, and a shared vocabulary maintained inside
 * one of its two consumers is a shared vocabulary the other consumer's admins cannot find.
 *
 * `LEAVE_APPROVAL` STOOD HERE AND IS GONE, deliberately: these three writes were its only callers, and an
 * exported redirect nobody redirects to is a statement about where a screen lives that has stopped being
 * true. The redirect has to move WITH the card every time — a save that worked and then dropped the admin
 * on a page with no grade-group form to show the result is bad; a failure doing it is worse, because
 * `fail()` carries the message in `?error=` and the refusal would surface on a screen that cannot explain
 * it. app/admin/leave-approval/actions.ts keeps its own private `PAGE` literal and is unaffected.
 */
export const SYSTEM_LABELS = '/admin/settings/system-labels';

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

/**
 * ee6b7c69 — okEntitlements' failure twin, and it exists for the same reason.
 *
 * The Entitlement Tables are now typed INSIDE a leave type's Entitlement step as well as on the standalone
 * screen. A save from the embedded mount that failed had to be able to report the failure where the form
 * is: `fail(ENTITLEMENT_TEMPLATES, e)` would have thrown HR onto the standalone screen — the screen the
 * embed exists so they need not visit — with a message about a form they can no longer see. The anchor
 * rides AFTER the query for the same reason it does in okEntitlements: ErrorBanner reads ?error=, and the
 * workspace reads #type-. An empty id degrades to the bare route rather than emitting a stray '#type-'.
 */
export function failEntitlements(e: unknown, leaveTypeId: string): never {
  redirect(
    `${ENTITLEMENTS}?error=${encodeURIComponent((e as Error).message)}${leaveTypeId ? `#type-${leaveTypeId}` : ''}`,
  );
}
