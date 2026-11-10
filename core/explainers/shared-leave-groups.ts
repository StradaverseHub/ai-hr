/** 50d9b809 — shared_leave_groups, the Shared Leave Groups page as an HR administrator may ask about it in chat
 * (core/semantic-model/entities-leave-settings.ts), served as the operations_status topic of the same name.
 *
 * Runs the page's own read owners AS THE CALLER, under tenant row-level security: core/leave-shared-group.ts
 * listLeaveSharedGroups (the groups, ordered by name, exactly as the page lists them) and core/read.ts listLeaveTypes
 * (the member leave types' names). The same authority as the page: administrators only (lib/authz-model.ts isAdmin,
 * which the page's requireAdmin calls); anyone else is refused not_permitted before anything is read.
 *
 * Copies only the declared fields: each group's name, its member leave types' names, its shared limit, its cap per
 * application and where employees see it. Never a group or leave type id, an employee, a balance or a request. Read
 * only: groups are created, edited and deleted on the page, by the administrator, through the page's own actions.
 * Nothing here calculates a balance or enforces a limit; that stays with the leave service at apply and approval. */
import type {SessionContext} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {listLeaveSharedGroups} from '../leave-shared-group';
import {listLeaveTypes} from '../read';
import {SHARED_LEAVE_GROUPS_PAGE} from '../semantic-model/entities-leave-settings';
import {provenance,refuse,type ExplainerOutcome} from './outcome';

export async function sharedLeaveGroupsStatus(ctx:SessionContext):Promise<ExplainerOutcome>{
 if(!isAdmin(ctx))return refuse('not_permitted','Shared leave groups are available to administrators only.');
 // Archived leave types are read too, so a group that still holds one names it rather than dropping it silently.
 const [groups,types]=await Promise.all([listLeaveSharedGroups(ctx),listLeaveTypes(ctx,{includeArchived:true})]);
 const nameOf=new Map(types.map(type=>[type.id,type.name]));
 return{ok:true,
  groups:groups.map(group=>({name:group.name,
   // Member names A–Z: the membership read has no order of its own, and a stable order keeps answers comparable.
   leaveTypes:group.leaveTypeIds.flatMap(id=>nameOf.has(id)?[nameOf.get(id)!]:[]).sort((a,b)=>a.localeCompare(b)).map(name=>({name})),
   sharedLimitDays:group.totalLimitDays,maxDaysPerApplication:group.maxDaysPerApplication,employeePlacement:group.essPlacement})),
  provenance:provenance('core/leave-shared-group.ts#listLeaveSharedGroups','Not applicable: configured groups, not a versioned rule.',SHARED_LEAVE_GROUPS_PAGE,
   'Configuration only, read under the administrator\'s own access: the groups, their leave types, limits and placement, never an employee, a balance or a request. The leave service applies a group\'s limits when leave is requested and approved; groups are set up and edited on the Shared Leave Groups page.')};
}
