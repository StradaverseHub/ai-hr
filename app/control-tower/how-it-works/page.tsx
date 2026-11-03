import { permanentRedirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';

/**
 * Issue 17 (owner: "Merge both entirely"): "How the Control Tower works" merged into AI Centre › How it works.
 * Its live, tenant-specific statuses render there for administrators (components/ai-centre/live-status.tsx).
 *
 * WHY THIS FILE STILL EXISTS. Bookmarks and links in people's notes must not 404, and lib/permissions.ts
 * registers /control-tower/how-it-works: test/function-access.test.ts requires every registered route to exist on
 * disk as a guarded route. requireAdmin() below is therefore the unchanged guard, not decoration: a non-administrator
 * is refused here exactly as before, and only an administrator is forwarded.
 *
 * permanentRedirect (308) rather than redirect (307): the move is not temporary.
 */
export default async function HowItWorksPage() {
  await requireAdmin();
  permanentRedirect('/assistant?view=how');
}
