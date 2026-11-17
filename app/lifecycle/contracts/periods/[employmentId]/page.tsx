import {notFound,redirect} from 'next/navigation';
import {ZodError} from 'zod';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {contractSharedPeriodContext} from '@/packs/contracts/service';
import {workforceEmploymentAccess} from '@/core/workforce-access';
import {ContractManagementError} from '@/lib/contract-management-model';
import {SharedContractPeriod} from './period';
import '../../../v9/workspace.css';
import '../../shared-contract.css';
export default async function Page({params}:{params:Promise<{employmentId:string}>}){
 const session=await requireScopedLifecycleModule();if(!session)redirect('/login');
 let period;
 try{period=await contractSharedPeriodContext(session,(await params).employmentId);}
 catch(error){if(error instanceof ZodError||error instanceof ContractManagementError&&error.code==='forbidden')notFound();throw error;}
 if(period.existingCaseId)redirect('/lifecycle/contracts/'+period.existingCaseId);
 const canOpenPersonnel=await workforceEmploymentAccess(session,period.employmentId,'view');
 return <main className="v9-workspace"><SharedContractPeriod period={period} canOpenPersonnel={canOpenPersonnel}/></main>;
}
