import {z} from 'zod';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {listContractSharedPostings} from '@/packs/contracts/service';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {ContractPostingsWorkspace} from './postings-workspace';
import '../../v9/workspace.css';
import '../shared-contract.css';
import './postings.css';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const session=await requireScopedLifecycleModule(),query=await searchParams;
 const text=(key:string)=>typeof query[key]==='string'?query[key] as string:undefined;
 const status=z.enum(['pending','approved','all']).catch('pending').parse(text('status'));
 const companyId=z.uuid().safeParse(text('companyId')).success?text('companyId'):undefined;
 const offset=Math.min(100000,Math.max(0,Number.parseInt(text('offset')??'0',10)||0));
 const page=await listContractSharedPostings(session,{status,companyId,offset,limit:50});
 return <main className="v9-workspace"><ContractPostingsWorkspace page={page} status={status} companyId={companyId} today={todayInKualaLumpur()} error={text('error')} saved={text('saved')}/></main>;
}
