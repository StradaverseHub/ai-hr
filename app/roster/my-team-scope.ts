/** Shared destination contract for team-linked roster page, export and exceptions. */
import type {SessionContext} from '@/db/client';
import {resolveMyTeamRosterScope} from '@/core/my-team';
import {parseMyTeamQuery,serializeMyTeamQuery} from '@/lib/my-team-query';
export type RosterTeamParams={myTeam?:string;view?:string;month?:string;from?:string;companyId?:string;dept?:string;q?:string};
export async function rosterTeamContext(ctx:SessionContext,scopeIds:string[],params:RosterTeamParams){
 if(!params.myTeam)return null;
 const requested=parseMyTeamQuery(new URLSearchParams(params.myTeam));
 const query={...requested,view:params.view==='month'?'month' as const:params.view==='week'?'week' as const:requested.view,
  anchorDate:params.from??(params.month?`${params.month}-01`:requested.anchorDate),search:params.q??requested.search,
  departmentId:params.dept||requested.departmentId,
  companyIds:(requested.companyIds??scopeIds).filter(id=>scopeIds.includes(id)&&(!params.companyId||params.companyId===id)),
 };
 // Validate outer roster controls with the same URL contract before the fresh authority lookup.
 const validated=parseMyTeamQuery(serializeMyTeamQuery(query));
 const scope=await resolveMyTeamRosterScope(ctx,validated);return {query:validated,scope};
}
