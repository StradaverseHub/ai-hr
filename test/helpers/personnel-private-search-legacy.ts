/** The Personnel private search creation exactly as release f7ee5177 shipped it (core/personnel-private-search.ts
 * before migration 5092), kept verbatim as the equivalence oracle: it reads every authorised search row and every
 * list row into Node and matches there. Only its name and imports differ. Never used by the application. */
import {serviceYearsMonthsDaysAt} from '../../packs/leave/service';
import {matchesPersonnelColumnFilters,normalizePersonnelPrivateCriteria,type PersonnelPrivateCriteria,type PersonnelColumnFilter} from '../../lib/personnel-list-controls';
import {deriveEmploymentStatus} from '../../core/employment-status';
import {matchesEmployeeSearch} from '../../lib/employee-search';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {randomBytes} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {boundPersonnelStatementTx} from '../../core/personnel-read-bounds';
import {PersonnelSearchLimitError,personnelPrivateCriteriaFrom,personnelPrivateCriteriaSql,privateSearchHash} from '../../core/personnel-private-search';
type SearchRow={employmentId:string;companyId:string;name:string;email:string;employeeCode:string|null;personRevision:string;employmentRevision:string;identityRevision:string|null;icNumber:string|null;passportNumber:string|null};
async function privateCriteriaTx(tx:Tx,token:string,companyIds:string[]):Promise<PersonnelPrivateCriteria|null>{
 const criteria=personnelPrivateCriteriaSql(token,companyIds);if(!criteria)return null;
 const [row]=await tx.execute<{criteria:unknown}>(sql`select ${criteria} as criteria`);
 return personnelPrivateCriteriaFrom(row?.criteria);
}
export async function legacyCreatePersonnelPrivateSearch(ctx:SessionContext,p:{text:string;companyIds:string[];columnFilters?:PersonnelColumnFilter[];previousToken?:string;replaceCriteria?:boolean}):Promise<string>{
 if(p.companyIds.length>1000||!ctx.userId)throw new PersonnelSearchLimitError();
 return withTenant(ctx,async tx=>{
  await boundPersonnelStatementTx(tx);
  const prior=p.previousToken&&!p.replaceCriteria?await privateCriteriaTx(tx,p.previousToken,p.companyIds):null;
  if(p.previousToken&&!p.replaceCriteria&&!prior)throw new Error('Private filters expired. Apply the complete filters again.');
  const byField=new Map((prior?.filters??[]).map(filter=>[filter.field,filter]));for(const filter of p.columnFilters??[])byField.set(filter.field,filter);
  const criteria=normalizePersonnelPrivateCriteria({term:p.text.trim()||(!p.replaceCriteria?prior?.term:'')||'',filters:[...byField.values()]});
  if(!criteria.term&&!criteria.filters.length)throw new Error('Private filters unavailable.');
  const needle=criteria.term.toLocaleLowerCase(),filters=criteria.filters;
 // The native NRIC owner stores twelve digits. Only a complete plausible NRIC gains
 // separator normalization; letters/punctuation and literal passport/public matching do not.
 const nricNeedle=/^[0-9]{6}[ -]?[0-9]{2}[ -]?[0-9]{4}$/.test(needle)?needle.replace(/[ -]/g,''):null;
  const source=await tx.execute<{row:SearchRow}>(sql`select value as row from app.personnel_search_rows(ARRAY[${sql.join(p.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) as search_row(value) limit 100001`);
  if(source.length>100000)throw new PersonnelSearchLimitError();
  // Re-evaluate the COMPLETE criteria against the authorised population. Prior result membership
  // is deliberately not intersected: replacing Company A with Company B must broaden correctly.
  const structured=filters.length?await tx.execute<{row:Record<string,unknown>}>(sql`select value as row from app.personnel_list_rows(${todayInKualaLumpur()}::date,ARRAY[${sql.join(p.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) as filtered(value) limit 100001`):[];
  if(structured.length>100000)throw new PersonnelSearchLimitError();
  const service=(from:unknown)=>{if(typeof from!=='string')return null;const length=serviceYearsMonthsDaysAt(from,todayInKualaLumpur());return `${length.years}y ${length.months}m ${length.days}d`;};
  const byId=new Map<string,Record<string,unknown>>(structured.map(({row})=>[String(row.employmentId),{...row,groupService:service(row.hiredOn),companyService:service(row.joinDate??row.hiredOn),yearOfService:service(row.joinDate??row.hiredOn),status:deriveEmploymentStatus(row as unknown as Parameters<typeof deriveEmploymentStatus>[0],todayInKualaLumpur())}]));
  const matches=source.flatMap(({row})=>{
   const fields=byId.get(row.employmentId);
   if(filters.length&&(!fields||!matchesPersonnelColumnFilters(fields,filters.filter(f=>f.field!=='identity'))))return [];
   const identityFilters=filters.filter(f=>f.field==='identity');
   const permittedIdentityMatch=(text:string)=>!!(row.icNumber?.toLocaleLowerCase().includes(text.toLocaleLowerCase())||row.passportNumber?.toLocaleLowerCase().includes(text.toLocaleLowerCase()));
   if(identityFilters.length&&!identityFilters.every(f=>f.operator==='contains'&&permittedIdentityMatch(f.value)))return [];
   // eaa7697c: Employee ID and name use the ONE shared employee-search rule (case, spaces and dashes in an
   // Employee ID do not matter, so "emp0008" finds "EMP-0008"), exactly as the profile switcher does.
   // Work email stays a literal case-insensitive substring; identity matching below stays literal.
   const publicMatch=matchesEmployeeSearch({name:row.name??'',employeeCode:row.employeeCode},criteria.term)||!!row.email?.toLocaleLowerCase().includes(needle);
   const identityMatch=!!needle&&!!(row.icNumber?.toLocaleLowerCase().includes(needle)||nricNeedle&&row.icNumber===nricNeedle||row.passportNumber?.toLocaleLowerCase().includes(needle));
   return (!needle||publicMatch||identityMatch)?[{employmentId:row.employmentId,kind:identityFilters.length?'identity':!needle||publicMatch?'public':'identity',personRevision:row.personRevision,employmentRevision:row.employmentRevision,identityRevision:identityMatch||identityFilters.length?row.identityRevision:null,...(fields?{filterRevision:fields.filterRevision}:{})}]:[];
  });
  const token=randomBytes(32).toString('base64url'),hash=privateSearchHash(token)!;
  // The insert trigger serializes and prunes tokens for this actor.
  await tx.execute(sql`insert into personnel_private_search(token_hash,tenant_id,actor_id,scope_ids,matches,criteria) values(${hash},${ctx.tenantId}::uuid,${ctx.userId}::uuid,ARRAY[${sql.join(p.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[],${JSON.stringify(matches)}::jsonb,${JSON.stringify(criteria)}::jsonb)`);
  return token;
 });
}
