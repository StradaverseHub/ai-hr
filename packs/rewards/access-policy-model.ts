import type {RewardRole} from './model';
/** The Rewards Access role permission catalogue (board db14e49c). Pure and client-safe.
 *
 * One owner for the grid: every row's category, kind and the per-role default level. The default is also the ceiling:
 * a saved cell can be the default or anything narrower among the options the server can enforce, never wider. The
 * same catalogue is mirrored in SQL by app.reward_role_default_level / app.reward_role_level_options /
 * app.reward_role_permission_locked (migrations 5520 and 5600) and test/rewards-role-permission-grid-db.test.ts checks parity
 * for every role and row. */
export const rewardAccessRoles=['bu','bg','proxy_bg','gr','ctro','ec','pbp','hr_admin','payroll'] as const;
export type RewardAccessRole=typeof rewardAccessRoles[number];

/** Limit Controls (board fc804e8c). Switched on at the board release integration: app.reward_limit_controls_access()
 * (migration 5560) now applies app.reward_actor_page_level('limits.view'), so the row narrows the page, its commands,
 * the menu and the row security on the Limit Controls tables. */
export const REWARD_LIMIT_CONTROLS_ROW_ENABLED=true;

export const rewardPermissionCategories=['pages','annual','offcycle','data','governance'] as const;
export type RewardPermissionCategory=typeof rewardPermissionCategories[number];
/** page: a page or configuration area (Full / View only / —); step: an action at the role's approval step
 * (At their step / —); data: data rows; fixed: governance rows nobody can change. */
export type RewardPermissionKind='page'|'step'|'data'|'fixed';
const allRows=[
 {id:'review.view',category:'pages',kind:'page'},{id:'promotions.view',category:'pages',kind:'page'},{id:'analytics.view',category:'pages',kind:'page'},
 {id:'approvals.view',category:'pages',kind:'page'},{id:'rules.view',category:'pages',kind:'page'},{id:'plans.manage',category:'pages',kind:'page'},
 {id:'salary.view',category:'pages',kind:'page'},{id:'bonus.view',category:'pages',kind:'page'},{id:'pat.manage',category:'pages',kind:'page'},
 {id:'limits.view',category:'pages',kind:'page'},{id:'access.manage',category:'pages',kind:'page'},
 {id:'figures.edit',category:'annual',kind:'step'},{id:'cases.decide',category:'annual',kind:'step'},{id:'notes.add',category:'annual',kind:'step'},
 {id:'review.decide',category:'annual',kind:'step'},{id:'review.batch',category:'annual',kind:'step'},{id:'senior.manage',category:'annual',kind:'data'},
 {id:'restricted.view',category:'annual',kind:'data'},
 {id:'offcycle.raise',category:'offcycle',kind:'step'},{id:'offcycle.decide',category:'offcycle',kind:'step'},
 {id:'data.check',category:'data',kind:'step'},{id:'snapshot.refresh',category:'data',kind:'step'},
 {id:'scope',category:'governance',kind:'fixed'},{id:'route',category:'governance',kind:'fixed'},{id:'own.never',category:'governance',kind:'fixed'},{id:'audit.always',category:'governance',kind:'fixed'},
] as const;
export type RewardCapability=typeof allRows[number]['id'];
type Row={readonly id:RewardCapability;readonly category:RewardPermissionCategory;readonly kind:RewardPermissionKind;readonly editable:boolean};
/** Every catalogue row, including rows that are switched off (Limit Controls before fc804e8c). */
export const rewardPermissionCatalogue:readonly Row[]=allRows.map(row=>({...row,editable:row.kind!=='fixed'}));
/** The rows the grid shows. */
export const permissionRows:readonly Row[]=rewardPermissionCatalogue.filter(row=>REWARD_LIMIT_CONTROLS_ROW_ENABLED||row.id!=='limits.view');

export type RewardLevel='full'|'step'|'view'|'none';
export const rewardLevels:readonly RewardLevel[]=['full','step','view','none'];
export type PermissionLevel=RewardLevel|'never'|'always'|'fixed';
const rank:Record<RewardLevel,number>={none:0,view:1,step:2,full:3};
export const rewardLevelRank=(level:RewardLevel)=>rank[level];
export const isRewardLevel=(value:unknown):value is RewardLevel=>typeof value==='string'&&value in rank;

