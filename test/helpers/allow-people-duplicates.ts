/** Board 0735d1b7 fixtures: duplicate logins of one person need two Personnel records sharing an NRIC or a work email,
 * which People General Settings refuse by default (migrations 0594 and 0668). Turn both allowances on for a test
 * tenant, as an administrator would on People > Settings > General, through the owner-only policy row. */
import {sql} from 'drizzle-orm';
import {owner} from '../harness';

export async function allowPeopleDuplicates(tenantId:string){
 await owner.db.execute(sql`insert into people_general_policy(tenant_id,allow_duplicated_nric,allow_duplicated_email) values(${tenantId}::uuid,true,true)
  on conflict(tenant_id) do update set allow_duplicated_nric=true,allow_duplicated_email=true,revision=gen_random_uuid()`);
}
