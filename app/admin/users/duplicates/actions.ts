'use server';
/** Board 0735d1b7 — Merge and Undo merge saves. Each keeps the app frame (ADR 0181 decision 4): from an
 * <ActionNavigateForm> it returns where to go; from a plain form it redirects without revalidating the layout. The
 * owner (core/login-merge.ts) re-checks group administration, the current group and every guard in its transaction. */
import {redirect} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {requestsClientNavigation,type ActionNavigation} from '@/lib/action-navigation';
import {LoginMergeError,mergeLogins,undoLoginMerge} from '@/core/login-merge';
import type {DuplicateBasis} from '@/core/login-duplicates';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const go=(data:FormData,href:string):ActionNavigation=>{if(requestsClientNavigation(data))return{navigate:href};redirect(href);};
const all=(data:FormData,name:string)=>data.getAll(name).map(String).filter(v=>UUID.test(v));
const errorKey=(error:unknown)=>error instanceof LoginMergeError?error.code.replace(/-(\w)/g,(_,c:string)=>c.toUpperCase()):'failed';

export async function mergeLoginsAction(data:FormData):Promise<ActionNavigation>{
 const t=await getTranslations('admin.users.duplicates');
 const tab=data.get('tab')==='email'?'email':'identity',group=String(data.get('group')??''),master=String(data.get('master')??'');
 const back=`/admin/users/duplicates/merge?${new URLSearchParams({tab,group,master})}`;
 try{
  await mergeLogins(await getSession(),{basis:String(data.get('basis')??'') as DuplicateBasis,groupDigest:group,masterId:master,mergedIds:all(data,'merged'),
   carry:{roleAssignmentIds:all(data,'carryRole'),assistant:data.get('carryAssistant')==='on'},reason:String(data.get('reason')??''),confirmation:String(data.get('confirmation')??'')});
 }catch(error){return go(data,`${back}&error=${encodeURIComponent(t(`error.${errorKey(error)}`))}`);}
 return go(data,`/admin/users/${master}/account?toast=${encodeURIComponent(t('merged'))}`);
}

export async function undoLoginMergeAction(data:FormData):Promise<ActionNavigation>{
 const t=await getTranslations('admin.users.duplicates');
 const userId=String(data.get('userId')??''),page=UUID.test(userId)?`/admin/users/${userId}/account`:'/admin/users';
 try{
  await undoLoginMerge(await getSession(),{mergeId:String(data.get('mergeId')??''),reason:String(data.get('reason')??''),
   removeCarried:{roleAssignmentIds:all(data,'removeRole'),assistant:data.get('removeAssistant')==='on'}});
 }catch(error){return go(data,`${page}?error=${encodeURIComponent(t(`error.${errorKey(error)}`))}`);}
 return go(data,`${page}?toast=${encodeURIComponent(t('undone'))}`);
}
