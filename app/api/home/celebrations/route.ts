import {getSession} from '@/lib/session';
import {sharingError,sharingHeaders as headers,celebrationsResponse} from '../sharing-responses';
import {homeSharingPageInput} from '@/lib/employee-home-sharing';

/** Read-only: viewing or paging never sends a greeting or opts anybody in. */
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>!['employmentId','after'].includes(key))
   ||query.getAll('employmentId').length!==1||!query.get('employmentId')
   ||query.getAll('after').length>1)return Response.json({error:'invalid'},{status:400,headers});
  const after=query.get('after')??undefined;
  try{homeSharingPageInput(after,20,'celebration');}
  catch{return Response.json({error:'invalid'},{status:400,headers});}
  return Response.json(await celebrationsResponse(session,query.get('employmentId')!,{after}),{headers});
 }catch(error){
  const {code,status}=sharingError(error);
  return Response.json({error:code},{status,headers});
 }
}
