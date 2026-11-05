'use server';
import {getSession} from '@/lib/session';
import {publicErrorMessage} from '@/lib/public-error';
import {saveRewardSetupGrant} from '@/packs/rewards/access-policy';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
export async function setupGrantAction(fd:FormData){let error='';try{await saveRewardSetupGrant(await getSession(),{id:String(fd.get('id')??'')||null,revision:Number(fd.get('revision')),userId:String(fd.get('userId')),companyId:String(fd.get('companyId')??'')||null,role:fd.get('role'),validFrom:String(fd.get('validFrom')),validTo:String(fd.get('validTo')??'')||null,active:fd.get('active')==='on',reason:String(fd.get('reason'))});revalidatePath('/admin/rewards','layout');}catch(e){error=publicErrorMessage(e);}redirect('/admin/rewards/setup-access'+(error?'?error='+encodeURIComponent(error):''));}
