import {notFound,redirect} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {canConfigureContractWorkflows,contractWorkflowWorkspace,contractDirectory} from '@/packs/contracts/service';
import {WorkflowModuleNavigation} from '../../workflow-module-navigation';
import {lifecycleWorkflowAvailability} from '../../workflow-availability';
import {ContractWorkflowEditor} from './editor';
import '../../v9/workspace.css';
export default async function Page(){const session=await requireScopedLifecycleModule();if(!session)redirect('/login');if(!await canConfigureContractWorkflows(session))notFound();const workspace=await contractWorkflowWorkspace(session);const directories=await Promise.all(workspace.companies.map(async company=>({companyId:company.id,users:await contractDirectory(session,company.id)})));return <main className="v9-workspace"><WorkflowModuleNavigation current="contract_staff" available={await lifecycleWorkflowAvailability(session)}/><ContractWorkflowEditor {...workspace} directories={directories}/></main>;}
