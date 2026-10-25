import type {SessionContext} from '@/db/client';
import {myEmployment,myOwnEmploymentSubjects} from '@/core/read';

/** Explicit self-service context is validated against the current active login, never its HR scope. */
export async function ownClaimSubject(ctx:SessionContext,selector:string|string[]|undefined):Promise<{employmentId:string;name:string;company?:string|null;employeeCode?:string|null}|null>{
 if(selector===undefined){const legacy=await myEmployment(ctx);return legacy?{employmentId:legacy.employmentId,name:legacy.name}:null;}
 if(!ctx.userId||!ctx.personId||typeof selector!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selector))return null;
 const own=(await myOwnEmploymentSubjects(ctx,{profileEdit:true})).find(row=>row.employmentId===selector);
 return own?{employmentId:own.employmentId,name:own.personName,company:own.company,employeeCode:own.employeeCode}:null;
}
export function claimFormSelector(data:FormData):string|string[]|undefined{
 const values=data.getAll('employmentId');
 return values.length===0?undefined:values.length===1&&typeof values[0]==='string'?values[0]:[];
}
