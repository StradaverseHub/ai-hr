/** Shared final admission for both Server Actions and the native confirmation POST.
 * No caller flag can opt out. Preparation facts never replace canonical write authorization. */
import type {SessionContext} from '@/db/client';
import {assertRosterAdmin} from '@/core/roster';
import {rosterDepartmentIds,rosterPopulationIds} from '@/core/roster-presentation';
import {parseRosterSelection} from '@/lib/roster-selection';
import {rosterPopulationScope} from './population-scope';
export class RosterCommandTargetError extends Error{}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export async function rosterCommandScope(s:SessionContext,formData:FormData){
 assertRosterAdmin(s);
 const companyId=formData.get('companyId'),raw=formData.get('populationQuery');
 if(typeof companyId!=='string'||!uuid.test(companyId))throw new RosterCommandTargetError('Choose a company before preparing the roster selection.');
 if(raw!==null&&(typeof raw!=='string'||raw.length>16384))throw new RosterCommandTargetError('Invalid roster scope');
 const query=new URLSearchParams(raw??'');
 // A navigation search is not the scope of a persistent explicit selection.
 query.delete('q');query.delete('bu');query.delete('dept');
 return rosterPopulationScope(s,query,companyId,{requireWrite:true});
}

export async function rosterCommandTargets(s:SessionContext,formData:FormData,department=false){
 const ids=parseRosterSelection(formData.get('selectionIds'));
 const scope=await rosterCommandScope(s,formData);
 const teamIds=scope.employmentIds?new Set(scope.employmentIds):null;
 const requestedIds=teamIds?ids.filter(id=>teamIds.has(id)):ids;
 const permitted=new Set(await rosterPopulationIds(s,{...scope,employmentIds:requestedIds}));
 if(permitted.size!==ids.length||ids.some(id=>!permitted.has(id)))throw new RosterCommandTargetError('The roster selection is no longer available in the current scope. Prepare it again.');
 const departmentId=String(formData.get('departmentId')??'').trim();
 if(department&&departmentId){
  const candidates=new Set(await rosterDepartmentIds(s,{departmentId,shiftId:String(formData.get('shiftId')??'')}));
  if(ids.some(id=>!candidates.has(id)))throw new RosterCommandTargetError('The department selection changed. Prepare it again.');
 }
 return ids;
}
