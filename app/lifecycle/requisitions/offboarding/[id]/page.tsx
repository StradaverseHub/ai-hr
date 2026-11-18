import {notFound} from 'next/navigation';
import {requireModule} from '@/lib/authz';
import {offboardingRequisition} from '@/packs/lifecycle/service';
import {V9Error} from '@/lib/lifecycle-v9-model';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {OffboardingRequisitionView} from './view';
import '../../../v9/workspace.css';
export default async function Page({params}:{params:Promise<{id:string}>}){
 const {id}=await params;if(!/^[0-9a-f-]{36}$/i.test(id))notFound();
 const detail=await offboardingRequisition(await requireModule('lifecycle'),id).catch(error=>{if(error instanceof V9Error&&['not_found','forbidden'].includes(error.code))notFound();throw error;});
 return <OffboardingRequisitionView initial={detail} today={todayInKualaLumpur()}/>;
}
