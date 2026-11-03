import {PersonnelMovementPage} from '../../movement-page';
export default async function Page({params,searchParams}:{params:Promise<{employmentId:string;mode:string;movementId:string}>;searchParams:Promise<Record<string,string|undefined>>}){
 return PersonnelMovementPage({...await params,search:await searchParams});
}
