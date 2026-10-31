'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {issueLetter,voidLetter,setLetterRetention} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const value=(form:FormData,key:string)=>typeof form.get(key)==='string'?form.get(key) as string:'';
export type RegisterActionState={error:string}|null;
export async function updateRegister(_previous:RegisterActionState,form:FormData):Promise<RegisterActionState>{
 const letterId=value(form,'letterId'),action=value(form,'action'),revisionId=value(form,'expectedRevisionId'),lock=value(form,'expectedLockVersion'),reason=value(form,'reason');
 if(!uuid.test(letterId)||!['issue','void','retention'].includes(action)||!/^\d{1,9}$/.test(lock)||Number(lock)<1||reason.length>2000||action==='issue'&&!uuid.test(revisionId)||['issue','void'].includes(action)&&value(form,'confirm')!=='yes')return {error:'invalid'};
 const ctx=await getSession(),expectedLockVersion=Number(lock);
 try{
  if(action==='issue')await issueLetter(ctx,{letterId,expectedRevisionId:revisionId,expectedLockVersion});
  else if(action==='void')await voidLetter(ctx,{letterId,expectedLockVersion,reason});
  else await setLetterRetention(ctx,{letterId,expectedLockVersion,legalHold:value(form,'legalHold')==='yes',retainUntil:value(form,'retainUntil'),reason});
 }catch(error){return {error:error instanceof LetterWorkflowError?error.code:'unavailable'};}
 for(const path of ['/letters/register','/letters/reports','/me/letters'])revalidatePath(path);
 redirect('/letters/register/'+letterId+'?notice=saved');
}
