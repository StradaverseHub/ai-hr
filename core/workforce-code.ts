/** Bounded identifier command: no HR-role fabrication or shared employment-row grant. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {requireEmployeeCode} from '../lib/employee-code';
import {pgErrorChain,pgSqlState} from '../lib/db-error';
import {WorkforceAccessError} from './workforce-access';

export class WorkforceRecordChangedError extends Error {
 constructor(){super('Employee record changed. Reopen it before saving.');this.name='WorkforceRecordChangedError';}
}
export class WorkforceCodeValidationError extends Error {
 constructor(message:string){super(message);this.name='WorkforceCodeValidationError';}
}
export async function setWorkforceEmployeeCode(ctx:SessionContext,p:{employmentId:string;employeeCode:string;expectedCode?:string|null},outerTx?:Tx){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};p=structuredClone(p);
 let code:string;
 try{code=requireEmployeeCode(p.employeeCode);}catch(error){throw new WorkforceCodeValidationError(error instanceof Error?error.message:'Employee ID invalid');}
 try{
  const run=async(tx:Tx)=>{
   const expected=p.expectedCode===undefined?null:JSON.stringify(p.expectedCode);
   const [row]=await tx.execute<{changed:boolean}>(sql`select app.access_workforce_set_employee_code(${p.employmentId}::uuid,${code},${expected}::jsonb) as changed`);
   if(!row||typeof row.changed!=='boolean')throw new Error('Employee ID command result unavailable');
   return {id:p.employmentId,changed:row.changed};
  };return outerTx?await run(outerTx):await withTenant(ctx,run);
 }catch(error){
  if(pgSqlState(error)==='42501')throw new WorkforceAccessError();
  if(pgSqlState(error)==='40001')throw new WorkforceRecordChangedError();
  if(pgSqlState(error)==='23505'){
   if(pgErrorChain(error).some(link=>link.message==='employee_code_claim_draft'))throw new WorkforceCodeValidationError(`Employee ID "${code}" is reserved by a draft employee record`);
   throw new WorkforceCodeValidationError(`Employee ID "${code}" is already in use`);
  }
  throw error;
 }
}
