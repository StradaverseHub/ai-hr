import {scopedSession} from '@/lib/scope';
import {AuthRequiredError} from '@/lib/auth-errors';
import {orgChartWindow,OrgWindowUnavailableError} from '@/core/org-chart-window';
import type {OrgWindowRequest} from '@/lib/org-chart-window';

const headers={'Cache-Control':'private, no-store',Vary:'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
const respond=(body:unknown,status=200)=>Response.json(body,{status,headers});
export async function GET(request:Request){
 try{
  const params=new URL(request.url).searchParams;
  const keys=['view','focusId','after','q'];
  for(const key of params.keys())if(!keys.includes(key)||params.getAll(key).length!==1)return respond({error:'invalid_window'},400);
  const input:OrgWindowRequest={view:(params.get('view')??'roots') as OrgWindowRequest['view']};
  for(const key of ['focusId','after','q'] as const)if(params.has(key))input[key]=params.get(key)!;
  const {s,scopeIds}=await scopedSession();
  return respond(await orgChartWindow(s,scopeIds,input));
 }catch(error){
  if(error instanceof AuthRequiredError)return respond({error:'authentication_required'},401);
  if(error instanceof RangeError)return respond({error:'invalid_window'},400);
  if(error instanceof OrgWindowUnavailableError)return respond({error:error.reason},error.reason==='principal'?403:error.reason==='focus'?404:409);
  return respond({error:'unavailable'},503);
 }
}
