import { lifecycleModuleNavigation } from '../app/lifecycle/workflow-availability';
import { isModuleEnabledOrFalse } from '../core/entitlements';
import { withSharedReadSnapshot, type SessionContext } from '../db/client';
import { readShellNavigationAccess } from '../core/shell-navigation-access';
import { onboardingNavigation } from '../packs/lifecycle/service';
import { adminSectionHref, latestOnehrAdminCycleId } from '../packs/performance/service';
import { offboardingPostingAccess } from '../packs/personnel-postings/service';
import { canAdminOnehr, isAdmin } from './authz-model';
import {canConfigureIdentityEmail} from './identity/email-settings';
import {settleReadGroup} from './settle-read-group';
import { companyContextForPage } from './scope';
import { readShellFeatureNavigation } from './shell-feature-navigation';
import { viewerIdentity } from './viewer';

/** The first signed-in layout reads share one authorized, read-only transaction. */
export function readShellNavigationContext(session: SessionContext) {
  const admin = isAdmin(session);
  return withSharedReadSnapshot(session, () => Promise.all([
    companyContextForPage(session),
    viewerIdentity(session),
    readShellNavigationAccess(session, !admin, admin),
  ]));
}

/** Resolve scope before feature links on the same authenticated database snapshot. */
export function readSignedInShellNavigation(session: SessionContext) {
  return withSharedReadSnapshot(session, async () => {
    const [navigation, identityEmailAvailable] = await settleReadGroup([
      async () => {
        const context = await readShellNavigationContext(session);
        const [{ scopeIds }] = context;
        const features = await readShellFeatureNavigation(session, scopeIds);
        return { context, features };
      },
      () => canConfigureIdentityEmail(session),
    ]);
    return { ...navigation, identityEmailAvailable };
  });
}

/** Read the destinations needed by the signed-in rail with the same identity and snapshot.
 * Passive inbox work has its own admission priority and starts after this group. */
export function readSignedInShellRail(session: SessionContext) {
  const lifecycleEnabled = isModuleEnabledOrFalse(session, 'lifecycle');
  const performanceEnabled = canAdminOnehr(session) && isModuleEnabledOrFalse(session, 'performance');
  return withSharedReadSnapshot(session, async () => {
    const [navigation, onboardingNav, scopedLifecycleNavigation, offboardingPostingsAccess, performanceAdminPath] =
      await settleReadGroup([
        () => readSignedInShellNavigation(session),
        () => lifecycleEnabled ? onboardingNavigation(session) :
          { module: false, v9: false, v9Navigation: { onboarding: false, offboarding: false, administration: false },
            master: false, requisitions: false, joiners: 0, checklists: 0 },
        () => lifecycleModuleNavigation(session),
        () => lifecycleEnabled ? offboardingPostingAccess(session).catch(() => false) : false,
        // A missing cycle or unavailable optional read keeps the ordinary Performance landing.
        () => performanceEnabled
          ? latestOnehrAdminCycleId(session).then(id => id ? adminSectionHref(id, 'cycle') : undefined, () => undefined)
          : undefined,
      ]);
    return { ...navigation, lifecycleEnabled, onboardingNav, scopedLifecycleNavigation, offboardingPostingsAccess, performanceAdminPath };
  });
}
