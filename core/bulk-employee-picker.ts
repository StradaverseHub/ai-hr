import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {employment,person} from '../db/schema';
import {assertAiPresentationPrincipalTx} from './ai-principal';
import {EmployeeChoiceAccessError,EmployeeChoiceInputError,exactEmployeeChoiceMatches} from './employee-choice';
import {employeePickVocabularyTx,employeePickProjection} from './read';
import {bulkEmployeeExactPredicate} from './bulk-employee-search';
import {isAdmin} from '../lib/authz-model';
import {matchesEmployeeSearch} from '../lib/employee-search';
import {resolveEmploymentSelection,type EmployeePickOption} from '../lib/employment-selection';

export type BulkEmployeePickerPage={rows:EmployeePickOption[];total:number;offset:number;query:string;ids?:string[]};
/** The leave/notice vocabulary owns all visible retained employments, independent of
 * effective-date eligibility. IDs identify a complete selection; they never grant a write.
 * No email, person ID, lifecycle, pay, or assignment DTO enters this reader. */
export async function bulkEmployeePicker(ctx:SessionContext,input:{query:string;offset:number;all?:boolean},signal?:AbortSignal):Promise<BulkEmployeePickerPage>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 if(!isAdmin(ctx))throw new EmployeeChoiceAccessError();
 const {query,offset}=input;
 if(typeof query!=='string'||query.length>200||!Number.isSafeInteger(offset)||offset<0||input.all!==undefined&&typeof input.all!=='boolean')throw new EmployeeChoiceInputError();
 return withTenant(ctx,async tx=>{
  await assertAiPresentationPrincipalTx(tx,ctx);signal?.throwIfAborted();
  const from=await employeePickVocabularyTx(tx,ctx),projection=employeePickProjection('employmentId');
  const exact=bulkEmployeeExactPredicate(sql`${person.fullName}`,sql`coalesce(${employment.employeeCode},'')`,query.trim().toLowerCase());
  let total=0,rows:EmployeePickOption[]=[],ids:string[]|undefined;
  if(!query.trim()||exact){
   const filtered=sql`${from} ${exact?sql`and ${exact}`:sql``}`;
   if(input.all){const identities=await tx.execute<{id:string}>(sql`select ${employment.id} as id ${filtered} order by ${person.fullName},${employment.id}`);ids=identities.map(row=>row.id);total=ids.length;}
   else {const [count]=await tx.execute<{total:number}>(sql`select count(*)::int as total ${filtered}`);total=count.total;}
   rows=(await tx.execute<{employmentId:string;name:string;employeeCode:string|null}>(sql`select ${projection} ${filtered} order by ${person.fullName},${employment.id} limit 25 offset ${offset}`)).map(({employmentId,...row})=>({id:employmentId,...row}));
  }else{
   // Native Unicode/unknown-runtime compatibility path: PostgreSQL locale lower is
   // not ECMAScript lower. As in employee-choice's approved exact reader, stream
   // minimal identities and keep25 labels, plus IDs only for an explicit All read.
   // This fallback is separately costed; the qualified ASCII path counts/pages in SQL.
   const matching:string[]=[];
   const result=await exactEmployeeChoiceMatches(tx,sql`select ${projection} ${from} order by ${person.fullName},${employment.id}`,'',offset,25,signal,row=>{
    const match=matchesEmployeeSearch(row,query);if(match&&input.all)matching.push(row.employmentId);return match;
   });
   total=result.total;rows=result.rows.map(({employmentId,...row})=>({id:employmentId,...row}));if(input.all)ids=matching;
  }
  signal?.throwIfAborted();return {rows,total,offset,query,...(ids?{ids}:{})};
 },{readOnlySnapshot:true,readSignal:signal});
}

/** Complete minimal code vocabulary is necessary for exact/folded collision refusal.
 * It remains server-side, and only the requested selection and 25 selected labels leave it. */
export async function resolveBulkEmployeeSelection(ctx:SessionContext,picked:string[],raw:string,signal?:AbortSignal){
 picked=picked.slice();
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 if(!isAdmin(ctx))throw new EmployeeChoiceAccessError();
 return withTenant(ctx,async tx=>{
  await assertAiPresentationPrincipalTx(tx,ctx);signal?.throwIfAborted();
  if(!picked.length&&!raw.trim())return {selection:{ids:[],unmatched:[]},rows:[]};
  const selected=picked.filter(id=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id));
  const restriction=!raw.trim()?selected.length?sql`and ${employment.id}=any(${'{'+selected.join(',')+'}'}::uuid[])`:sql`and false`:sql``;
  const from=await employeePickVocabularyTx(tx,ctx);
  const known=await tx.execute<EmployeePickOption>(sql`select ${employeePickProjection()} ${from} ${restriction} order by ${person.fullName},${employment.id}`);
  signal?.throwIfAborted();const selection=resolveEmploymentSelection(picked,raw,known),chosen=new Set(picked);
  return {selection,rows:known.filter(row=>chosen.has(row.id)).slice(0,25)};
 },{readOnlySnapshot:true,readSignal:signal});
}
