import {getLocale} from 'next-intl/server';
import {isLocale} from '@/i18n/config';
import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {readEmployeeHomeGreeting} from '@/core/employee-home-greeting';
import {greetingProjection} from '../personal-projections';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>key!=='employmentId')||query.getAll('employmentId').length!==1)
   return Response.json({error:'invalid'},{status:400,headers});
  const locale=await getLocale();if(!isLocale(locale))throw Error('Home locale unavailable');
  const value=await readEmployeeHomeGreeting(session,query.get('employmentId')!,locale);
  return Response.json(greetingProjection(value),{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:503,headers});
 }
}
