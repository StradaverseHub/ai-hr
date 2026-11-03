import { redirect } from 'next/navigation';
import { V9Error } from '@/lib/lifecycle-v9-model';
import { requireModule } from '@/lib/authz';
import {WorkflowModuleNavigation} from '../workflow-module-navigation';
import {lifecycleWorkflowAvailability} from '../workflow-availability';
import { V9Workspace } from './workspace';
import { readV9Workspace } from './read-workspace';
import { v9WorkspaceView } from '@/lib/lifecycle-v9-navigation';
import './workspace.css';
export default async function Page({ searchParams }: { searchParams: Promise<{view?: string | string[];workflow?:string|string[]}> }) {
  const session = await requireModule('lifecycle');
  const workspace=await readV9Workspace(session).catch(error=>{if(error instanceof V9Error&&error.code==='forbidden')redirect('/me/lifecycle');throw error;});
  const query = await searchParams;
  const workflowNavigation=v9WorkspaceView(query.view)==='workflows'?<WorkflowModuleNavigation current="legacy" available={await lifecycleWorkflowAvailability(session,workspace.initial.permissions?.administration??workspace.initial.canConfigure)}/>:undefined;
  return <V9Workspace workflowNavigation={workflowNavigation} {...workspace} navigation="global" initialView={v9WorkspaceView(query.view)} initialWorkflow={typeof query.workflow === 'string' ? query.workflow.slice(0,120) : undefined}/>;
}
