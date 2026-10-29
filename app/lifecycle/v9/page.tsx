import { requireModule } from '@/lib/authz';
import { v9Workspace } from '@/packs/lifecycle/service';
import { V9Workspace } from './workspace';
import { viewerIdentity } from '@/lib/viewer';
import './workspace.css';
export default async function Page() {
  const session = await requireModule('lifecycle');
  return <V9Workspace initial={await v9Workspace(session)} viewer={await viewerIdentity(session)} />;
}
