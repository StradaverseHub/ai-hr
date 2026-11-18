/** Shared organisation readiness: legacy records retain their established grouping until reviewed publication. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {normalizeFullName,namesHeldByMultiplePersons} from './duplicate-person';
export const PERSONNEL_QUALITY_FLAGS=['missing_business_unit','missing_job_grade','missing_direct_superior','company_not_in_structure','suspected_duplicate'] as const;
export type PersonnelQualityFlag=typeof PERSONNEL_QUALITY_FLAGS[number];
export type PersonnelGroupingReadiness={employmentId:string;companyId:string;ready:boolean;reason:'company_not_in_structure'|'missing_business_unit'|null};
export async function personnelGroupingReadinessTx(tx:Tx,_ctx:SessionContext,p:{employmentIds:string[];asOf:string}):Promise<PersonnelGroupingReadiness[]>{
 if(!p.employmentIds.length)return [];if(p.employmentIds.length>100000)throw new Error('Organisation grouping scope is too large.');
 const rows=await tx.execute<{employmentId:string;tags:{companyId:string;status:string;businessUnitId:string|null;reason:string|null}}>(sql`select id::text as "employmentId",app.employment_organisation_tags(id,${p.asOf}::date) as tags from unnest(ARRAY[${sql.join(p.employmentIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) id`);
 if(rows.some(row=>!row.tags||!row.tags.companyId||!['legacy','ready','pending'].includes(row.tags.status)))throw new Error('Organisation grouping authority unavailable.');
 return rows.map(row=>({employmentId:row.employmentId,companyId:row.tags.companyId,ready:row.tags.status!=='pending',reason:row.tags.status==='pending'?(row.tags.reason==='missing_business_unit'?'missing_business_unit':'company_not_in_structure'):null}));
}
/** Same name normalization/person distinction as the existing duplicate-person owner, with the same hire-date partition. */
export function visibleDuplicateEmploymentIds(rows:readonly {employmentId:string;personId:string;fullName:string;hiredOn:string}[]):Set<string>{
 const names=namesHeldByMultiplePersons(rows),groups=new Map<string,typeof rows[number][]>();
 for(const row of rows){if(!names.has(normalizeFullName(row.fullName)))continue;const key=normalizeFullName(row.fullName)+'\u0000'+row.hiredOn;groups.set(key,[...(groups.get(key)??[]),row]);}
 return new Set([...groups.values()].filter(group=>new Set(group.map(row=>row.personId)).size>1).flatMap(group=>group.map(row=>row.employmentId)));
}

export async function personnelDataQualityTx(tx:Tx,_ctx:SessionContext,p:{employmentIds:string[];asOf:string}){
 if(!p.employmentIds.length)return [];
 return tx.execute<{employmentId:string;quality:{companyId:string;taggingStatus:'legacy'|'ready'|'pending';reason:string|null;flags:Record<Exclude<PersonnelQualityFlag,'suspected_duplicate'>,boolean>}}>(sql`select id::text as "employmentId",app.employment_organisation_quality(id,${p.asOf}::date) quality from unnest(ARRAY[${sql.join(p.employmentIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) id`);
}

/** Full authorized evidence set, before the listing's local filters/pagination. Never substitute a SQL case-fold. */
export async function personnelDuplicateIdsTx(tx:Tx,_ctx:SessionContext,p:{companyIds?:string[];asOf:string}):Promise<string[]>{
 const rows=await tx.execute<{employmentId:string;personId:string;fullName:string;hiredOn:string}>(sql`select * from app.personnel_duplicate_candidate_rows(${p.companyIds?sql`ARRAY[${sql.join(p.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`:sql`null::uuid[]`},${p.asOf}::date) limit 100001`);
 if(rows.length>100000)throw new RangeError('Narrow the top company scope before reviewing this many duplicate candidates.');
 return [...visibleDuplicateEmploymentIds(rows)];
}
