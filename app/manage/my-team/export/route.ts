import {getLocale,getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {hasTeamAccess} from '@/lib/authz';
import {readMyTeam} from '@/core/my-team';
import {parseMyTeamQuery,MyTeamQueryError} from '@/lib/my-team-query';
import {serializeReport} from '@/lib/report-export';
import {myTeamErrorResponse} from '../server';
import {myTeamReport} from './report';
export const runtime='nodejs';
export async function GET(request:Request) {
 const {s,scopeIds}=await scopedSession();
 if(!hasTeamAccess(s))return Response.json({error:'not_authorized'},{status:403,headers:{'Cache-Control':'no-store'}});
 try{
  const params=new URL(request.url).searchParams,format=params.get('format')??'csv';
  if(format!=='csv'&&format!=='xlsx')throw new MyTeamQueryError();
  const query=parseMyTeamQuery(params),locale=await getLocale(),t=await getTranslations('myTeam');
  const requested=query.companyIds??scopeIds;
  const snapshot=await readMyTeam(s,{...query,companyIds:requested.filter(id=>scopeIds.includes(id)),locale});
  const report=myTeamReport(snapshot,locale,t),serialized=await serializeReport(report,format);
  return new Response(new Uint8Array(serialized.bytes),{headers:{'Content-Type':serialized.contentType,'Content-Disposition':`attachment; filename="${report.filename}.${serialized.ext}"`,'Cache-Control':'no-store'}});
 }catch(error){return myTeamErrorResponse(error);}
}
