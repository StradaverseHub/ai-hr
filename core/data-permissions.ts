/** The private SQL owner repeats current authorization, locking, preview binding and audit on every call. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {canonicalDataPermissionRules,type DataPermissionRules,type DataPermissionField} from '../lib/data-permission-model';
export type DataPermissionCommand=
 |{kind:'create'|'edit';profileId:string;name:string;enabled:boolean;rules:DataPermissionRules}
 |{kind:'retire';profileId:string}
 |{kind:'assign';userId:string;profileId:string|null};
export type DataPermissionState={revision:string;profiles:{id:string;name:string;revision:string;enabled:boolean;editable:boolean;rules:DataPermissionRules|null;assignedCount:number}[];assignments:{userId:string;profileId:string}[];options:{field:DataPermissionField;value:string;label:string}[]};
export type DataPermissionPreview={fingerprint:string;affectedUsers:number;matchingRecords:number};
function canonicalCommand(value:DataPermissionCommand):DataPermissionCommand{
 if(value.kind==='create'||value.kind==='edit')return {...value,name:value.name.trim(),rules:canonicalDataPermissionRules(value.rules)};
 return value;
}
export function readDataPermissions(ctx:SessionContext){
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute(sql`select app.data_permission_state() as value`) as unknown as {value:DataPermissionState}[];
  if(!row?.value?.revision)throw Error('unavailable');return row.value;
 });
}
export function previewDataPermission(ctx:SessionContext,revision:string,command:DataPermissionCommand){
 const canonical=canonicalCommand(command);
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute(sql`select app.data_permission_transition(${JSON.stringify(canonical)}::jsonb,${revision},false,NULL) as value`) as unknown as {value:DataPermissionPreview}[];
  if(!row?.value?.fingerprint)throw Error('unavailable');return row.value;
 });
}
export function saveDataPermission(ctx:SessionContext,revision:string,command:DataPermissionCommand,fingerprint:string){
 const canonical=canonicalCommand(command);
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute(sql`select app.data_permission_transition(${JSON.stringify(canonical)}::jsonb,${revision},true,${fingerprint}) as value`) as unknown as {value:{revision:string}}[];
  if(!row?.value?.revision)throw Error('unavailable');return row.value;
 });
}
