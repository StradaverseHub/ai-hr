import 'server-only';
import { lifecycleModuleNavigation } from '@/app/lifecycle/workflow-availability';
import { withSharedReadSnapshot, type SessionContext } from '@/db/client';
import { onboardingNavigation } from '@/packs/lifecycle/service';
import { offboardingPostingAccess } from '@/packs/personnel-postings/service';
import { requestReadScope } from './request-read-scope';

const disabledOnboarding = {
  module: false, v9: false, master: false, requisitions: false, joiners: 0, checklists: 0,
  v9Navigation: { onboarding: false, offboarding: false, administration: false },
};

/** Read the rail's lifecycle capabilities under one request snapshot and the original service guards. */
export function readShellLifecycleNavigation(session: SessionContext, lifecycleEnabled: boolean) {
  return withSharedReadSnapshot(session, () => Promise.all([
    lifecycleEnabled ? onboardingNavigation(session) : disabledOnboarding,
    lifecycleModuleNavigation(session),
    lifecycleEnabled ? offboardingPostingAccess(session).catch(() => false) : false,
  ]), undefined, requestReadScope());
}
