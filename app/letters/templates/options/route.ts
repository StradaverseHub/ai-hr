import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {listLetterFields,listLetterTemplateHeads,listLetterSignatories,listLetterEmployeeChoices,listLetterDelegates,listLetterSettingAssets} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import type {LetterChoices} from '@/lib/letter-choice';
export const runtime='nodejs';
const headers={'cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function GET(request:Request){
 try{
  const params=new URL(request.url).searchParams,companyId=params.get('companyId')??'',kind=params.get('kind'),search=params.get('q')??undefined,cursor=params.get('after')??undefined;
  if(kind==='signature'&&params.has('ownerUserId')&&!uuid.test(params.get('ownerUserId')??'')||kind==='delegate'&&!uuid.test(params.get('letterId')??'')||!uuid.test(companyId)||!['field','letterhead','signatory','employee','delegate','signature'].includes(kind??'')||(search?.length??0)>200||cursor&&!(kind==='field'?/^[a-z][a-zA-Z0-9_.]{0,79}$/.test(cursor):uuid.test(cursor)))throw new LetterWorkflowError('invalid');
  const ctx=await getSession();let result:LetterChoices;
  if(kind==='signature'){
   const page=await listLetterSettingAssets(ctx,{companyId,kind:'signature',ownerUserId:params.get('ownerUserId')??undefined,search,cursor,limit:25});result={rows:page.rows.map(row=>({id:row.id,label:row.name})),nextCursor:page.nextCursor};
  }else if(kind==='field'){
   const page=await listLetterFields(ctx,{companyId,search,after:cursor,limit:25});
   result={rows:page.items.filter(row=>row.active).map(row=>({id:row.id,label:row.definition.label+' · '+row.key,field:{definition:row.definition,ordinal:row.ordinal}})),nextCursor:page.nextCursor};
  }else if(kind==='delegate'){
   const page=await listLetterDelegates(ctx,{letterId:params.get('letterId')??'',search,cursor,limit:25});result={rows:page.rows.map(row=>({id:row.id,label:row.name})),nextCursor:page.nextCursor};
  }else if(kind==='employee'){
   const page=await listLetterEmployeeChoices(ctx,{companyId,search,cursor,limit:25,departmentId:params.get('departmentId')||undefined,departmentSearch:params.get('department')||undefined,branch:params.get('branch')||undefined,hiredFrom:params.get('hiredFrom')||undefined,hiredTo:params.get('hiredTo')||undefined});result={rows:page.rows.map(row=>({id:row.employmentId,label:row.name+(row.employeeCode?' · '+row.employeeCode:'')})),nextCursor:page.nextCursor};
  }else{
   const page=await (kind==='letterhead'?listLetterTemplateHeads:listLetterSignatories)(ctx,{companyId,search,cursor,limit:25});result={rows:page.rows.map(row=>({id:row.id,label:row.name})),nextCursor:page.nextCursor};
  }
  return Response.json(result,{headers});
 }catch(error){const code=error instanceof AuthRequiredError?'permission':error instanceof LetterWorkflowError?error.code:'unavailable';return Response.json({error:code},{status:error instanceof AuthRequiredError?401:code==='permission'?403:code==='unavailable'?503:400,headers});}
}
