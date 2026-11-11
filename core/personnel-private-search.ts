import {serviceYearsMonthsDaysAt} from '../packs/leave/service';
import {matchesPersonnelColumnFilters,normalizePersonnelPrivateCriteria,type PersonnelPrivateCriteria,type PersonnelColumnFilter} from '../lib/personnel-list-controls';
import {deriveEmploymentStatus} from './employment-status';
import {foldEmployeeCode,matchesEmployeeSearch} from '../lib/employee-search';
import {todayInKualaLumpur} from '../lib/hr-date';
/** Five-minute principal-bound private filters. Criteria stay in the protected row, never URLs or logs. */
import {createHash,randomBytes} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {boundPersonnelStatementWithProbeTx,withPersonnelRead} from './personnel-read-bounds';
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
export const privateSearchHash=(token:string)=>TOKEN.test(token)?createHash('sha256').update(token).digest('hex'):null;
export class PersonnelSearchLimitError extends Error{constructor(){super('Narrow the top company scope before searching this many records.');}}
type SearchRow={employmentId:string;companyId:string;name:string;email:string;employeeCode:string|null;personRevision:string;employmentRevision:string;identityRevision:string|null;icNumber:string|null;passportNumber:string|null};
/** Migration 5092's candidate reader: app.personnel_search_rows, its bounded population count, and only the rows the
 * criteria below may match (db/migrations/5092_personnel_search_set_mapping.sql), with the 5020 resolver it reads. */
const SEARCH_CANDIDATES=['app.personnel_search_candidates(uuid[],boolean,boolean,text,text,text,text,text[])','app._personnel_employment_tags(uuid[],date)'];
/** The database narrows by ASCII lower case (A-Z to a-z). JavaScript's toLowerCase always lowers ASCII that way;
 * toLocaleLowerCase does too unless the process locale has its own I/i rule (Turkish, Azeri). There every row is
 * still confirmed here, as before. */
const ASCII_UPPER='ABCDEFGHIJKLMNOPQRSTUVWXYZ',ASCII_LOWER='abcdefghijklmnopqrstuvwxyz';
const ASCII_CASE_EXACT=ASCII_UPPER.toLowerCase()===ASCII_LOWER&&ASCII_UPPER.toLocaleLowerCase()===ASCII_LOWER;
async function privateCriteriaTx(tx:Tx,token:string,companyIds:string[]):Promise<PersonnelPrivateCriteria|null>{
 const criteria=personnelPrivateCriteriaSql(token,companyIds);if(!criteria)return null;
 const [row]=await tx.execute<{criteria:unknown}>(sql`select ${criteria} as criteria`);
 return personnelPrivateCriteriaFrom(row?.criteria);
}
/** The sole criteria read seam as a scalar expression, for a reader that selects it in a statement it
 * already spends in the same snapshot. Null when the token cannot name a private search. */
