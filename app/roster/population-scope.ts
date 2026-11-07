import type {SessionContext} from '@/db/client';
import {allowedCompanies} from '@/core/read';
import {getScopeIds} from '@/lib/scope';
import type {RosterPopulation} from '@/core/roster-presentation';
import {rosterTeamContext} from './my-team-scope';

/** Resolve every request from the actual company scope and team authority; posted filters only narrow. */
export async function rosterPopulationScope(s:SessionContext,query:URLSearchParams,requiredCompanyId?:string,options:{requireWrite?:boolean}={}):Promise<RosterPopulation>{
 const allowed=await allowedCompanies(s),scopeIds=await getScopeIds(allowed.map(c=>c.id));
 const team=await rosterTeamContext(s,scopeIds,Object.fromEntries(query));
 if(options.requireWrite&&team&&!team.scope.canEditRoster)throw new Error('Forbidden');
 const companies=allowed.filter(c=>(!scopeIds.length||scopeIds.includes(c.id))&&(!team||team.scope.companyIds.includes(c.id)));
 const companyId=requiredCompanyId??query.get('companyId');
 if(!companies.length||companyId&&!companies.some(c=>c.id===companyId))throw new Error('Forbidden');
 return {companyIds:companyId?[companyId]:companies.map(c=>c.id),businessUnitId:query.get('bu')||undefined,
  departmentId:query.get('dept')||undefined,q:query.get('q')??undefined,...(team?{employmentIds:team.scope.employmentIds}:{})};
}
