/** 50d9b809 — Shared Leave Groups, declared in the semantic model so an HR administrator can ask about them in chat
 * (definition of done for /admin/leave-config/shared-groups: its semantic entry and corpus turn).
 *
 * One read, shared_leave_groups, served as the operations_status topic of the same name (no new provider tool), over the
 * page's own read owners run as the caller under tenant row-level security: core/leave-shared-group.ts listLeaveSharedGroups
 * (the groups) and core/read.ts listLeaveTypes (their member leave types' names). Offered to administrators only, the
 * page's own requireAdmin (lib/authz-model.ts isAdmin), and the runner checks it again before reading
 * (core/explainers/shared-leave-groups.ts).
 *
 * A shared leave group is CONFIGURATION: several leave types drawing on one pooled allowance. It holds no employee, so
 * the read returns no person, balance, request or id: each group's name, its member leave types' names, its shared limit,
 * the most days one application may take from it, and where employees see it. Group names are configuration the
 * administrator owns, `minimum`; leave type names are `full` and screened like every other leave type name; the day
 * figures are configuration, `full`. Read only: nothing here creates, edits or deletes a group, which stays on the page.
 * Pure declarations; nothing here reads or grants. */
import {provenanceField} from './entities-explain';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'|'screen'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** Where employees see a group on their Leave tab (lib/leave-groups.ts ESS_PLACEMENTS), repeated so this file imports no
 * service; test/shared-leave-groups-read.test.ts pins the two lists equal. */
export const SHARED_GROUP_PLACEMENTS=['primary','secondary','hidden'] as const;
export const SHARED_LEAVE_GROUPS_PAGE='/admin/leave-config/shared-groups';

export const LEAVE_SETTINGS_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'shared_leave_group',label:'Shared leave groups',
  meaning:'For administrators: the shared leave groups configured on Leave Settings › Shared Leave Groups. Each group lets several leave types draw on one pooled allowance a year, for example Special Leave shared by compassionate and marriage leave, optionally with a cap on any one application. A leave type belongs to at most one group. A group holds leave types, never employees: employees are covered through the leave types they are entitled to.',
  module:'leave',sensitivity:'ordinary',audience:'admin',rls:'administered_scope',
  owners:['core/leave-shared-group.ts#listLeaveSharedGroups','core/read.ts#listLeaveTypes'],
  ruleVersion:null,relations:[],page:SHARED_LEAVE_GROUPS_PAGE,
  fields:[f('groups','list','full','One row per shared leave group, by name, as the Shared Leave Groups page lists them. Empty when none is configured.',{of:[
    f('name','label','minimum','The group\'s name, as the administrator configured it.'),
    f('leaveTypes','list','full','The leave types in the group, which draw on its pooled allowance.',{of:[
     f('name','label','full','The leave type\'s name.',{screen:'sensitive_label'})]}),
    f('sharedLimitDays','number','full','The days a year the member leave types share between them.'),
    f('maxDaysPerApplication','number','full','The most days one leave application may take from the group; null when there is no limit.'),
    f('employeePlacement','enum','full','Where employees see the group on their Leave tab: primary (one balance card at the top), secondary (lower down with the other leave) or hidden (not shown). Separate from each leave type\'s own placement.',{values:SHARED_GROUP_PLACEMENTS})]}),
   provenanceField]},
] satisfies SemanticEntity[]);

export const LEAVE_SETTINGS_READS:readonly SemanticRead[]=freeze([
 {name:'shared_leave_groups',entity:'shared_leave_group',
  purpose:'Administrators only: the shared leave groups of this organisation, as the Shared Leave Groups page under Leave Settings shows them. For each group, its name, the leave types that draw on its pooled allowance, the days a year they share, the most days one application may take from it, and where employees see it on their Leave tab. Configuration only: never an employee, a balance or a leave request. Groups are set up and edited on that page.',
  input:[]},
] satisfies SemanticRead[]);
