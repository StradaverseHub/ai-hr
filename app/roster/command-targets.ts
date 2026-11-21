/** Shared final admission for both Server Actions and the native confirmation POST.
 * No caller flag can opt out. Preparation facts never replace canonical write authorization. */
import type {SessionContext} from '@/db/client';
import {assertRosterAdmin,type ReviewedRosterDepartment} from '@/core/roster';
import {rosterPopulationReview,rosterPopulationIds} from '@/core/roster-presentation';
import {parseRosterSelection,ROSTER_SELECTION_MAX} from '@/lib/roster-selection';
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

async function admitRosterCommandTargets(s:SessionContext,formData:FormData,department=false){
 const ids=parseRosterSelection(formData.get('selectionIds'));
 const scope=await rosterCommandScope(s,formData);
 const departmentId=String(formData.get('departmentId')??'').trim();
 if(department&&departmentId){
  await rosterPopulationReview(s,{...scope,selectedIds:ids,department:{departmentId,shiftId:String(formData.get('shiftId')??'')}});
 }else{
  const teamIds=scope.employmentIds?new Set(scope.employmentIds):null;
  const requestedIds=teamIds?ids.filter(id=>teamIds.has(id)):ids;
  const permitted=new Set(await rosterPopulationIds(s,{...scope,employmentIds:requestedIds}));
  if(permitted.size!==ids.length||ids.some(id=>!permitted.has(id)))throw new RosterCommandTargetError('The roster selection is no longer available in the current scope. Prepare it again.');
 }

 return {ids,scope};
}

export async function rosterCommandTargets(s:SessionContext,data:FormData){
 return (await admitRosterCommandTargets(s,data)).ids;
}

/** The one-submit Generate / Copy forms post the base fields (repeated `employmentIds`, optional
 * `departmentId`). Admit them against the same current authority as the prepared path: company write
 * scope, the freshly resolved team scope (posted IDs only narrow it), and exact membership of the
 * permitted population. Any ID outside it refuses the whole command; nothing is silently dropped. */
function postedEmploymentIds(data:FormData){
 const ids=[...new Set(data.getAll('employmentIds').map(String).filter(Boolean))];
 if(ids.length>ROSTER_SELECTION_MAX||ids.some(id=>!uuid.test(id)))throw new RosterCommandTargetError('Invalid roster selection. Refresh the roster and try again.');
 return ids;
}
async function admitPostedIds(s:SessionContext,scope:Awaited<ReturnType<typeof rosterCommandScope>>,ids:string[]){
 const teamIds=scope.employmentIds?new Set(scope.employmentIds):null;
 const requestedIds=teamIds?ids.filter(id=>teamIds.has(id)):ids;
 const permitted=new Set(requestedIds.length?await rosterPopulationIds(s,{...scope,employmentIds:requestedIds}):[]);
 if(ids.some(id=>!permitted.has(id)))throw new RosterCommandTargetError('The roster selection is no longer available in the current scope. Refresh the roster and try again.');
 return ids;
}

/** Generate: a chosen department still wins (base precedence), narrowed to the exact authorized subset of
 * the canonical department population; otherwise the posted employees, each admitted. An empty selection
 * with no department reaches the writer unchanged, which refuses it with its own message. */
export async function rosterFormGenerationTargets(s:SessionContext,data:FormData):Promise<{employmentIds:string[]}|{reviewedDepartment:ReviewedRosterDepartment}>{
 const scope=await rosterCommandScope(s,data),departmentId=String(data.get('departmentId')??'').trim();
 if(departmentId){
  const {ids}=await rosterPopulationReview(s,{...scope,department:{departmentId,shiftId:String(data.get('shiftId')??'')}});
  return {reviewedDepartment:{departmentId,employmentIds:ids,companyIds:scope.companyIds,...(scope.teamQuery!==undefined?{teamQuery:scope.teamQuery}:{})}};
 }
 const ids=postedEmploymentIds(data);
 return {employmentIds:ids.length?await admitPostedIds(s,scope,ids):[]};
}

/** Copy: the posted workforce, each admitted. copyRoster reads an absent list as "every source row the
 * caller's RLS can see", which ignores the chosen company and the team scope, so an empty post is bounded
 * to the current permitted population instead (and refused when that is empty). */
export async function rosterFormCopyTargets(s:SessionContext,data:FormData):Promise<string[]>{
 const scope=await rosterCommandScope(s,data),ids=postedEmploymentIds(data);
 if(ids.length)return admitPostedIds(s,scope,ids);
 const permitted=await rosterPopulationIds(s,scope);
 if(!permitted.length)throw new RosterCommandTargetError('No employees in scope for this company.');
 return permitted;
}

/** Preserve department intent through canonical dependency locks; never replace the reviewed IDs. */
export async function rosterGenerationTargets(s:SessionContext,data:FormData):Promise<{employmentIds:string[]}|{reviewedDepartment:ReviewedRosterDepartment}>{
 const {ids,scope}=await admitRosterCommandTargets(s,data,true),departmentId=String(data.get('departmentId')??'').trim();
 if(!departmentId)return {employmentIds:ids};
 return {reviewedDepartment:{departmentId,employmentIds:ids,companyIds:scope.companyIds,...(scope.teamQuery!==undefined?{teamQuery:scope.teamQuery}:{})}};
}
