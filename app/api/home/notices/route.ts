import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {readEmployeeHomeNotices} from '@/core/employee-home-notices';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>key!=='employmentId')||query.getAll('employmentId').length!==1)
   return Response.json({error:'invalid'},{status:400,headers});
  const value=await readEmployeeHomeNotices(session,query.get('employmentId')!);
  return Response.json({version:value.version,employmentId:value.employmentId,total:value.total,unread:value.unread,
   acknowledgementRequired:value.acknowledgementRequired,items:value.items.map(row=>({id:row.id,title:row.title,
    summary:row.summary,category:row.category,pinned:row.pinned,requiresAcknowledgement:row.requiresAcknowledgement,
    publishedAt:row.publishedAt,publishedBy:row.publishedBy,firstViewedAt:row.firstViewedAt,acknowledgedAt:row.acknowledgedAt}))},{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:503,headers});
 }
}
