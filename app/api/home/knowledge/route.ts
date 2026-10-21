import {getLocale} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {isLocale} from '@/i18n/config';
import {HomeSearchQueryError,homeKnowledgeHref} from '@/lib/employee-home-search';
import {searchHomeKnowledgeDocuments} from '@/core/knowledge-base';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
/** Read-only library facet. Its identity and audience come from the authenticated session, never
 * company/person/tenant selectors. Forms/pages will join through their own permission-filtered owner.
 */
export async function GET(request:Request){
 try{
  const session=await getSession();
  const query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>key!=='q'&&key!=='locale')||query.getAll('q').length>1||query.getAll('locale').length>1)
   return Response.json({error:'invalid'},{status:400,headers});
  const suppliedLocale=query.get('locale');
  if(suppliedLocale!==null&&!isLocale(suppliedLocale))return Response.json({error:'invalid'},{status:400,headers});
  const locale=suppliedLocale??await getLocale();
  const rows=await searchHomeKnowledgeDocuments(session,query.get('q')??'',locale);
  const items=rows.map(row=>({id:row.id,kind:row.kind,title:row.title,category:row.category,
   descriptionMarkdown:row.descriptionMarkdown,href:homeKnowledgeHref(row.id)}));
  return Response.json({version:1,items},{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeSearchQueryError?'invalid':'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='invalid'?400:503,headers});
 }
}
