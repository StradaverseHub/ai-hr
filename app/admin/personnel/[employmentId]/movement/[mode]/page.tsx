import {PersonnelMovementPage} from '../movement-page';
import {z} from 'zod';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {readContractSharedPosting} from '@/packs/contracts/service';
import {ContractPostingEditor} from '@/app/lifecycle/contracts/postings/posting-editor';
import '@/app/lifecycle/v9/workspace.css';
import '@/app/lifecycle/contracts/shared-contract.css';
import '@/app/lifecycle/contracts/postings/postings.css';
export default async function Page({params,searchParams}:{params:Promise<{employmentId:string;mode:string}>;searchParams:Promise<Record<string,string|undefined>>}){
 const route=await params,search=await searchParams;
 // A Contract posting is a fixed native command, not general Personnel maintenance. Its actual
 // current posting-group/tenant permissions are checked by the native reader and again by every action.
 if(route.mode==='new'&&z.uuid().safeParse(search.posting).success){
  const session=await requireScopedLifecycleModule(),posting=await readContractSharedPosting(session,search.posting!);
  if(posting&&posting.employmentId===route.employmentId)return <main className="v9-workspace"><ContractPostingEditor posting={posting}/></main>;
 }
 return PersonnelMovementPage({...route,search});
}
