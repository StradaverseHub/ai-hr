/** A five-minute principal-bound search result. Search text is never persisted, returned or audited. */
import {createHash,randomBytes} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {withPersonnelRead} from './personnel-read-bounds';
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
export const privateSearchHash=(token:string)=>TOKEN.test(token)?createHash('sha256').update(token).digest('hex'):null;
export class PersonnelSearchLimitError extends Error{constructor(){super('Narrow the top company scope before searching this many records.');}}
type SearchRow={employmentId:string;companyId:string;name:string;email:string;employeeCode:string|null;personRevision:string;employmentRevision:string;identityRevision:string|null;icNumber:string|null;passportNumber:string|null};
export async function createPersonnelPrivateSearch(ctx:SessionContext,p:{text:string;companyIds:string[]}):Promise<string>{
 if(p.companyIds.length>1000)throw new PersonnelSearchLimitError();
 const needle=p.text.trim().toLocaleLowerCase();if(!needle||needle.length>200||!ctx.userId)throw new Error('Search unavailable.');
 // The native NRIC owner stores twelve digits. Only a complete plausible NRIC gains
 // separator normalization; letters/punctuation and literal passport/public matching do not.
 const nricNeedle=/^[0-9]{6}[ -]?[0-9]{2}[ -]?[0-9]{4}$/.test(needle)?needle.replace(/[ -]/g,''):null;
 return withPersonnelRead(ctx,async tx=>{
  const source=await tx.execute<{row:SearchRow}>(sql`select value as row from app.personnel_search_rows(ARRAY[${sql.join(p.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) as search_row(value) limit 100001`);
  if(source.length>100000)throw new PersonnelSearchLimitError();
  const matches=source.flatMap(({row})=>{
   const publicMatch=[row.name,row.email,row.employeeCode].some(value=>value?.toLocaleLowerCase().includes(needle));
   const identityMatch=!!(row.icNumber?.toLocaleLowerCase().includes(needle)||nricNeedle&&row.icNumber===nricNeedle||row.passportNumber?.toLocaleLowerCase().includes(needle));
   return publicMatch||identityMatch?[{employmentId:row.employmentId,kind:publicMatch?'public':'identity',personRevision:row.personRevision,employmentRevision:row.employmentRevision,identityRevision:identityMatch?row.identityRevision:null}]:[];
  });
  const token=randomBytes(32).toString('base64url'),hash=privateSearchHash(token)!;
  await tx.execute(sql`delete from personnel_private_search where tenant_id=${ctx.tenantId}::uuid and actor_id=${ctx.userId}::uuid and (expires_at<=now() or token_hash in(select token_hash from personnel_private_search where tenant_id=${ctx.tenantId}::uuid and actor_id=${ctx.userId}::uuid order by created_at desc offset 7))`);
  await tx.execute(sql`insert into personnel_private_search(token_hash,tenant_id,actor_id,scope_ids,matches) values(${hash},${ctx.tenantId}::uuid,${ctx.userId}::uuid,ARRAY[${sql.join(p.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[],${JSON.stringify(matches)}::jsonb)`);
  return token;
 }, { writesSearchToken: true });
}

export async function personnelPrivateSearchAvailable(ctx:SessionContext,token:string,companyIds:string[]):Promise<boolean>{
 const hash=privateSearchHash(token);if(!hash)return false;
 return withTenant(ctx,async tx=>{const [row]=await tx.execute<{available:boolean}>(sql`select exists(select 1 from personnel_private_search where token_hash=${hash} and tenant_id=app.current_tenant_id() and actor_id=app.current_user_id() and expires_at>now() and scope_ids @> ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[] and scope_ids <@ ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[] and app.principal_snapshot_current()) as available`);return row?.available===true;});
}
