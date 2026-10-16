/** Shared Personnel descriptors are the only field inventory. These are authority adapters, not SQL. */
import {z} from 'zod';
import {PERSONNEL_FIELDS,personnelField} from './personnel-field-registry';
import {PROFILE_REQUESTABLE_KEYS} from './profile-requestable-fields';
import {personnelScalarIssue} from './personnel-import-contract';
import {EssProfileError,type EssProfileProposal,type EssScalar} from './personnel-ess-model';
export const essVisibleFields=()=>PERSONNEL_FIELDS.filter(field=>field.ess.visibility==='visible');
export const essEditableFields=()=>essVisibleFields().filter(field=>field.ess.binding&&['immediate','approval'].includes(field.ess.edit));
/** 'all' is the PREVIOUS request set plus the two existing shared contact rights, never new fields. */
export function resolveEssEditableIds(raw:unknown):ReadonlySet<string>{
 const fields=essEditableFields();
 if(raw==='all'||raw===undefined||raw===null)return new Set(fields.filter(field=>field.ess.legacyImmediate||field.ess.binding?.legacyKey&&PROFILE_REQUESTABLE_KEYS.includes(field.ess.binding.legacyKey)).map(field=>field.id));
 if(!Array.isArray(raw))return new Set();
 return new Set(fields.filter(field=>raw.includes(field.id)||field.ess.binding?.legacyKey&&raw.includes(field.ess.binding.legacyKey)).map(field=>field.id));
}
/** Finite legacy capability, separate from generic register edit rights. Explicit empty denies it. */
export function resolveEssPrimaryEditableIds(raw:unknown):ReadonlySet<string>{
 const fields=essEditableFields().filter(field=>field.ess.legacyPrimaryKey);
 return new Set(fields.filter(field=>raw==='all'||raw===undefined||raw===null||Array.isArray(raw)&&raw.includes(field.ess.legacyPrimaryKey)).map(field=>field.id));
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
   if(item.value!==null){
    if(field.type==='boolean'?typeof item.value!=='boolean':field.type==='number'||field.type==='currency'?typeof item.value!=='number':typeof item.value!=='string')throw new EssProfileError('invalid',[item.fieldId]);
    if(personnelScalarIssue(field,String(item.value)))throw new EssProfileError('invalid',[item.fieldId]);
   }
   if(field.form?.required?.record&&(item.value===null||item.value===''))throw new EssProfileError('invalid',[item.fieldId]);
  }
 }
 const registerIds=parsed.data.registers.map(row=>row.kind+':'+(row.id??row.clientId));
 if(new Set(registerIds).size!==registerIds.length)throw new EssProfileError('invalid');
 return parsed.data;
}
export function sameEssScalar(a:EssScalar|undefined,b:EssScalar|undefined){return (a??null)===(b??null);}
