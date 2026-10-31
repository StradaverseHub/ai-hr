import {getLocale} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {hasTeamAccess} from '@/lib/authz';
import {readMyTeam} from '@/core/my-team';
import {parseMyTeamQuery} from '@/lib/my-team-query';
import {myTeamNavigation,myTeamErrorResponse} from '../server';
export async function GET(request:Request) {
 const {s,scopeIds}=await scopedSession();
 if(!hasTeamAccess(s))return Response.json({error:'not_authorized'},{status:403,headers:{'Cache-Control':'no-store'}});
 try{const query=parseMyTeamQuery(new URL(request.url).searchParams);const requested=query.companyIds??scopeIds;
  const snapshot=await readMyTeam(s,{...query,companyIds:requested.filter(id=>scopeIds.includes(id)),locale:await getLocale()});
  return Response.json({snapshot,navigation:myTeamNavigation(snapshot)},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return myTeamErrorResponse(error);}
}
