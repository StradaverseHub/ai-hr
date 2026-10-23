'use server';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {AccessPermissionError} from '@/lib/access-permission-model';
import {pgSqlState} from '@/lib/db-error';
import type {AccessEditorResult} from '@/lib/access-editor-result';
import {previewAccessConfiguration,saveAccessConfiguration,type AccessConfigurationPreview} from '@/core/access-configuration';
import {accessConfigurationStore} from '@/core/access-configuration-store';
function edit(raw:unknown,saving:boolean){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new AccessPermissionError('invalid');
 const value=raw as Record<string,unknown>,keys=saving?['expectedRevision','command','previewFingerprint']:['expectedRevision','command'];
 if(Object.keys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key))||typeof value.expectedRevision!=='string')throw new AccessPermissionError('invalid');
 return {expectedRevision:value.expectedRevision,command:value.command,previewFingerprint:value.previewFingerprint};
}
function failure(error:unknown):{ok:false;code:'invalid'|'changed'|'unsupported'|'ceiling'|'lastAdministrator'|'system'}{
 if(error instanceof AccessPermissionError)return {ok:false,code:error.code};
 // Do not log submitted names, SQL parameters or private owner snapshots.
 console.error('Access configuration failed',{name:error instanceof Error?error.name:'Unknown',sqlState:pgSqlState(error)});
 return {ok:false,code:'system'};
}
export async function previewAccessConfigurationAction(raw:unknown):Promise<AccessEditorResult<AccessConfigurationPreview>>{
 const session=await getSession();
 try{return {ok:true,value:await previewAccessConfiguration(session,edit(raw,false),accessConfigurationStore)};}
 catch(error){return failure(error);}
}
export async function saveAccessConfigurationAction(raw:unknown):Promise<AccessEditorResult<{revision:string}>>{
 const session=await getSession();
 try{
  const value=await saveAccessConfiguration(session,edit(raw,true),accessConfigurationStore);
  revalidatePath('/admin/users/access');revalidatePath('/admin/users');
  return {ok:true,value};
 }catch(error){return failure(error);}
}
