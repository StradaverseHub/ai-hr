import {getSession} from '@/lib/session';
import {getScopeIds} from '@/lib/scope';
import {workforceViewScope} from '@/core/workforce-access';
import {searchWorkforceEmployeesTx} from '@/core/read';
import {withTenant} from '@/db/client';

export async function GET(request:Request){
  const session=await getSession();
  const allowed=await workforceViewScope(session);
  const respond=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
  if(!allowed.canOpen)return respond({error:'forbidden'},403);
  const query=new URL(request.url).searchParams.get('q')??'';
  if(query.length>200)return respond({error:'invalid_query'},400);
  const companyIds=await getScopeIds(allowed.companyIds);
  const rows=await withTenant(session,tx=>searchWorkforceEmployeesTx(session,tx,companyIds,query));
  return respond({rows:rows.map(({employmentId,name,employeeCode,company,department})=>({employmentId,name,employeeCode,company,department}))});
}
