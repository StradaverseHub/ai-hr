import {redirect} from 'next/navigation';
import {z} from 'zod';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {contractSharedTracker,contractSharedWaiting,type ContractTrackerQuery} from '@/packs/contracts/service';
import {SharedContractTracker} from './shared-tracker';
import '../v9/workspace.css';
import './shared-contract.css';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const session=await requireScopedLifecycleModule();if(!session)redirect('/login');
 const params=await searchParams,read=(key:string)=>typeof params[key]==='string'?params[key] as string:undefined;
 const status=z.enum(['all','attention','upcoming','decision','progress','closed']).catch('all').parse(read('status'));
 const query:ContractTrackerQuery={attention:read('attention')==='true',search:(read('search')??'').slice(0,100),status,companyId:z.uuid().safeParse(read('companyId')).success?read('companyId'):null,offset:Math.min(100000,Math.max(0,Number.parseInt(read('offset')??'0',10)||0)),limit:50};
 const page=await contractSharedTracker(session,query),waiting=await contractSharedWaiting(session,page.rows.flatMap(row=>row.caseId?[row.caseId]:[]));
 return <main className="v9-workspace"><SharedContractTracker page={page} waiting={waiting} query={query}/></main>;
}
