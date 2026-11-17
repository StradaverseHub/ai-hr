/** Movement destination navigation only. Native catalogue RLS/Criteria remain the availability owners. */
import {inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {withIdempotentDatabaseRead} from '../db/workload';
import {company} from '../db/schema';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';
import {listDepartments} from './read';
import {listBusinessUnits,listPositions} from './admin';
import {listLocations} from './location';
import {labelsInCompanyScope} from '../lib/system-label-scope';
import {organisationChoiceLabels} from '../lib/organisation-choice-label';
export type MovementOrganisationChoices={
 departments:{id:string;name:string}[];positions:{id:string;name:string}[];
 businessUnits:{id:string;name:string}[];locations:{id:string;name:string}[];
};
export function movementOrganisationChoices(ctx:SessionContext,companyIds:readonly string[]):Promise<Map<string,MovementOrganisationChoices>>{
 const ids=[...new Set(companyIds)];if(!ids.length)return Promise.resolve(new Map());
 return withIdempotentDatabaseRead(()=>withTenant(ctx,async tx=>{
  await tx.execute(sql`set transaction read only`);
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const visibleCompanies=await tx.select({id:company.id}).from(company).where(inArray(company.id,ids));
  const departments=await listDepartments(ctx,{companyIds:ids,usage:false},tx);
  const positions=await listPositions(ctx,{companyIds:ids},tx);
  const businessUnits=await listBusinessUnits(ctx,{companyIds:ids},tx);
  const locations=await listLocations(ctx,ids,{},tx);
  const key=(id:string)=>id.replace(/[{}-]/g,'').toLowerCase();
  const visible=new Map(visibleCompanies.map(row=>[key(row.id),row.id]));
  return new Map(ids.map(id=>{
   // The singleton Criteria predicate first requires THIS company to be visible. A union query's
   // visible neighbour must not make Global labels available for an invisible/unknown company.
   const nativeId=visible.get(key(id)),scope=new Set(nativeId?[nativeId]:[]);
   return [id,{
    departments:organisationChoiceLabels(labelsInCompanyScope(departments,scope)).map(row=>({id:row.id,name:row.displayLabel})),
    positions:organisationChoiceLabels(labelsInCompanyScope(positions,scope)).map(row=>({id:row.id,name:row.displayLabel})),
    businessUnits:organisationChoiceLabels(labelsInCompanyScope(businessUnits,scope)).map(row=>({id:row.id,name:row.displayLabel})),
    locations:locations.filter(row=>row.companyId===nativeId).map(row=>({id:row.id,name:`${row.name} (${row.code})`})),
   }] as const;
  }));
 }));
}
