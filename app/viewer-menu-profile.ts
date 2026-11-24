import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '@/db/client';
import { isAdmin } from '@/lib/authz';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { readShellNavigationAccess } from '@/core/shell-navigation-access';
import { letterNavigation } from '@/core/letter-navigation';
import { offboardingPostingAccess } from '@/packs/personnel-postings/service';
import { sessionClaimsDigest, viewerMenuCache, viewerMenuCacheEnabled, type MenuRead } from '@/lib/viewer-menu-cache';
import { lifecycleModuleNavigation } from './lifecycle/workflow-availability';

/**
 * The frame's menu visibility, cached per viewer (ADR 0181 Phase 3, decision 3; lib/viewer-menu-cache.ts).
 * Only which destinations the rail shows. The live work queues and counts (the lifecycle inbox, Onboarding's joiner
 * and checklist counts, the approval facts) are read on every draw, never from here.
 */
export type ViewerMenuProfile = {
  shellAccess: Awaited<ReturnType<typeof readShellNavigationAccess>>;
  rewardDestinations: Awaited<ReturnType<typeof import('@/packs/rewards/service').rewardNavigation>>;
  lifecycleNavigation: Awaited<ReturnType<typeof lifecycleModuleNavigation>>;
  offboardingPostingsAccess: boolean;
};

/** The tenant's access version (migration 7260), or null when it cannot be read or the menu is not cached for this
 * session (the frame then reads live, and sends no version read). */
export async function viewerAccessVersion(session: SessionContext): Promise<string | null> {
  if (!cacheable(session)) return null;
  try {
    return await withTenant(session, async tx => {
      const [row] = await tx.execute<{ version: string }>(sql`select app.viewer_access_version()::text as version`);
      return row?.version ?? null;
    });
  } catch (error) {
    console.error('Viewer access version unavailable; the menu is read live', error);
    return null;
  }
}

/** Every claim of the session that decides what the menu shows. */
function claims(session: SessionContext) {
  return {
    tenantId: session.tenantId, userId: session.userId ?? null, personId: session.personId ?? null,
    roles: session.roles ?? null, grants: session.grants ?? null, entitlements: session.entitlements ?? null,
    entitlementsExempt: session.entitlementsExempt ?? null, entitlementsError: session.entitlementsError ?? null,
    statutoryOverride: session.statutoryOverride ?? null,
  };
}

/** Whether this session's menu may be cached: a signed-in person's web session, with the cache switched on. */
function cacheable(session: SessionContext): boolean {
  return viewerMenuCacheEnabled() && !!session.userId && !session.agent;
}

async function keyed<T>(
  kind: string,
  session: SessionContext,
  extra: string,
  version: Promise<string | null>,
  read: () => Promise<MenuRead<T>>,
): Promise<T> {
  if (!cacheable(session)) return (await read()).value;
  // The version is read before the answer, so a cached answer is never older than its version.
  const current = await version;
  if (current === null) return (await read()).value;
  const key = [kind, session.tenantId, session.userId, sessionClaimsDigest(claims(session)), current, todayInKualaLumpur(), extra].join('|');
  return viewerMenuCache().get(key, read);
}

/** The scope-independent menu facts. */
export function viewerMenuProfile(session: SessionContext, version: Promise<string | null>): Promise<ViewerMenuProfile> {
  const lifecycleEnabled = isModuleEnabledOrFalse(session, 'lifecycle');
  const rewardsEnabled = isModuleEnabledOrFalse(session, 'rewards');
  return keyed('menu', session, '', version, async () => {
    let degraded = false;
    const [shellAccess, rewardDestinations, lifecycleNavigation, offboardingPostingsAccess] = await Promise.all([
      readShellNavigationAccess(session, !isAdmin(session), isAdmin(session)),
      rewardsEnabled
        ? import('@/packs/rewards/service').then(({ rewardNavigation }) => rewardNavigation(session)).catch(() => { degraded = true; return []; })
        : Promise.resolve([]),
      lifecycleModuleNavigation(session),
      lifecycleEnabled ? offboardingPostingAccess(session).catch(() => { degraded = true; return false; }) : Promise.resolve(false),
    ]);
    return { value: { shellAccess, rewardDestinations, lifecycleNavigation, offboardingPostingsAccess }, cacheable: !degraded };
  });
}

/** The Letters destinations for the companies in view (they differ by company scope). */
export function viewerLetterDestinations(session: SessionContext, scopeIds: readonly string[], version: Promise<string | null>) {
  return keyed('letters', session, [...scopeIds].sort().join(','), version, async () => ({
    value: await letterNavigation(session, scopeIds),
    cacheable: true,
  }));
}
