import { assistantShellFor } from '../core/assistant-launcher';
import { isModuleEnabledOrFalse } from '../core/entitlements';
import { letterNavigation } from '../core/letter-navigation';
import { handlesPrivateCases } from '../core/private-cases';
import { withSharedReadSnapshot, type SessionContext } from '../db/client';
import { recruitmentTeamPresence, referralEligible } from '../packs/recruitment/service';
import { canAdminRecruitment } from './authz-model';

/** Resolve features for one signed-in shell using the existing access owners. */
export async function readShellFeatureNavigation(session: SessionContext, scopeIds: readonly string[]) {
  const [letters, rewards, assistant, privateCases, recruitmentTeam, referralPortal] = await withSharedReadSnapshot(
    session,
    () => Promise.all([
      isModuleEnabledOrFalse(session, 'employees') ? letterNavigation(session, scopeIds) : [],
      isModuleEnabledOrFalse(session, 'rewards')
        ? import('../packs/rewards/service').then(({ rewardNavigation }) => rewardNavigation(session)).catch(() => [])
        : [],
      assistantShellFor(session),
      handlesPrivateCases(session).catch(() => false),
      isModuleEnabledOrFalse(session, 'recruitment') && !canAdminRecruitment(session)
        ? recruitmentTeamPresence(session).catch(error => {
          console.error('recruitment team presence failed', error);
          return false;
        })
        : false,
      referralEligible(session).catch(() => false),
    ]),
  );
  return { letters, rewards, assistant, privateCases, recruitmentTeam, referralPortal };
}
