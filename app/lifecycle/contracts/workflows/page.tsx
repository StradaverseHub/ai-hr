import {notFound,redirect} from 'next/navigation';
import {getSession} from '@/lib/session';
import {canConfigureContractWorkflows,contractWorkflowWorkspace,contractDirectory} from '@/packs/contracts/service';
import {WorkflowModuleNavigation} from '../../workflow-module-navigation';
import {ContractWorkflowEditor} from './editor';
import '../../v9/workspace.css';
export default async function Page(){const session=await getSession();if(!session)redirect('/login');if(!await canConfigureContractWorkflows(session))notFound();const workspace=await contractWorkflowWorkspace(session);const directories=await Promise.all(workspace.companies.map(async company=>({companyId:company.id,users:await contractDirectory(session,company.id)})));return <main className="v9-workspace"><WorkflowModuleNavigation current="contract_staff" available={{contract_staff:true}}/><ContractWorkflowEditor {...workspace} directories={directories}/></main>;}
