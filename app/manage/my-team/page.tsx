import {getLocale} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {requireTeamAccess} from '@/lib/authz';
import {readMyTeam} from '@/core/my-team';
import {parseMyTeamQuery} from '@/lib/my-team-query';
import {MyTeam} from '@/components/my-team/my-team';
import {approveMyTeamLeaveAction,reviewMyTeamPunchAction} from './actions';
import {myTeamNavigation} from './server';
export default async function MyTeamPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 const {s,scopeIds}=await scopedSession();await requireTeamAccess(s);
 const raw=await searchParams;const params=new URLSearchParams();
 for(const [key,value] of Object.entries(raw)){if(Array.isArray(value))for(const item of value)params.append(key,item);else if(value!==undefined)params.set(key,value);}
 const query=parseMyTeamQuery(params),locale=await getLocale();
 // Empty active company scope means no team. Never turn it into an unfiltered model call.
 const requested=query.companyIds??scopeIds;const scoped=requested.filter(id=>scopeIds.includes(id));
 const snapshot=await readMyTeam(s,{...query,companyIds:scoped,locale});
 return <MyTeam snapshot={snapshot} query={snapshot.query} navigation={myTeamNavigation(snapshot)} periodDataHref="/manage/my-team/period" exportHref="/manage/my-team/export" approveAction={approveMyTeamLeaveAction} reviewAction={reviewMyTeamPunchAction}/>;
}
