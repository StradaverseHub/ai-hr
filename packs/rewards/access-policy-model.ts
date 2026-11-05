import type {RewardRole} from './model';
export const rewardAccessRoles=['bu','bg','proxy_bg','gr','ctro','ec','pbp','hr_admin','payroll'] as const;
export type RewardAccessRole=typeof rewardAccessRoles[number];
export const permissionRows=[
 {id:'review.view',category:'pages',editable:true},{id:'analytics.view',category:'pages',editable:true},{id:'approvals.view',category:'pages',editable:true},{id:'rules.view',category:'pages',editable:true},
 {id:'cycles.view',category:'pages',editable:false},{id:'plans.manage',category:'pages',editable:false},{id:'salary.view',category:'pages',editable:false},{id:'bonus.view',category:'pages',editable:false},{id:'pat.manage',category:'pages',editable:false},{id:'access.manage',category:'pages',editable:false},
 {id:'figures.edit',category:'annual',editable:true},{id:'cases.decide',category:'annual',editable:true},{id:'notes.add',category:'annual',editable:true},{id:'review.decide',category:'annual',editable:true},{id:'review.batch',category:'annual',editable:true},{id:'senior.manage',category:'annual',editable:false},{id:'restricted.view',category:'annual',editable:false},
 {id:'offcycle.raise',category:'offcycle',editable:true},{id:'offcycle.decide',category:'offcycle',editable:true},{id:'data.check',category:'data',editable:true},{id:'snapshot.refresh',category:'data',editable:true},
 {id:'scope',category:'governance',editable:false},{id:'route',category:'governance',editable:false},{id:'own.never',category:'governance',editable:false},{id:'audit.always',category:'governance',editable:false},
] as const;
export type RewardCapability=typeof permissionRows[number]['id'];
export type PermissionLevel='full'|'step'|'view'|'none'|'never'|'always'|'fixed';
export function rolePermission(role:RewardAccessRole,capability:RewardCapability):PermissionLevel {
 const r=role==='proxy_bg'?'bg':role;
 if(capability==='own.never')return'never';if(capability==='audit.always')return'always';if(capability==='scope'||capability==='route')return'fixed';
 if(['cycles.view','plans.manage','pat.manage','access.manage','senior.manage','data.check','snapshot.refresh'].includes(capability))return r==='gr'?'full':'none';
 if(capability==='salary.view'||capability==='bonus.view')return r==='gr'?'full':r==='ctro'?'view':'none';
 if(capability==='restricted.view')return ['gr','ctro','ec'].includes(r)?'view':'none';
 if(['review.view','analytics.view','approvals.view','rules.view'].includes(capability))return r==='hr_admin'?'none':'view';
 if(capability==='cases.decide')return r==='bu'?'step':r==='pbp'?'view':r==='gr'?'full':'none';
 if(capability==='figures.edit'||capability==='notes.add'||capability==='review.decide'||capability==='review.batch')return r==='gr'?'full':['bu','bg','ctro','ec'].includes(r)?'step':'none';
 if(capability==='offcycle.raise')return r==='bu'||r==='bg'?'step':r==='gr'?'full':'none';
 if(capability==='offcycle.decide')return ['bg','ctro','ec'].includes(r)?'step':r==='gr'?'full':'none';
 return'none';
}
/** Editable toggles can narrow a role's native maximum, never mint a route role or disclose restricted rows. */
export function editableRewardPermission(role:RewardAccessRole,capability:RewardCapability){
 const row=permissionRows.find(r=>r.id===capability);return !!row?.editable&&rolePermission(role,capability)!=='none';
}
export function allowedRewardCapability(roles:readonly RewardRole[],capability:RewardCapability,overrides:readonly{role:string;capability:string;allowed:boolean}[]){
 return roles.some(role=>{const native=rolePermission(role,capability);if(['none','never'].includes(native))return false;const override=overrides.find(v=>v.role===role&&v.capability===capability);return override?.allowed??true;});
}
