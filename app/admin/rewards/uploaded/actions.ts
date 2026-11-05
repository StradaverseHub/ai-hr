'use server';
import {getSession} from '@/lib/session';
import {createUploadedRewards} from '@/packs/rewards/uploaded-awards';
import {redirect} from 'next/navigation';
export async function createUploadedAction(fd:FormData){let id='',error='';try{id=await createUploadedRewards(await getSession(),{companyId:String(fd.get('companyId')),businessUnitId:String(fd.get('businessUnitId')),cycleId:String(fd.get('cycleId')),year:Number(fd.get('year')),snapshotDate:String(fd.get('snapshotDate')),reason:String(fd.get('reason'))});}catch(e){error=e instanceof Error?e.message:'Unable to create review.';}redirect(id?`/rewards/${id}/uploaded`:`/admin/rewards/uploaded?error=${encodeURIComponent(error)}`);}
