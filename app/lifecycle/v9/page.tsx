import { requireAdmin, requireModule } from '@/lib/authz';
import { V9Workspace } from './workspace';
import { readV9Workspace } from './read-workspace';
import './workspace.css';
export default async function Page() {
  await requireAdmin();
  const session = await requireModule('lifecycle');
  return <V9Workspace {...await readV9Workspace(session)}/>;
}
