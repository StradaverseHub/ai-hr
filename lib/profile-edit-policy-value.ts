/** Persisted generations of the same tenant-owned ESS policy. */
export type ProfileFieldPermission='editable'|'viewOnly'|'hide';
export type ProfileEditPolicyValue = {readonly version:2;readonly fields:readonly string[]};
export type ProfileVisibilityPolicyValue={readonly version:3;readonly fields:Readonly<Record<string,ProfileFieldPermission>>;readonly primaryOnly:readonly string[]};
const key=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200;
/** Shape validation is bounded; the canonical writer additionally checks descriptor authority. */
export function isProfileVisibilityPolicyValue(raw:unknown):raw is ProfileVisibilityPolicyValue{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
 const value=raw as Record<string,unknown>;
 if(Object.keys(value).length!==3||value.version!==3||!value.fields||typeof value.fields!=='object'||Array.isArray(value.fields)||!Array.isArray(value.primaryOnly))return false;
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
