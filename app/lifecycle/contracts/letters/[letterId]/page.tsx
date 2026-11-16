import {notFound,redirect} from 'next/navigation';
import {ZodError} from 'zod';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {readContractSharedLetter,renderContractSharedLetter} from '@/packs/contracts/service';
import {ContractManagementError} from '@/lib/contract-management-model';
import {SharedLetterPage} from './review';
import '../../../v9/workspace.css';
import '../../shared-contract.css';
export default async function Page({params}:{params:Promise<{letterId:string}>}){
 const session=await requireScopedLifecycleModule();if(!session)redirect('/login');
 try{const letter=await readContractSharedLetter(session,(await params).letterId);return <main className="v9-workspace contract-portal"><SharedLetterPage letter={letter} document={renderContractSharedLetter(letter)}/></main>;}
 catch(error){if(error instanceof ZodError||error instanceof ContractManagementError&&error.code==='forbidden')notFound();throw error;}
}
