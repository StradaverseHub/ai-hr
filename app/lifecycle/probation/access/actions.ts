'use server';
import {revalidatePath} from 'next/cache';
import {redirect,unstable_rethrow} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {publicErrorMessage} from '@/lib/public-error';
import {addProbationAccessMember,changeProbationAccessMember,retireProbationAccessRole,revokeProbationAccessMember,saveProbationAccessRole,saveProbationSuperiorRule} from '@/packs/probation/service';

const PAGE='/lifecycle/probation/access';
/** Access renders on its own page and inside Probation settings (lane M3); each form names where it came from. */
const SETTINGS='/lifecycle/probation/settings';
const back=(data:FormData)=>data.get('returnTo')==='settings'?{page:SETTINGS,hash:'#access'}:{page:PAGE,hash:''};
const text=(data:FormData,name:string)=>String(data.get(name)??'').trim();
const optional=(data:FormData,name:string)=>text(data,name)||null;

/** Runs one Access command; the database decides authority. Redirects back with a message either way. */
async function run(data:FormData,work:()=>Promise<string>):Promise<never>{
 await requireScopedLifecycleModule();
 const {page,hash}=back(data);
 let message:string;
 try{message=await work();}
 catch(error){unstable_rethrow(error);redirect(page+'?error='+encodeURIComponent(publicErrorMessage(error))+hash);}
 revalidatePath(page);
 redirect(page+'?toast='+encodeURIComponent(message)+hash);
}

export async function saveSuperiorRuleAction(data:FormData){
 const session=await requireScopedLifecycleModule(),t=await getTranslations('probationAccess');
 const enabled=data.get('enabled')==='on';
 await run(data,async()=>{
  // With the rule off, its two choices are kept as ticked but give nothing (app.probation_superior_rule).
  await saveProbationSuperiorRule(session,{enabled,view:data.get('view')==='on',recordDeclined:data.get('declined')==='on',expectedRevision:Number(text(data,'revision'))});
  return enabled?t('superiors.saved'):t('superiors.savedOff');
 });
}

export async function saveRoleAction(data:FormData){
 const session=await requireScopedLifecycleModule(),t=await getTranslations('probationAccess');
 const roleId=optional(data,'roleId'),name=text(data,'name');
 await run(data,async()=>{
  await saveProbationAccessRole(session,{roleId,name,permissions:data.getAll('permission').map(String),expectedRevision:Number(text(data,'revision')||'0')});
  return roleId?t('roles.saved',{name}):t('roles.created',{name});
 });
}

export async function retireRoleAction(data:FormData){
 const session=await requireScopedLifecycleModule(),t=await getTranslations('probationAccess');
 const name=text(data,'name');
 await run(data,async()=>{await retireProbationAccessRole(session,{roleId:text(data,'roleId'),expectedRevision:Number(text(data,'revision'))});return t('roles.deleted',{name});});
}

const scope=(data:FormData)=>({businessGroupId:optional(data,'businessGroupId'),companyId:optional(data,'companyId'),validFrom:text(data,'validFrom'),validTo:optional(data,'validTo')});

export async function addMemberAction(data:FormData){
 const session=await requireScopedLifecycleModule(),t=await getTranslations('probationAccess');
 await run(data,async()=>{
  await addProbationAccessMember(session,{roleId:text(data,'roleId'),userId:text(data,'userId'),...scope(data)});
  return t('members.added',{name:text(data,'personName'),role:text(data,'roleName')});
 });
}

export async function changeMemberAction(data:FormData){
 const session=await requireScopedLifecycleModule(),t=await getTranslations('probationAccess');
 await run(data,async()=>{await changeProbationAccessMember(session,{memberId:text(data,'memberId'),...scope(data)});return t('members.changed',{name:text(data,'personName')});});
}

export async function revokeMemberAction(data:FormData){
 const session=await requireScopedLifecycleModule(),t=await getTranslations('probationAccess');
 await run(data,async()=>{await revokeProbationAccessMember(session,{memberId:text(data,'memberId')});return t('members.removed',{name:text(data,'personName'),role:text(data,'roleName')});});
}
