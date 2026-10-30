import 'server-only';
import type { SessionContext } from '@/db/client';
import { v9Workspace, onboardingContext, onboardingList, onboardingOptions } from '@/packs/lifecycle/service';
import { viewerIdentity } from '@/lib/viewer';
import type { NativeSettingsData } from './workspace-settings';
import type { NativeJoinersData } from './native-joiners';
/** Both V9 register and native-case presentation use the same scoped workspace owner. */
export async function readV9Workspace(session: SessionContext) {
  const [initial, viewer, context] = await Promise.all([v9Workspace(session), viewerIdentity(session), onboardingContext(session)]);
  let joiners: NativeJoinersData | null = null, nativeSettings: NativeSettingsData | null = null;
  if (initial.config && context.revision && (context.actor.page || context.actor.records || context.actor.master)) {
    const [rows, options] = await Promise.all([context.actor.page||context.actor.records ? onboardingList(session) : Promise.resolve([]), onboardingOptions(session)]);
    if(context.actor.module||context.actor.master)nativeSettings = { context, options };
    if (context.actor.page||context.actor.records) joiners = { config: context.config, rows, options };
  }
  return { initial, viewer, joiners, nativeSettings };
}
