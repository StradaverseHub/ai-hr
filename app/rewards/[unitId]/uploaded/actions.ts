'use server';
import {uploadedDecimal} from '@/packs/rewards/uploaded-awards-model';
import {getSession} from '@/lib/session';
import {previewUploadedRewards,saveUploadedRewards,confirmUploadedRewards,adjustUploadedAward} from '@/packs/rewards/uploaded-awards';
import {revalidatePath} from 'next/cache';
import {redirect} from 'next/navigation';
export async function previewUploadedAction(id:string,raw:unknown){return previewUploadedRewards(await getSession(),id,raw);}
export async function saveUploadedAction(id:string,rows:unknown,revision:number,reason:string,evidence?:{name:string;mime:string;content:string}){await saveUploadedRewards(await getSession(),id,rows,revision,reason,evidence);revalidatePath(`/rewards/${id}`);}
export async function uploadedDecisionAction(fd:FormData){const id=String(fd.get('unitId'));let error='';try{const ctx=await getSession();if(fd.get('action')==='confirm')await confirmUploadedRewards(ctx,id,Number(fd.get('revision')),String(fd.get('reason')));else await adjustUploadedAward(ctx,id,String(fd.get('entryId')),Number(fd.get('revision')),{employmentId:String(fd.get('employmentId')),incrementType:fd.get('incrementType'),incrementBp:null,newBasicCents:uploadedDecimal(String(fd.get('newBasicMYR'))),newGrade:String(fd.get('newGrade'))||null,bonusCents:uploadedDecimal(String(fd.get('bonusMYR'))),lumpCents:uploadedDecimal(String(fd.get('lumpMYR'))),remarks:String(fd.get('reason'))},String(fd.get('reason')));revalidatePath(`/rewards/${id}`);}catch(e){error=e instanceof Error?e.message:'Unable to save.';}redirect(`/rewards/${id}/uploaded${error?'?error='+encodeURIComponent(error):''}`);}
