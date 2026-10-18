/** Same tenant setting, two generations: legacy request-only lists and a complete ESS policy. */
export type ProfileEditPolicyValue = {readonly version:2;readonly fields:readonly string[]};
/** A malformed object is never interpreted as an unconfigured legacy policy. */
export function isProfileEditPolicyValue(raw:unknown):raw is ProfileEditPolicyValue {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
 const value=raw as Record<string,unknown>;
 return Object.keys(value).length===2&&Object.hasOwn(value,'version')&&Object.hasOwn(value,'fields')&&value.version===2&&Array.isArray(value.fields)&&value.fields.length<=512&&value.fields.every(field=>typeof field==='string'&&field.length>0&&field.length<=200)&&new Set(value.fields).size===value.fields.length;
}
export function isLegacyProfileEditPolicy(raw:unknown):boolean {
 return raw==='all'||raw==null||Array.isArray(raw)&&raw.every(field=>typeof field==='string');
}
