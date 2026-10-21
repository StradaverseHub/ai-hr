/** Own-employment selection shared by clock reads, commands, receipts and removal requests.
 * A selector is never authority: the salary-free owner repeats actual own active-login eligibility.
 */
import type {SessionContext} from '../db/client';
import {myEmployment,myOwnEmploymentSubjects} from './read';
export class OwnClockEmploymentUnavailableError extends Error{
 constructor(){super('No active employee profile');this.name='OwnClockEmploymentUnavailableError';}
}
export async function resolveOwnClockEmployment(ctx:SessionContext,selectedEmploymentId?:string):Promise<{employmentId:string}|null>{
 if(selectedEmploymentId!==undefined){
  if(!ctx.userId||!ctx.personId)return null;
  if(typeof selectedEmploymentId!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selectedEmploymentId))return null;
  const own=await myOwnEmploymentSubjects(ctx,{profileEdit:true});
  const selected=own.find(row=>row.employmentId===selectedEmploymentId);
  return selected?{employmentId:selected.employmentId}:null;
 }
 // Existing unselected clients retain their established legacy subject course.
 const legacy=await myEmployment(ctx);return legacy?{employmentId:legacy.employmentId}:null;
}
