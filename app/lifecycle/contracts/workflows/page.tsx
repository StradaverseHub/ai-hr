import {notFound,redirect} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {canConfigureContractWorkflows,contractWorkflowWorkspace} from '@/packs/contracts/service';
import {WorkflowModuleNavigation} from '../../workflow-module-navigation';
import {lifecycleWorkflowAvailability} from '../../workflow-availability';
import {ContractWorkflowEditor} from './editor';
import {searchContractReviewersAction} from './actions';
import '../../v9/workspace.css';
export default async function Page(){
 const session=await requireScopedLifecycleModule();
 if(!session)redirect('/login');
 if(!await canConfigureContractWorkflows(session))notFound();
 const [workspace,available]=await Promise.all([contractWorkflowWorkspace(session),lifecycleWorkflowAvailability(session)]);
 return (
  <main className="v9-workspace">
   <WorkflowModuleNavigation current="contract_staff" available={available}/>
   <ContractWorkflowEditor {...workspace} directories={[]} loadDirectory={searchContractReviewersAction}/>
  </main>
 );
}
