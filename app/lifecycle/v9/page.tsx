import { requireAdmin, requireModule } from '@/lib/authz';
import { v9Workspace, onboardingContext, onboardingList, onboardingOptions } from '@/packs/lifecycle/service';
import { V9Workspace } from './workspace';
import { viewerIdentity } from '@/lib/viewer';
import type { NativeJoinersData } from './native-joiners';
import './workspace.css';
export default async function Page() {
  await requireAdmin();
  const session = await requireModule('lifecycle');
  const [initial, viewer, context] = await Promise.all([v9Workspace(session), viewerIdentity(session), onboardingContext(session)]);
  let joiners: NativeJoinersData | null = null;
  if (initial.config && context.revision && context.actor.module) {
    const [rows, options] = await Promise.all([onboardingList(session), onboardingOptions(session)]);
    joiners = { config: context.config, rows, options };
  }
  return <V9Workspace initial={initial} viewer={viewer} joiners={joiners}/>;
}
