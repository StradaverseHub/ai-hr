import {getLocale,getTranslations} from 'next-intl/server';
import {isLocale} from '@/i18n/config';
import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {readEmployeeHomeSummary} from '@/core/employee-home-summary';
import {validateEmployeeHomeSummary} from '@/lib/employee-home-summary';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>key!=='employmentId')||query.getAll('employmentId').length!==1||!query.get('employmentId'))
   return Response.json({error:'invalid'},{status:400,headers});
  const locale=await getLocale();if(!isLocale(locale))throw Error('Home locale unavailable');
  const t=await getTranslations('employeeHome.calendar'),employmentId=query.get('employmentId')!;
  const value=await readEmployeeHomeSummary(session,employmentId,locale,t('replacement'));
  // The validator refuses extra/nested fields instead of accidentally serializing a richer owner.
  return Response.json(validateEmployeeHomeSummary(value,employmentId),{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:503,headers});
 }
}
