/** Exact request projection. This module never widens general Personnel queries. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import type {person,employeeStatutoryMy,employeeDependent,employeeQualification,personEmergencyContact} from '../db/schema';
export type ProfileTaskSource={owners:string[];subject:{id:string;personId:string;companyId:string;country:string|null};master:typeof person.$inferSelect;stat:typeof employeeStatutoryMy.$inferSelect|null;snapshot:{rowId:string;revision:string;profile:typeof employeeStatutoryMy.$inferSelect}|null;dependents:{record:typeof employeeDependent.$inferSelect;revision:string}[];qualifications:(typeof employeeQualification.$inferSelect)[];emergency:(typeof personEmergencyContact.$inferSelect)[]};
export async function profileTaskProjectionTx(tx:Tx,requestId:string,prepare=false){const [row]=await tx.execute<{value:ProfileTaskSource}>(sql`select app.profile_task_projection(${requestId}::uuid,${prepare}) as value`);if(!row?.value)throw Error('Profile task unavailable');return row.value;}
export async function profileTaskEffectSourceTx(tx:Tx,personId?:string,employmentId?:string){const [row]=await tx.execute<{value:ProfileTaskSource|null}>(sql`select app.profile_task_effect_source(${personId??null}::uuid,${employmentId??null}::uuid) as value`);return row?.value??null;}
export async function profileTaskStorePersonTx(tx:Tx,personId:string,values:Record<string,unknown>){const [row]=await tx.execute<{stored:boolean}>(sql`select app.profile_task_store_person(${personId}::uuid,${JSON.stringify(values)}::jsonb) as stored`);return row?.stored===true;}

export async function profileTaskStoreStatutoryTx(tx:Tx,personId:string,values:Record<string,unknown>){const [row]=await tx.execute<{id:string|null}>(sql`select app.profile_task_store_statutory(${personId}::uuid,${JSON.stringify(values)}::jsonb) as id`);return row?.id??null;}
