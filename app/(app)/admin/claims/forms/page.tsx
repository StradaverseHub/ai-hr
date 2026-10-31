import { permanentRedirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';

/**
 * Claim Forms — RETIRED AS A SCREEN (e7eb5d83 rev 4, point 2), kept as a route.
 *
 * The designer that used to live here now renders inside each claim type's own panel on /admin/claims:
 * one place to set a claim type up instead of two. The rows it edits (claim_form_field), the service
 * that guards them (createClaimFormField + BUILT_IN_FIELD_KEYS) and the four undeletable built-ins are
 * all unchanged — only the screen moved.
 *
 * WHY THIS FILE STILL EXISTS, twice over:
 *   • Bookmarks. This tab was live; deleting the route would 404 an admin who saved it.
 *   • lib/permissions.ts registers /admin/claims/forms, and test/function-access.test.ts asserts BOTH
 *     directions — every registered route must exist ON DISK AS A GUARDED ROUTE, and every guarded route
 *     must be registered. requireAdmin() below is therefore load-bearing, not decoration: without it this
 *     page stops counting as guarded and the "no stale routes" case fails. It is also simply correct —
 *     a non-admin should be refused here, not redirected onward.
 *
 * permanentRedirect (308) rather than redirect (307): the move is not temporary.
 */
export default async function ClaimFormsPage() {
  await requireAdmin();
  permanentRedirect('/admin/claims');
}
