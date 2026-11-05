'use server';
import {getSession} from '@/lib/session';
import {changeRewardPermission,beginRewardViewAs,endRewardViewAs} from '@/packs/rewards/access-policy';
import {revalidatePath} from 'next/cache';
import {redirect} from 'next/navigation';
export async function rewardPermissionAction(raw:unknown){try{await changeRewardPermission(await getSession(),raw);revalidatePath('/admin/rewards/access');return{ok:true as const};}catch{return{ok:false as const};}}
export async function beginRewardViewAsAction(fd:FormData){let id:string;try{id=await beginRewardViewAs(await getSession(),String(fd.get('userId')??''));}catch{redirect('/admin/rewards/access?policyError=1');}redirect('/admin/rewards/access/view-as');}
export async function endRewardViewAsAction(){await endRewardViewAs(await getSession());redirect('/admin/rewards/access');}
export async function resetRewardPermissionsAction(reason:string){try{const{resetRewardRolePermissions}=await import('@/packs/rewards/access-policy');await resetRewardRolePermissions(await getSession(),reason);revalidatePath('/admin/rewards/access');return{ok:true as const};}catch{return{ok:false as const};}}
