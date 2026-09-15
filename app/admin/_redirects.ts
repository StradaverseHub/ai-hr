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

/**
 * The Leave Type configuration workspace.
 *
 * a6fe37fc ROUND 5 (cutover) — REPOINTED at `/admin/leave-config/types`, and the parenthetical that used
 * to name "General / Condition / Entitlement / Custom Setting steps" is gone with the steps themselves:
 * the workspace is five TABS on the leave type now (IA §2), and `components/leave-type-panel.tsx` was
 * deleted in this same commit. Every leave-TYPE save returns here, including the two helpers below that
 * carry the `#type-<id>` anchor — which is why this constant had to move rather than lean on the stub: a
 * fragment is never sent to the server, so a save routed through a redirect would arrive with no leave
 * type selected.
 */
export const ENTITLEMENTS = '/admin/leave-config/types';
/**
 * a6fe37fc ROUND 5 (cutover) — COMPANY RULES, the destination the company- and tenant-wide leave settings
 * were absorbed into (IA §2.0.3). It is a NEW constant rather than a reuse of ENTITLEMENTS, and the
 * distinction is the point — those writes used to return to the leave TYPE screen because that is where
 * their cards happened to be drawn, and after the cutover they were not on it. Returning them to
 * ENTITLEMENTS would leave an administrator who just saved a company rule looking at the leave type list,
 * wondering whether it saved.
 *
 * r281 — ONE CALLER LEFT, and the rule that produced it is what the other two followed out. The reporter
 * asked for two of the three settings to move again: the half-day full deduction to the Special Setting
 * row (`SPECIAL_SETTING` below) and the shared leave groups back onto the Leave types screen, at page
 * level rather than inside the per-type workspace (`ENTITLEMENTS`). Each redirect moved WITH its card, on
 * exactly the reasoning above. What still returns here is the encashment policy, which is still drawn
 * here.
 */
export const COMPANY_RULES = '/admin/leave-config/company-rules';
/**
 * r281 (a73d1e14) — SPECIAL SETTING, the row Half Day Deduction moved onto.
 *
 * A NEW CONSTANT RATHER THAN A REUSE OF `COMPANY_RULES`, for exactly the reason that constant exists at
 * all: the half-day write used to return to Company rules because that is where its card was drawn, and
 * it is not on that screen any more. Returning it there would leave an administrator who just ticked a
 * company looking at a page with no half-day card on it, wondering whether it saved — and on the error
 * path would show a refusal about a form they can no longer see. The redirect moves WITH the card.
 */
export const SPECIAL_SETTING = '/admin/leave-config/special-setting';
/** 491c499f — the Leave Adjustments screen. Its saves return here with a toast carrying the two counts.
 *  a6fe37fc ROUND 5 (cutover) — REPOINTED at the new module in the commit that emptied the old page. */
export const ADJUSTMENTS = '/admin/leave-config/adjustments';
/** 4b0e76ae — the Generate Entitlement screen. openLeaveYearAction returns here with the grant counts.
 *  a6fe37fc ROUND 5 (cutover) — REPOINTED at the new module in the commit that emptied the old page. */
export const GENERATE = '/admin/leave-config/generate';
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
