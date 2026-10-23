'use server';
import {getSession} from '@/lib/session';
import {getTranslations} from 'next-intl/server';
import {revalidatePath} from 'next/cache';
import {redirect} from 'next/navigation';
import {saveMyTp3Draft,submitMyTp3,Tp3Error} from '@/packs/payroll/service';
import {readTp3FormInput,TP3_FORM_MARKER} from '@/lib/tp3-form-input';
import {publicErrorMessage} from '@/lib/public-error';
export async function myTp3FormAction(_previous:{error:string|null},data:FormData):Promise<{error:string|null}> {
  const s=await getSession(),t=await getTranslations('myTp3');
  const intent=String(data.get('intent')??'');
  if(data.get('tp3Form')!==TP3_FORM_MARKER||!['draft','submit'].includes(intent))return {error:t('invalid')};
  // Refuse malformed money before the legacy form reader can treat an unparseable string as blank.
  for(const [key,value] of data.entries())if(/^tp3_[cd]_/.test(key)&&(typeof value!=='string'||value.trim()!==''&&!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)))return {error:t('invalidMoney')};
  const rawRevision=String(data.get('revision')??'');
  const employmentId=String(data.get('employmentId')??'');
  if(!/^\d{1,9}$/.test(rawRevision)||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(employmentId))return {error:t('changed')};
  const input={...readTp3FormInput(data),employmentId,expectedRevision:Number(rawRevision)};
  try {
    if(intent==='draft')await saveMyTp3Draft(s,input);else await submitMyTp3(s,input);
  } catch(error) {return {error:error instanceof Tp3Error?publicErrorMessage(error):t('changed')};}
  revalidatePath('/me/tp3');revalidatePath('/payroll/transactions/tp3');
  redirect(`/me/tp3?employmentId=${employmentId}&year=${input.assessmentYear}&saved=${intent}`);
}
