import {departmentArchiveEntryAvailable} from './department-archive-review-store';
import {positionArchiveEntryAvailable} from './position-archive-review-store';
/** Server answer for Assistant native-action shortcuts. Read-only; never a capability, cache or grant.
 * The target action re-checks everything on its own server path, so a hidden or shown link changes
 * what is OFFERED, never what is ALLOWED. Failures stay `unknown` (hidden), never `allowed`. */
import 'server-only';
import type {SessionContext} from '../../db/client';
import type {AgentModuleCode} from '../../lib/ai/module-agents';
import {hasTeamAccess} from '../../lib/authz-model';
import {MODULE_ACTION_ENTRY_OF,moduleActionEntryRoleFloor,type ModuleActionEntry,type ModuleActionEntryAccess} from '../../lib/assistant-actions/module-action-entries';
import {workforceCompanies} from '../workforce-access';
import {administersRewardsForAnyCompany} from '../../packs/rewards/service';
import {readAssignedLeaveModuleActionChoices} from './module-action-server';

export async function moduleActionEntryAccess(supplied:SessionContext,entry:ModuleActionEntry):Promise<ModuleActionEntryAccess>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 const floor=moduleActionEntryRoleFloor(ctx,entry);if(floor!==null)return floor?'allowed':'refused';
 try{
  // The reporting-line search admits only employments where app.access_workforce_employment(...,
  // 'workforce.maintain') holds, which is app.access_workforce_company on the employment's company.
  if(entry==='org')return (await workforceCompanies(ctx,'maintain')).length>0||await positionArchiveEntryAvailable(ctx)||await departmentArchiveEntryAvailable(ctx)?'allowed':'refused';
  // Posting needs app.reward_admin for the unit's company (plus its payroll seat, checked per unit).
  if(entry==='rewards')return await administersRewardsForAnyCompany(ctx)?'allowed':'refused';
  // Same audience as the native Approvals entry (app/layout.tsx canApprove = admin or manager), plus
  // anyone the assigned-decision read itself currently finds an assigned leave task for.
  if(hasTeamAccess(ctx))return 'allowed';
  const choices=await readAssignedLeaveModuleActionChoices(ctx);
  return choices.kind!=='choices'?'unknown':choices.tasks.length>0?'allowed':'refused';
 }catch{return 'unknown';}
}

/** Only `allowed` entries for the task cards actually shown. Sequential: one carrier at a time. */
export async function allowedModuleActionEntries(ctx:SessionContext,modules:readonly AgentModuleCode[]):Promise<ModuleActionEntry[]>{
 const allowed:ModuleActionEntry[]=[];
 for(const module of modules){const entry=MODULE_ACTION_ENTRY_OF[module];if(entry&&!allowed.includes(entry)&&await moduleActionEntryAccess(ctx,entry)==='allowed')allowed.push(entry);}
 return allowed;
}
