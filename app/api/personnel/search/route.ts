import {capacityAwareRead} from '@/lib/database-degraded';
import {withDatabaseReadCancellation} from '@/db/workload';
import {getSession} from '@/lib/session';
import {getScopeIds} from '@/lib/scope';
import {workforceViewScope} from '@/core/workforce-access';
import {searchWorkforceEmployees} from '@/core/read';

export const GET = capacityAwareRead(async function GET(request:Request){
  const {signal}=request;
  const headers={'Cache-Control':'private, no-store'};
  const respond=(body:unknown,status=200)=>Response.json(body,{status,headers});
  try{
    signal.throwIfAborted();
    const session=await getSession();
    return await withDatabaseReadCancellation(signal,async()=>{
      signal.throwIfAborted();
      const allowed=await workforceViewScope(session);
      if(!allowed.canOpen)return respond({error:'forbidden'},403);
      const query=new URL(request.url).searchParams.get('q')??'';
      if(query.length>200)return respond({error:'invalid_query'},400);
      const companyIds=await getScopeIds(allowed.companyIds);
      signal.throwIfAborted();
      const rows=await searchWorkforceEmployees(session,companyIds,query);
      return respond({rows:rows.map(({employmentId,name,employeeCode,company,department})=>({employmentId,name,employeeCode,company,department}))});
    });
  }catch(error){
    if(signal.aborted&&error===signal.reason)return new Response(null,{status:503,headers});
    throw error;
  }
});
