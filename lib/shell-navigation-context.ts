import { withSharedReadSnapshot, type SessionContext } from '../db/client';
import { lifecycleModuleNavigation } from '../app/lifecycle/workflow-availability';
import { isModuleEnabledOrFalse } from '../core/entitlements';
import { onboardingNavigation } from '../packs/lifecycle/service';
import { offboardingPostingAccess } from '../packs/personnel-postings/service';
import { readShellNavigationAccess } from '../core/shell-navigation-access';
import { isAdmin } from './authz-model';
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

const disabledOnboarding = {
  module: false, v9: false, master: false, requisitions: false, joiners: 0, checklists: 0,
  v9Navigation: { onboarding: false, offboarding: false, administration: false },
};

/** Resolve company-dependent features and the Lifecycle rail on one signed-in snapshot. */
export function readSignedInShellNavigation(session: SessionContext) {
  const lifecycleEnabled = isModuleEnabledOrFalse(session, 'lifecycle');
  return withSharedReadSnapshot(session, async () => {
    const navigation = readShellNavigationContext(session).then(async context => ({
      context,
      features: await readShellFeatureNavigation(session, context[0].scopeIds),
    }));
    const [shell, onboardingNav, scopedLifecycleNavigation, offboardingPostingsAccess] = await Promise.all([
      navigation,
      lifecycleEnabled ? onboardingNavigation(session) : disabledOnboarding,
      lifecycleModuleNavigation(session),
      lifecycleEnabled ? offboardingPostingAccess(session).catch(() => false) : false,
    ]);
    return { ...shell, lifecycleEnabled, onboardingNav, scopedLifecycleNavigation, offboardingPostingsAccess };
  });
}
