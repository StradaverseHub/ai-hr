import {notFound,redirect} from 'next/navigation';
import {ZodError} from 'zod';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {readContractSharedLetter,renderContractSharedLetter,contractSharedLetterActions,readContractSharedForm,readContractSharedReleaseProof} from '@/packs/contracts/service';
import {ContractManagementError} from '@/lib/contract-management-model';
import {SharedLetterPage} from './review';
import '../../../v9/workspace.css';
import '../../shared-contract.css';
export default async function Page({params}:{params:Promise<{letterId:string}>}){
 const session=await requireScopedLifecycleModule();if(!session)redirect('/login');
 try{const id=(await params).letterId,[letter,capabilities,form,releaseProof]=await Promise.all([readContractSharedLetter(session,id),contractSharedLetterActions(session,id),readContractSharedForm(session,id),readContractSharedReleaseProof(session,id)]);return <main className="v9-workspace contract-portal"><SharedLetterPage letter={letter} capabilities={capabilities} form={form} releaseProof={releaseProof} document={renderContractSharedLetter(letter)}/></main>;}
 catch(error){if(error instanceof ZodError||error instanceof ContractManagementError&&error.code==='forbidden')notFound();throw error;}
}
