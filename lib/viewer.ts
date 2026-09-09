import { cache } from 'react';

import type { SessionContext } from '@/db/client';
import { myEmployment, myPersonName } from '@/core/read';

/**
 * WHO IS SIGNED IN, for the app shell (feedback fbf6abd0).
 *
 * ── WHY THIS IS NOT `lib/principals.ts` ───────────────────────────────────────────────────────────────
 * `listPrincipals()` returns { userId, name, roles } and looks like exactly the source this wants. It is
 * not: it is the DEV/DEMO identity switcher's list (`app.dev_principals()`), it returns [] whenever
 * `demoSwitcherEnabled()` is false, and on a real WorkOS deployment that is always. A header fed from it
 * would show a name on a developer's machine, show a name on the gated demo, and show nothing at all on
 * the deployment the reporter is actually looking at — the precise failure this item was raised about.
 *
 * `lib/session.ts` carries no display name either (tenantId / userId / personId / grants / roles), and
 * `app_user` has no name or email column — only `workos_user_id`. So the signed-in person's name and
 * Employee ID exist only on their EMPLOYMENT and their PERSON, which is where the rest of the app reads
 * them from (`myEmployment`, used by /me, the notice slots and every self-service screen). This reads the
 * same rows through the same RLS-scoped functions, so the corner cannot disagree with the profile it
 * links to.
 *
 * ── MEMOISED, BECAUSE THE SHELL NOW ASKS TWICE ────────────────────────────────────────────────────────
 * `myEmployment` is a `withTenant` transaction, and the root layout renders on EVERY authenticated page.
 * Before this change the layout already resolved it once, inside `NoticePopupSlot`. Adding a second
 * caller would have doubled that per-render cost for a row both callers want identically, so both go
 * through this `cache()`d seam instead and the shell still issues exactly ONE such query per request.
 *
 * `cache` keys on the argument by identity; `getSession` is itself `cache()`d, so every caller in one
 * request passes the same SessionContext object and shares the entry. Outside a React request scope
 * (scripts, vitest) `cache` is a passthrough — callers get today's behaviour, one resolution per call.
 */
export const viewerEmployment = cache((s: SessionContext) => myEmployment(s));

/** What the topbar shows about the viewer. Never null: every principal resolves to one of three states. */
export type ViewerIdentity = {
  /** Their full name, or null when the principal is linked to no person at all (a platform login). */
  name: string | null;
  /** Their Employee ID. Null with no active employment, and also when the employment carries no code. */
  employeeCode: string | null;
  /** Whether an ACTIVE employment resolved — decides the menu's second line and the profile link. */
  employed: boolean;
};

/**
 * The signed-in person's name + Employee ID for the account corner.
 *
 * THREE STATES, ALL OF THEM REAL, NONE OF THEM BLANK — and the middle one is why this is not simply
 * `myEmployment`:
 *
 *   1. `employed: true`  — an active employment. Name + Employee ID (which is itself nullable in the
 *      schema, so `employeeCode` can still be null here; the menu names that case separately).
 *   2. `employed: false` WITH a name — a real, named person who has no active employment: an
 *      administrator account never hired into a company (the seeded HR Admin is exactly this, which a
 *      dev-server render is what revealed), or a leaver whose login still resolves. Showing their own
 *      name is strictly better than a generic label, and it still comes from their own person row.
 *      No Employee ID, and no profile link — /me would only tell them they are not linked.
 *   3. `employed: false` with NO name — `session.personId` is null, a platform login attached to no
 *      person. There is genuinely nothing to show, so the menu renders a localized "Platform account".
 *
 * The extra person read happens ONLY in states 2 and 3, i.e. never for an ordinary employee, and with no
 * `personId` at all it returns before `withTenant` is even called — no transaction, no `set_config`
 * round-trip. (It used to short-circuit INSIDE the transaction callback, which is not the same thing and
 * cost a BEGIN + four statements + COMMIT per render for a login there was nothing to look up for.)
 */
export async function viewerIdentity(s: SessionContext): Promise<ViewerIdentity> {
  const me = await viewerEmployment(s);
  if (me?.name) return { name: me.name, employeeCode: me.employeeCode ?? null, employed: true };
  return { name: await myPersonName(s), employeeCode: null, employed: false };
}
