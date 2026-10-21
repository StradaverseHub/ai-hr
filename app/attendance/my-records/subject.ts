import type {SessionContext} from '@/db/client';
import {myEmployment,myOwnEmploymentSubjects} from '@/core/read';

/** An explicit selector must resolve to this login's active own employment. Invalid, empty and
 * repeated selectors never fall back to the legacy first employment. */
export async function ownAttendanceRecordSubject(ctx:SessionContext,selector:string|string[]|undefined){
 if(selector===undefined)return myEmployment(ctx);
 if(!ctx.userId||!ctx.personId||typeof selector!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selector))return null;
 const own=(await myOwnEmploymentSubjects(ctx,{profileEdit:true})).find(row=>row.employmentId===selector);
 return own?{employmentId:own.employmentId,name:own.personName}:null;
}
