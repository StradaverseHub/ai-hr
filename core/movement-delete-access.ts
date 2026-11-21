import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {withPersonnelRead} from './personnel-read-bounds';
import {assertWorkforceEmploymentTx,WorkforceAccessError} from './workforce-access';

/** Read-only presentation check; every command repeats it under the live Access barrier. */
export function movementDeleteAccess(ctx:SessionContext,employmentId:string){
 return withPersonnelRead(ctx,async tx=>{
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_movement_delete_employment(${employmentId}::uuid) as allowed`);
  return row?.allowed===true;
 });
}

/** Maintenance and Delete are separate permissions. Session role strings confer neither. */
export async function assertMovementDeleteTx(tx:Tx,ctx:SessionContext,employmentId:string){
 await assertWorkforceEmploymentTx(tx,ctx,employmentId,'maintain');
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_movement_delete_employment(${employmentId}::uuid) as allowed`);
 if(!row?.allowed)throw new WorkforceAccessError();
}
