import {notFound} from 'next/navigation';
import {requireAdmin} from '@/lib/authz';
import EmployeePage from '../page';

/** Reuse the profile's scoped loader and exact form/view renderer. This flag selects composition only;
 * all workforce, admin and per-event capabilities are checked by the shared loader and service. */
export async function PersonnelMovementPage({employmentId,mode,movementId,search}:{employmentId:string;mode:string;movementId?:string;search:Record<string,string|undefined>}){
 await requireAdmin();
 if(!['new','correct-hire','edit','view'].includes(mode)||(mode==='edit'||mode==='view')!==!!movementId)notFound();
 const action=mode==='new'?{newEvent:'1'}:mode==='correct-hire'?{correctHire:'1'}:mode==='edit'?{editMovement:movementId}:{movement:movementId};
 return EmployeePage({params:Promise.resolve({employmentId}),searchParams:Promise.resolve({tab:'careerMovement',movementPage:mode,showCorrected:search.showCorrected==='1'?'1':undefined,from:search.from==='org'?'org':undefined,...action})});
}