/** The agreed default (and ceiling) for an editable row. Mirrors app.reward_role_default_level. */
export function rewardDefaultLevel(role:RewardAccessRole,capability:RewardCapability):RewardLevel{
 const r=role==='proxy_bg'?'bg':role;
 switch(capability){
  case'access.manage':case'plans.manage':case'data.check':case'snapshot.refresh':return r==='gr'?'full':'none';
  // Board 60f1fdcd (migration 5600): Group Rewards, CTRO and HR Admin edit Salary Structures, Bonus Matrices and company
  // PAT. The configuration editor predicate (app.reward_config_editor) still scopes them: a company-scoped HR Admin never
  // edits group-wide items.
  case'salary.view':case'bonus.view':case'pat.manage':return r==='gr'||r==='ctro'||r==='hr_admin'?'full':'none';
  case'senior.manage':case'limits.view':return r==='gr'?'full':r==='ctro'||r==='ec'?'view':'none';
  case'restricted.view':return r==='gr'||r==='ctro'||r==='ec'?'step':'none';
  case'promotions.view':return r==='gr'?'view':'none';
  case'review.view':case'analytics.view':case'approvals.view':case'rules.view':return r==='hr_admin'?'none':'view';
  case'cases.decide':return r==='bu'?'step':r==='gr'?'full':'none';
  case'figures.edit':case'notes.add':case'review.decide':case'review.batch':return r==='gr'?'full':r==='bu'||r==='bg'||r==='ctro'||r==='ec'?'step':'none';
  case'offcycle.raise':return r==='gr'?'full':r==='bu'||r==='bg'?'step':'none';
  case'offcycle.decide':return r==='gr'?'full':r==='bg'||r==='ctro'||r==='ec'?'step':'none';
  default:return'none';
 }
}

/** The levels a cell may hold: its default and the narrower levels the server can tell apart. A unit action is on or
 * off; a configuration page with a read-only mode (salary, bonus, Senior amounts, Limit Controls) also offers View
 * only. Restricted (EC) direct reports keep a visible level for roles on the approval route so a narrowed approver
 * still sees the rows at their step and the route cannot stall on hidden records. Mirrors app.reward_role_level_options. */
export function rewardLevelOptions(role:RewardAccessRole,capability:RewardCapability):RewardLevel[]{
 const d=rewardDefaultLevel(role,capability);
 if(d==='none')return['none'];
 if(capability==='restricted.view')return['step','view'];
 if(d==='full'&&(capability==='salary.view'||capability==='bonus.view'||capability==='senior.manage'||capability==='limits.view'))return['full','view','none'];
 return[d,'none'];
}

export type RewardLockReason='accessKeeper'|'ownNever'|'route'|'scope'|'audit'|'approvalOrder'|'notApplicable'|'heldRole';
/** Why a cell cannot be changed, or null. The server refuses the same cells (shape trigger and batch command). */
export function rewardCellLock(role:RewardAccessRole,capability:RewardCapability):RewardLockReason|null{
 if(capability==='own.never')return'ownNever';
 if(capability==='audit.always')return'audit';
 if(capability==='route')return'route';
 if(capability==='scope')return'scope';
 if(capability==='access.manage'&&role==='gr')return'accessKeeper';
 if(capability==='review.decide'&&(role==='bu'||role==='bg'||role==='gr'||role==='ctro'||role==='ec'))return'approvalOrder';
 if(rewardLevelOptions(role,capability).length<2)return'notApplicable';
 return null;
}

/** Display level for any row, including the fixed governance rows. */
export function rolePermission(role:RewardAccessRole,capability:RewardCapability):PermissionLevel{
 if(capability==='own.never')return'never';if(capability==='audit.always')return'always';if(capability==='scope'||capability==='route')return'fixed';
 return rewardDefaultLevel(role,capability);
}
/** A cell the grid lets someone change (ignoring the editor's own held roles, which the server adds). */
export function editableRewardPermission(role:RewardAccessRole,capability:RewardCapability){return rewardCellLock(role,capability)===null;}

/** The scope type a role reviews, shown in the "Units in scope" row. */
export type RewardScopeLabel='assignedCompanies'|'assignedBusinessUnits'|'wholeGroup'|'assignedCompaniesView'|'none';
export function rewardScopeLabel(role:RewardAccessRole):RewardScopeLabel{
 switch(role){case'bu':case'payroll':return'assignedCompanies';case'bg':case'proxy_bg':return'assignedBusinessUnits';case'gr':case'ctro':case'ec':return'wholeGroup';case'pbp':return'assignedCompaniesView';default:return'none';}
}

