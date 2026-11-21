import {eq} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {employment,employeeStatutoryMy} from '../db/schema';

/** Serialize the existing person statutory owner before employment changes take row locks.
 * Employment identity is immutable; tenant RLS scopes both reads. An absent profile needs no lock. */
export async function lockEmploymentStatutoryOwnerTx(tx:Tx,employmentId:string){
 const [identity]=await tx.select({personId:employment.personId}).from(employment).where(eq(employment.id,employmentId)).limit(1);
 if(identity)await tx.select({id:employeeStatutoryMy.id}).from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,identity.personId)).limit(1).for('update');
}
