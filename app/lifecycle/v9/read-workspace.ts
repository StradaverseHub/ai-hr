import 'server-only';
import type { SessionContext } from '@/db/client';
import { v9Workspace, onboardingContext, onboardingList, onboardingOptions } from '@/packs/lifecycle/service';
import { viewerIdentity } from '@/lib/viewer';
import type { NativeJoinersData } from './native-joiners';
/** Both V9 register and native-case presentation use the same scoped workspace owner. */
export async function readV9Workspace(session: SessionContext) {
  const [initial, viewer, context] = await Promise.all([v9Workspace(session), viewerIdentity(session), onboardingContext(session)]);
  let joiners: NativeJoinersData | null = null;
  if (initial.config && context.revision && context.actor.module) {
    const [rows, options] = await Promise.all([onboardingList(session), onboardingOptions(session)]);
    joiners = { config: context.config, rows, options };
  }
  return { initial, viewer, joiners };
}
