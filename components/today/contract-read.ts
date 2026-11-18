import type {SessionContext} from '@/db/client';
import {isModuleEnabledOrFalse} from '@/core/entitlements';
import {contractSharedWorkPage} from '@/packs/contracts/service';

type ContractWorkPage=Awaited<ReturnType<typeof contractSharedWorkPage>>;
export type TodayContractWork={status:'ready';page:ContractWorkPage}|{status:'disabled'}|{status:'unavailable'};
export function todayContractsEnabled(session:SessionContext){
 return isModuleEnabledOrFalse(session,'lifecycle')||!!session.entitlements?.scopedModules.lifecycle?.length;
}
/** One bounded owner read. The page shares this Promise with its card, count and all-clear gate. */
export async function readTodayContractWork(session:SessionContext):Promise<TodayContractWork>{
 if(!todayContractsEnabled(session))return {status:'disabled'};
 try{return {status:'ready',page:await contractSharedWorkPage(session,{category:'tasks',limit:5,offset:0})};}
 catch{return {status:'unavailable'};}
}
