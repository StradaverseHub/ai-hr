/** Minimized editor metadata. No arbitrary personnel row or domain-event payload crosses this seam. */
import {AccessPermissionError,type AccessSnapshot} from './access-permission-model';
export const accessEditorOperations=['initialized','createGroup','renameGroup','retireGroup','replaceGroupGrants','setMembership','setOverride'] as const;
export type AccessEditorOperation=(typeof accessEditorOperations)[number];
export type AccessEditorChoice={id:string;label:string};
export type AccessEditorMetadata={users:AccessEditorChoice[];companies:AccessEditorChoice[];history:{id:string;at:string;actorId:string|null;operation:AccessEditorOperation}[]};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const refuse=():never=>{throw new AccessPermissionError('invalid');};
function choices(v:unknown,ids:ReadonlySet<string>):AccessEditorChoice[]{
 if(!Array.isArray(v)||v.length!==ids.size||v.length>5000)return refuse();
 const seen=new Set<string>();
 return v.map(row=>{
  if(!object(row)||!uuid(row.id)||!ids.has(row.id)||seen.has(row.id)||typeof row.label!=='string'||!row.label.trim()||row.label.length>1000)return refuse();
  seen.add(row.id);return {id:row.id,label:row.label};
 });
}
export function parseAccessEditorMetadata(raw:unknown,snapshot:AccessSnapshot,companyIds:ReadonlySet<string>):AccessEditorMetadata{
 if(!object(raw)||!Array.isArray(raw.history)||raw.history.length>100)return refuse();
 const users=choices(raw.users,new Set(snapshot.users.map(u=>u.id))),companies=choices(raw.companies,companyIds),seen=new Set<string>();
 const history=raw.history.map(row=>{
  if(!object(row)||!uuid(row.id)||seen.has(row.id)||typeof row.at!=='string'||!Number.isFinite(Date.parse(row.at))||!(row.actorId===null||uuid(row.actorId))||!accessEditorOperations.some(operation=>operation===row.operation))return refuse();
  seen.add(row.id);return {id:row.id,at:new Date(row.at).toISOString(),actorId:row.actorId,operation:row.operation as AccessEditorOperation};
 });
 return {users,companies,history};
}
