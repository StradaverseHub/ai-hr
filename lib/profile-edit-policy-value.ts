/** Persisted generations of the same tenant-owned ESS policy. */
export type ProfileFieldPermission='editable'|'viewOnly'|'hide';
export type ProfileEditPolicyValue = {readonly version:2;readonly fields:readonly string[]};
type VisibilityFields={readonly fields:Readonly<Record<string,ProfileFieldPermission>>;readonly primaryOnly:readonly string[]};
export type ProfileVisibilityPolicyValue=VisibilityFields&(
 {readonly version:3}|{readonly version:4;readonly groups:Readonly<Record<string,ProfileFieldPermission>>}
);
/** Group identities use the same stable tab/section vocabulary as the field registry. */
export const profileTabPolicyKey=(tab:string)=>`tab:${tab}`;
export const profileSectionPolicyKey=(tab:string,section:string)=>`section:${tab}/${section}`;
const permission=(value:unknown):value is ProfileFieldPermission=>typeof value==='string'&&['editable','viewOnly','hide'].includes(value);
/** A group can only narrow a field. Unsupported fields never acquire editing authority here. */
export function profileGroupPermission(policy:ProfileVisibilityPolicyValue,field:{tab:string;section:string}):ProfileFieldPermission{
 if(policy.version===3)return 'editable';
 const caps=[policy.groups[profileTabPolicyKey(field.tab)],policy.groups[profileSectionPolicyKey(field.tab,field.section)]];
 return caps.includes('hide')?'hide':caps.includes('viewOnly')?'viewOnly':'editable';
}
export function effectiveProfileFieldPermission(policy:ProfileVisibilityPolicyValue,field:{id:string;tab:string;section:string}):ProfileFieldPermission{
 const own=policy.fields[field.id]??'hide',cap=profileGroupPermission(policy,field);
 return own==='hide'||cap==='hide'?'hide':own==='viewOnly'||cap==='viewOnly'?'viewOnly':'editable';
}
const key=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200;
/** Shape validation is bounded; the canonical writer additionally checks descriptor authority. */
export function isProfileVisibilityPolicyValue(raw:unknown):raw is ProfileVisibilityPolicyValue{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
 const value=raw as Record<string,unknown>;
 if(!((value.version===3&&Object.keys(value).length===3)||(value.version===4&&Object.keys(value).length===4))||!value.fields||typeof value.fields!=='object'||Array.isArray(value.fields)||!Array.isArray(value.primaryOnly))return false;
 if(value.version===4){if(!value.groups||typeof value.groups!=='object'||Array.isArray(value.groups))return false;const groups=Object.entries(value.groups);if(groups.length>128||groups.some(([id,cap])=>!key(id)||!permission(cap)))return false;}
 const entries=Object.entries(value.fields);
 return entries.length<=512&&entries.every(([id,permission])=>key(id)&&typeof permission==='string'&&['editable','viewOnly','hide'].includes(permission))&&value.primaryOnly.length<=512&&value.primaryOnly.every(key)&&new Set(value.primaryOnly).size===value.primaryOnly.length;
}
/** A malformed object is never interpreted as an unconfigured legacy policy. */
export function isProfileEditPolicyValue(raw:unknown):raw is ProfileEditPolicyValue {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
 const value=raw as Record<string,unknown>;
 return Object.keys(value).length===2&&Object.hasOwn(value,'version')&&Object.hasOwn(value,'fields')&&value.version===2&&Array.isArray(value.fields)&&value.fields.length<=512&&value.fields.every(key)&&new Set(value.fields).size===value.fields.length;
}
export function isLegacyProfileEditPolicy(raw:unknown):boolean {
 return raw==='all'||raw==null||Array.isArray(raw)&&raw.every(field=>typeof field==='string');
}

/** The profile tab controller receives only explicit hidden tab identities, never raw policy data. */
export function profileHiddenTabs(raw:unknown):string[]{return isProfileVisibilityPolicyValue(raw)&&raw.version===4?Object.entries(raw.groups).filter(([id,value])=>id.startsWith('tab:')&&value==='hide').map(([id])=>id.slice(4)):[];}
