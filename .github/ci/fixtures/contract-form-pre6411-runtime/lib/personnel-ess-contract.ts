/** Shared Personnel descriptors are the only field inventory. These are authority adapters, not SQL. */
import {isProfilePhotoProposal,PROFILE_PHOTO_FIELD} from './profile-photo-proposal';
import {resolveEssVisibleIds} from './personnel-ess-visibility';
import {z} from 'zod';
import {isProfileEditPolicyValue,isProfileVisibilityPolicyValue,isLegacyProfileEditPolicy,effectiveProfileFieldPermission,profileGroupPermission} from './profile-edit-policy-value';
import {PERSONNEL_FIELDS,personnelField} from './personnel-field-registry';
import {PROFILE_REQUESTABLE_KEYS} from './profile-requestable-fields';
import {personnelScalarIssue} from './personnel-import-contract';
import {EssProfileError,type EssProfileProposal,type EssScalar} from './personnel-ess-model';
export const essVisibleFields=()=>PERSONNEL_FIELDS.filter(field=>field.ess.visibility==='visible');
export const essEditableFields=()=>essVisibleFields().filter(field=>field.ess.binding&&['immediate','approval'].includes(field.ess.edit));
/** Legacy lists governed requests only; finite direct contacts remain compatible until a v2 save. */
export function resolveEssEditableIds(raw:unknown):ReadonlySet<string>{
 const fields=essEditableFields();
 if(isProfileVisibilityPolicyValue(raw)){
  const visible=resolveEssVisibleIds(raw);
  return new Set(fields.filter(field=>effectiveProfileFieldPermission(raw,field)==='editable'&&visible.has(field.id)).map(field=>field.id));
 }
 if(isProfileEditPolicyValue(raw))return new Set(fields.filter(field=>raw.fields.includes(field.id)).map(field=>field.id));
 if(!isLegacyProfileEditPolicy(raw))return new Set();
 const requests=raw==='all'||raw==null?PROFILE_REQUESTABLE_KEYS:raw as readonly string[];
 return new Set(fields.filter(field=>field.ess.legacyImmediate||field.ess.binding?.legacyKey&&requests.includes(field.ess.binding.legacyKey)).map(field=>field.id));
}
/** Exactly the old primary-contact fields, never create/other rows. Complete v2 empty closes them. */
export function resolveEssPrimaryEditableIds(raw:unknown):ReadonlySet<string>{
 const fields=essEditableFields().filter(field=>field.ess.legacyPrimaryKey);
 if(isProfileVisibilityPolicyValue(raw)){
  const visible=resolveEssVisibleIds(raw);
  return new Set(fields.filter(field=>effectiveProfileFieldPermission(raw,field)==='viewOnly'&&profileGroupPermission(raw,field)==='editable'&&raw.primaryOnly.includes(field.id)&&visible.has(field.id)).map(field=>field.id));
 }
 if(isProfileEditPolicyValue(raw))return new Set(fields.filter(field=>raw.fields.includes(field.ess.legacyPrimaryKey!)).map(field=>field.id));
 return new Set(isLegacyProfileEditPolicy(raw)?fields.map(field=>field.id):[]);
}
const scalar=z.union([z.string().max(4000),z.number().finite(),z.boolean(),z.null()]);
const change=z.object({fieldId:z.string().min(1).max(200),before:scalar,value:scalar}).strict();
const proposal=z.object({v:z.literal(2),fields:z.array(change).max(128),registers:z.array(z.object({kind:z.enum(['dependent','qualification','emergency']),id:z.uuid().nullable(),clientId:z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),fields:z.array(change).min(1).max(64)}).strict()).max(64)}).strict();
export function parseEssProfileProposal(raw:unknown):EssProfileProposal{
 let bytes:number;try{bytes=new TextEncoder().encode(JSON.stringify(raw)).length;}catch{throw new EssProfileError('invalid');}
 if(bytes>128000)throw new EssProfileError('invalid');
 const parsed=proposal.safeParse(raw);if(!parsed.success)throw new EssProfileError('invalid');
 const seen=new Set<string>();
 for(const [kind,fields] of [['scalar',parsed.data.fields],...parsed.data.registers.map(row=>[row.kind+':'+(row.id??row.clientId),row.fields] as const)] as const){
  for(const item of fields){const identity=kind+':'+item.fieldId;if(seen.has(identity))throw new EssProfileError('invalid',[item.fieldId]);seen.add(identity);
   const field=personnelField(item.fieldId),binding=field?.ess.binding;
   if(!field||field.ess.visibility!=='visible'||!binding||!['immediate','approval'].includes(field.ess.edit))throw new EssProfileError('permission',[item.fieldId]);
   if(kind==='scalar'?['dependent','qualification','emergency'].includes(binding.owner):!kind.startsWith(binding.owner+':'))throw new EssProfileError('invalid',[item.fieldId]);
   if(item.value===null&&field.type==='boolean'&&!binding.nullable)throw new EssProfileError('invalid',[item.fieldId]);
   if(item.value!==null){
    if(field.type==='boolean'?typeof item.value!=='boolean':field.type==='number'||field.type==='currency'?typeof item.value!=='number':typeof item.value!=='string')throw new EssProfileError('invalid',[item.fieldId]);
    if(personnelScalarIssue(field,String(item.value)))throw new EssProfileError('invalid',[item.fieldId]);
   }
   if(binding.owner==='taxLegacy'&&(binding.field==='numChildren'&&(!Number.isSafeInteger(item.value)||Number(item.value)<0)||binding.field==='taxCategory'&&![1,2,3].includes(Number(item.value))))throw new EssProfileError('invalid',[item.fieldId]);
   if(field.form?.required?.record&&(item.value===null||typeof item.value==='string'&&!item.value.trim()))throw new EssProfileError('invalid',[item.fieldId]);
  }
 }
 const registerIds=parsed.data.registers.map(row=>row.kind+':'+(row.id??row.clientId));
 if(new Set(registerIds).size!==registerIds.length)throw new EssProfileError('invalid');
 return parsed.data;
}
export function sameEssScalar(a:EssScalar|undefined,b:EssScalar|undefined){return (a??null)===(b??null);}

/** Stable field identities for legacy and v2 history/withdrawal; never proposed values. */
export function profileProposalKeys(raw:unknown):string[]{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return [];
 if(isProfilePhotoProposal(raw))return [PROFILE_PHOTO_FIELD];
 if('v' in raw&&raw.v===2){const value=parseEssProfileProposal(raw);return [...new Set([...value.fields,...value.registers.flatMap(row=>row.fields)].map(field=>field.fieldId))];}
 return Object.keys(raw).filter(key=>PROFILE_REQUESTABLE_KEYS.includes(key));
}
