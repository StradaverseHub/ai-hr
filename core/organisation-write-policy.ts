/** Publication is a global authoring boundary; effective history remains date-specific.
 * Historical replacement carries its stored fact. A newly keyed backdated hire has no fact
 * to carry and therefore cannot invent a Business Unit before a reviewed mapping applies. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
export async function organisationManagedTx(tx:Tx):Promise<boolean>{
 const [row]=await tx.execute<{managed:boolean}>(sql`select app.company_organisation_managed() as managed`);return row?.managed===true;
}
export function organisationBusinessUnit(tags:{status:string;businessUnitId:string|null},managed:boolean,submitted:string|null|undefined,retained:string|null=null):string|null{
 return !managed&&tags.status==='legacy'?(submitted===undefined?retained:submitted):tags.status==='legacy'?retained:tags.businessUnitId;
}
