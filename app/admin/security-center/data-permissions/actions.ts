'use server';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {pgSqlState} from '@/lib/db-error';
import {previewDataPermission,saveDataPermission,type DataPermissionCommand,type DataPermissionPreview} from '@/core/data-permissions';
export type DataPermissionResult<T>={ok:true;value:T}|{ok:false;code:'invalid'|'changed'|'forbidden'|'unavailable'};
function failure(error:unknown):{ok:false;code:'invalid'|'changed'|'forbidden'|'unavailable'}{
 const state=pgSqlState(error);return {ok:false,code:state==='40001'?'changed':state==='42501'?'forbidden':state==='23514'||state==='23505'||state==='22P02'||error instanceof Error&&error.message==='invalid'?'invalid':'unavailable'};
}
export async function previewDataPermissionAction(revision:string,command:DataPermissionCommand):Promise<DataPermissionResult<DataPermissionPreview>>{
 try{return {ok:true,value:await previewDataPermission(await getSession(),revision,command)};}catch(error){return failure(error);}
}
export async function saveDataPermissionAction(revision:string,command:DataPermissionCommand,fingerprint:string):Promise<DataPermissionResult<{revision:string}>>{
 try{const value=await saveDataPermission(await getSession(),revision,command,fingerprint);revalidatePath('/admin/security-center/data-permissions');revalidatePath('/admin/users');return {ok:true,value};}catch(error){return failure(error);}
}
