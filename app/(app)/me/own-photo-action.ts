
'use server';
import {ProfileRoutingError} from '@/core/profile-routing';
import {EssProfileError} from '@/lib/personnel-ess-model';
import {getSession} from '@/lib/session';
import {setOwnPersonPhoto,PHOTO_MAX_BYTES} from '@/core/person-photo';
import {revalidatePath} from 'next/cache';
import {redirect} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
export async function saveOwnPhotoAction(data:FormData){
 const s=await getSession(),t=await getTranslations('essProfile');
 const employmentId=String(data.get('employmentId')??'');
 try{
  const file=data.get('photo');if(!(file instanceof File)||file.size<1||file.size>PHOTO_MAX_BYTES)throw new Error('invalid');
  await setOwnPersonPhoto(s,{employmentId,content:Buffer.from(await file.arrayBuffer()),fileName:file.name});
 }catch(error){const key=error instanceof ProfileRoutingError||error instanceof EssProfileError&&error.code==='unavailable'?'photoRouteUnavailable':error instanceof EssProfileError&&error.code==='stale'?'photoAlreadyPending':'photoSaveFailed';redirect(`/me?employmentId=${encodeURIComponent(employmentId)}&error=${encodeURIComponent(t(key))}`);}
 revalidatePath('/me');redirect(`/me?employmentId=${encodeURIComponent(employmentId)}`);
}