export function personnelPrivateCriteriaSql(token:string,companyIds:string[]){
 const hash=privateSearchHash(token);if(!hash)return null;
 return sql`app.personnel_column_search_criteria(${hash},ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`;
}
export function personnelPrivateCriteriaFrom(raw:unknown):PersonnelPrivateCriteria|null{
 if(!raw)return null;try{return normalizePersonnelPrivateCriteria(raw);}catch{return null;}
}
export function readPersonnelPrivateCriteria(ctx:SessionContext,token:string,companyIds:string[]):Promise<PersonnelPrivateCriteria|null>{return withPersonnelRead(ctx,tx=>privateCriteriaTx(tx,token,companyIds));}
export async function createPersonnelPrivateSearch(ctx:SessionContext,p:{text:string;companyIds:string[];columnFilters?:PersonnelColumnFilter[];previousToken?:string;replaceCriteria?:boolean}):Promise<string>{
 if(p.companyIds.length>1000||!ctx.userId)throw new PersonnelSearchLimitError();
 return withTenant(ctx,async tx=>{
  const narrowed=await boundPersonnelStatementWithProbeTx(tx,SEARCH_CANDIDATES);
  const prior=p.previousToken&&!p.replaceCriteria?await privateCriteriaTx(tx,p.previousToken,p.companyIds):null;
  if(p.previousToken&&!p.replaceCriteria&&!prior)throw new Error('Private filters expired. Apply the complete filters again.');
  const byField=new Map((prior?.filters??[]).map(filter=>[filter.field,filter]));for(const filter of p.columnFilters??[])byField.set(filter.field,filter);
  const criteria=normalizePersonnelPrivateCriteria({term:p.text.trim()||(!p.replaceCriteria?prior?.term:'')||'',filters:[...byField.values()]});
  if(!criteria.term&&!criteria.filters.length)throw new Error('Private filters unavailable.');
  const needle=criteria.term.toLocaleLowerCase(),filters=criteria.filters;
 // The native NRIC owner stores twelve digits. Only a complete plausible NRIC gains
 // separator normalization; letters/punctuation and literal passport/public matching do not.
 const nricNeedle=/^[0-9]{6}[ -]?[0-9]{2}[ -]?[0-9]{4}$/.test(needle)?needle.replace(/[ -]/g,''):null;
  const scope=sql`ARRAY[${sql.join(p.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
  // The authorised population, counted in the database, and only the rows the criteria may match: the database
  // excludes a row only when the rules below would (exact for ASCII text; any other text is kept and decided
  // here). Every kept row is still decided by the code below, unchanged.
  const identityFilters=filters.filter(f=>f.field==='identity');
  const raw=criteria.term.trim().toLowerCase(),termOpen=!needle||!raw;
  const candidates=narrowed?await tx.execute<{population:number;row:SearchRow|null}>(sql`select population,value as row from app.personnel_search_candidates(${scope},
    ${!ASCII_CASE_EXACT||termOpen&&!identityFilters.length}::boolean,${identityFilters.some(f=>f.operator!=='contains')}::boolean,
    ${raw}::text,${foldEmployeeCode(criteria.term)}::text,${termOpen?null:needle}::text,${nricNeedle}::text,
    ARRAY[${sql.join(identityFilters.map(f=>sql`${f.value.toLocaleLowerCase()}::text`),sql`, `)}]::text[]) as search_row(population,value)`)
   :(await tx.execute<{row:SearchRow}>(sql`select value as row from app.personnel_search_rows(${scope}) as search_row(value) limit 100001`)).map((row,_,rows)=>({population:rows.length,row:row.row}));
  const population=candidates[0]?.population??0;
  if(population>100000)throw new PersonnelSearchLimitError();
  const source=candidates.flatMap(({row})=>row?[{row}]:[]);
  // Re-evaluate the COMPLETE criteria against the authorised population. Prior result membership
  // is deliberately not intersected: replacing Company A with Company B must broaden correctly.
  // The list owner still reads (and bounds) the whole population; only the kept rows' fields leave the database.
  const kept=source.length===population?null:JSON.stringify(source.map(({row})=>row.employmentId));
  const structured=filters.length?(await tx.execute<{population:number;row:Record<string,unknown>|null}>(kept===null
   ?sql`select value as row from app.personnel_list_rows(${todayInKualaLumpur()}::date,${scope}) as filtered(value) limit 100001`
   :sql`with listed as materialized (select value from app.personnel_list_rows(${todayInKualaLumpur()}::date,${scope}) as filtered(value) limit 100001)
    select (select count(*)::integer from listed) as population,listed.value as row from (select 1) as one
    left join listed on listed.value->>'employmentId' in (select jsonb_array_elements_text(${kept}::jsonb))`))
   .map((row,_,rows)=>({population:kept===null?rows.length:row.population,row:row.row})):[];
  if((structured[0]?.population??0)>100000)throw new PersonnelSearchLimitError();
  const service=(from:unknown)=>{if(typeof from!=='string')return null;const length=serviceYearsMonthsDaysAt(from,todayInKualaLumpur());return `${length.years}y ${length.months}m ${length.days}d`;};
  const byId=new Map<string,Record<string,unknown>>(structured.flatMap(({row})=>row?[row]:[]).map(row=>[String(row.employmentId),{...row,groupService:service(row.hiredOn),companyService:service(row.joinDate??row.hiredOn),yearOfService:service(row.joinDate??row.hiredOn),status:deriveEmploymentStatus(row as unknown as Parameters<typeof deriveEmploymentStatus>[0],todayInKualaLumpur())}]));
  const matches=source.flatMap(({row})=>{
   const fields=byId.get(row.employmentId);
   if(filters.length&&(!fields||!matchesPersonnelColumnFilters(fields,filters.filter(f=>f.field!=='identity'))))return [];
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

export async function personnelPrivateSearchAvailable(ctx:SessionContext,token:string,companyIds:string[]):Promise<boolean>{
 const hash=privateSearchHash(token);if(!hash)return false;
 return withTenant(ctx,async tx=>{const [row]=await tx.execute<{available:boolean}>(sql`select exists(select 1 from personnel_private_search where token_hash=${hash} and tenant_id=app.current_tenant_id() and actor_id=app.current_user_id() and expires_at>now() and scope_ids @> ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[] and scope_ids <@ ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[] and app.principal_snapshot_current()) as available`);return row?.available===true;});
}
