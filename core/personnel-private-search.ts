import {serviceYearsMonthsDaysAt} from '../packs/leave/service';
import {matchesPersonnelColumnFilters,type PersonnelColumnFilter} from '../lib/personnel-list-controls';
import {deriveEmploymentStatus} from './employment-status';
import {todayInKualaLumpur} from '../lib/hr-date';
/** A five-minute principal-bound search result. Search text is never persisted, returned or audited. */
import {createHash,randomBytes} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {withPersonnelRead} from './personnel-read-bounds';
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
export const privateSearchHash=(token:string)=>TOKEN.test(token)?createHash('sha256').update(token).digest('hex'):null;
export class PersonnelSearchLimitError extends Error{constructor(){super('Narrow the top company scope before searching this many records.');}}
type SearchRow={employmentId:string;companyId:string;name:string;email:string;employeeCode:string|null;personRevision:string;employmentRevision:string;identityRevision:string|null;icNumber:string|null;passportNumber:string|null};
export async function createPersonnelPrivateSearch(ctx:SessionContext,p:{text:string;companyIds:string[];columnFilters?:PersonnelColumnFilter[];previousToken?:string}):Promise<string>{
 if(p.companyIds.length>1000)throw new PersonnelSearchLimitError();
 const needle=p.text.trim().toLocaleLowerCase();if((!needle&&!p.columnFilters?.length)||needle.length>200||!ctx.userId)throw new Error('Search unavailable.');
 // The native NRIC owner stores twelve digits. Only a complete plausible NRIC gains
 // separator normalization; letters/punctuation and literal passport/public matching do not.
 const nricNeedle=/^[0-9]{6}[ -]?[0-9]{2}[ -]?[0-9]{4}$/.test(needle)?needle.replace(/[ -]/g,''):null;
 return withPersonnelRead(ctx,async tx=>{
  const source=await tx.execute<{row:SearchRow}>(sql`select value as row from app.personnel_search_rows(ARRAY[${sql.join(p.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) as search_row(value) limit 100001`);
  if(source.length>100000)throw new PersonnelSearchLimitError();
  const structured=p.columnFilters?.length||p.previousToken?await tx.execute<{row:Record<string,unknown>}>(sql`select value||jsonb_build_object('priorIdentity',${p.previousToken?sql`app.personnel_column_search_identity(${privateSearchHash(p.previousToken)??''},(value->>'employmentId')::uuid)`:sql`false`}) as row from app.personnel_list_rows(${todayInKualaLumpur()}::date,ARRAY[${sql.join(p.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) as filtered(value) ${p.previousToken?sql`where app.personnel_column_search_matches(${privateSearchHash(p.previousToken)??''},(value->>'employmentId')::uuid,(value->>'companyId')::uuid,ARRAY[${sql.join(p.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[],value->>'filterRevision')`:sql``} limit 100001`):[];
  if(structured.length>100000)throw new PersonnelSearchLimitError();
  const service=(from:unknown)=>{if(typeof from!=='string')return null;const length=serviceYearsMonthsDaysAt(from,todayInKualaLumpur());return `${length.years}y ${length.months}m ${length.days}d`;};
  const byId=new Map<string,Record<string,unknown>>(structured.map(({row})=>[String(row.employmentId),{...row,groupService:service(row.hiredOn),companyService:service(row.joinDate??row.hiredOn),yearOfService:service(row.joinDate??row.hiredOn),status:deriveEmploymentStatus(row as unknown as Parameters<typeof deriveEmploymentStatus>[0],todayInKualaLumpur())}]));
  const matches=source.flatMap(({row})=>{
   const fields=byId.get(row.employmentId);
   if((p.columnFilters?.length||p.previousToken)&&(!fields||!matchesPersonnelColumnFilters(fields,(p.columnFilters??[]).filter(f=>f.field!=='identity'))))return [];
   const identityFilters=p.columnFilters?.filter(f=>f.field==='identity')??[];
   const permittedIdentityMatch=(text:string)=>!!(row.icNumber?.toLocaleLowerCase().includes(text.toLocaleLowerCase())||row.passportNumber?.toLocaleLowerCase().includes(text.toLocaleLowerCase()));
   if(identityFilters.length&&!identityFilters.every(f=>f.operator==='contains'&&permittedIdentityMatch(f.value)))return [];
   const publicMatch=[row.name,row.email,row.employeeCode].some(value=>value?.toLocaleLowerCase().includes(needle));
   const identityMatch=!!needle&&!!(row.icNumber?.toLocaleLowerCase().includes(needle)||nricNeedle&&row.icNumber===nricNeedle||row.passportNumber?.toLocaleLowerCase().includes(needle));
   return (!needle||publicMatch||identityMatch)?[{employmentId:row.employmentId,kind:identityFilters.length||fields?.priorIdentity===true?'identity':!needle||publicMatch?'public':'identity',personRevision:row.personRevision,employmentRevision:row.employmentRevision,identityRevision:identityMatch||identityFilters.length||fields?.priorIdentity===true?row.identityRevision:null,...(fields?{filterRevision:fields.filterRevision}:{})}]:[];
  });
  const token=randomBytes(32).toString('base64url'),hash=privateSearchHash(token)!;
  // The insert trigger serializes and prunes tokens for this actor.
  await tx.execute(sql`insert into personnel_private_search(token_hash,tenant_id,actor_id,scope_ids,matches) values(${hash},${ctx.tenantId}::uuid,${ctx.userId}::uuid,ARRAY[${sql.join(p.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[],${JSON.stringify(matches)}::jsonb)`);
  return token;
 });
}

export async function personnelPrivateSearchAvailable(ctx:SessionContext,token:string,companyIds:string[]):Promise<boolean>{
 const hash=privateSearchHash(token);if(!hash)return false;
 return withTenant(ctx,async tx=>{const [row]=await tx.execute<{available:boolean}>(sql`select exists(select 1 from personnel_private_search where token_hash=${hash} and tenant_id=app.current_tenant_id() and actor_id=app.current_user_id() and expires_at>now() and scope_ids @> ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[] and scope_ids <@ ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[] and app.principal_snapshot_current()) as available`);return row?.available===true;});
}
