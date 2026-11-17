import {notFound,redirect} from 'next/navigation';
import {ZodError} from 'zod';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {readContractSharedApprovalReview} from '@/packs/contracts/service';
import {ContractManagementError} from '@/lib/contract-management-model';
import {SharedApprovalPage} from './review';
import '../../../v9/workspace.css';
import '../../shared-contract.css';
export default async function Page({params}:{params:Promise<{approvalId:string}>}){
 const session=await requireScopedLifecycleModule();if(!session)redirect('/login');
 try{const review=await readContractSharedApprovalReview(session,(await params).approvalId);return <main className="v9-workspace contract-portal"><SharedApprovalPage {...review}/></main>;}
 catch(error){if(error instanceof ZodError||error instanceof ContractManagementError&&error.code==='forbidden')notFound();throw error;}
}