/** The effective level of a saved cell: the saved level, never above the default. */
export function effectiveRewardLevel(role:RewardAccessRole,capability:RewardCapability,saved:RewardLevel|null|undefined):RewardLevel{
 const d=rewardDefaultLevel(role,capability);if(!saved)return d;return rank[saved]<=rank[d]?saved:d;
}

export type RewardPermissionCell={role:RewardAccessRole;capability:RewardCapability;level:RewardLevel};
export type RewardPermissionChange={role:RewardAccessRole;capability:RewardCapability;before:RewardLevel;after:RewardLevel};
export const rewardCellKey=(role:string,capability:string)=>`${role}:${capability}`;
/** Saved matrix: only cells that differ from their default are stored. */
export type RewardPermissionMatrix=Record<string,RewardLevel>;
export const REWARD_PERMISSION_BATCH_LIMIT=200;

export type RewardBatchProblem={role:string;capability:string;code:'unknown'|'locked'|'option'|'held'|'duplicate'};
/** Validate a batch against the catalogue. `held` are the roles the editor holds (the self rule). */
export function rewardBatchProblems(changes:readonly{role:string;capability:string;after:string}[],held:readonly string[]):RewardBatchProblem[]{
 const seen=new Set<string>(),problems:RewardBatchProblem[]=[];
 for(const c of changes){
  const row=rewardPermissionCatalogue.find(r=>r.id===c.capability),role=(rewardAccessRoles as readonly string[]).includes(c.role)?c.role as RewardAccessRole:null;
  const key=rewardCellKey(c.role,c.capability);
  if(!row||!role||!row.editable||(row.id==='limits.view'&&!REWARD_LIMIT_CONTROLS_ROW_ENABLED)){problems.push({role:c.role,capability:c.capability,code:'unknown'});continue;}
  if(seen.has(key)){problems.push({role:c.role,capability:c.capability,code:'duplicate'});continue;}seen.add(key);
  // A locked cell can only go back to its default (clearing an older saved setting that broke the lock).
  if(rewardCellLock(role,row.id)&&c.after!==rewardDefaultLevel(role,row.id)){problems.push({role,capability:row.id,code:'locked'});continue;}
  if(!isRewardLevel(c.after)||!rewardLevelOptions(role,row.id).includes(c.after)){problems.push({role,capability:row.id,code:'option'});continue;}
  if(held.includes(role)){problems.push({role,capability:row.id,code:'held'});continue;}
 }
 return problems;
}

/** Apply edits to a saved matrix; a cell set back to its default is removed. */
export function applyRewardPermissionChanges(matrix:RewardPermissionMatrix,changes:readonly{role:RewardAccessRole;capability:RewardCapability;after:RewardLevel}[]):RewardPermissionMatrix{
 const next={...matrix};
 for(const c of changes){const key=rewardCellKey(c.role,c.capability);if(c.after===rewardDefaultLevel(c.role,c.capability))delete next[key];else next[key]=c.after;}
 return next;
}
/** Cells that differ between two saved matrices (both read with their defaults). */
export function compareRewardPermissionMatrices(from:RewardPermissionMatrix,to:RewardPermissionMatrix):RewardPermissionChange[]{
 const out:RewardPermissionChange[]=[];
 for(const row of permissionRows){if(!row.editable)continue;for(const role of rewardAccessRoles){
  const key=rewardCellKey(role,row.id),before=effectiveRewardLevel(role,row.id,from[key]),after=effectiveRewardLevel(role,row.id,to[key]);
  if(before!==after)out.push({role,capability:row.id,before,after});
 }}
 return out;
}
/** Saved cells that break a lock (for example an older setting that removed an approval step). */
export function rewardLockedOverrides(matrix:RewardPermissionMatrix){
 return Object.entries(matrix).flatMap(([key,level])=>{const [role,capability]=key.split(':') as [RewardAccessRole,RewardCapability];
  const lock=rewardCellLock(role,capability);return lock&&lock!=='notApplicable'&&level!==rewardDefaultLevel(role,capability)?[{role,capability,level}]:[];});
}

export function allowedRewardCapability(roles:readonly RewardRole[],capability:RewardCapability,overrides:readonly{role:string;capability:string;allowed:boolean}[]){
 return roles.some(role=>{const native=rolePermission(role,capability);if(['none','never'].includes(native))return false;const override=overrides.find(v=>v.role===role&&v.capability===capability);return override?.allowed??true;});
}
