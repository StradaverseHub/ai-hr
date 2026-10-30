import { redirect } from 'next/navigation';
import { V9Error } from '@/lib/lifecycle-v9-model';
import { requireModule } from '@/lib/authz';
import { V9Workspace } from './workspace';
import { readV9Workspace } from './read-workspace';
import './workspace.css';
export default async function Page() {
  const session = await requireModule('lifecycle');
  const workspace=await readV9Workspace(session).catch(error=>{if(error instanceof V9Error&&error.code==='forbidden')redirect('/me/lifecycle');throw error;});
  return <V9Workspace {...workspace}/>;
}
