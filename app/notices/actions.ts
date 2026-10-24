'use server';

import { revalidatePath } from 'next/cache';
import {headers} from 'next/headers';
import {unstable_rethrow} from 'next/navigation';

import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { dismissNoticePopup, markNoticeViewed,acknowledgeNotice,NoticeError } from '@/core/notice';

/**
 * Notice view and popup markers use the recipient policy. The separate explicit acknowledgement
 * command binds the current content revision, actual recipient/login, timestamp and audit event.
 *
 * `getSession`, not `requireAdmin`: these are employee actions. The row an employee can touch is decided
 * by `app.is_self_person` in the policy, not by a role check here — so a forged noticeId simply updates
 * nothing rather than someone else's record.
 */

/** Mark a notice OPENED. First open only (the service's `firstViewedAt IS NULL` guard). A page load is not
 *  consent, and this must never be presented as one. */
export async function markNoticeViewedAction(formData: FormData) {
  const s = await getSession();
  const me = await myEmployment(s);
  if (!me) return;
  const noticeId = String(formData.get('noticeId') ?? '');
  if (!noticeId) return;
  await markNoticeViewed(s, noticeId, me.employmentId);
  revalidatePath('/notices');
  revalidatePath('/');
}

/** Dismiss the login popup for this notice. Popup-frequency state only: a 'once' notice stops popping up,
 *  an 'until_acknowledged' one ends when its current required revision is acknowledged or it expires. */
export async function dismissNoticePopupAction(formData: FormData) {
  const s = await getSession();
  const me = await myEmployment(s);
  if (!me) return;
  const noticeId = String(formData.get('noticeId') ?? '');
  if (!noticeId) return;
  await dismissNoticePopup(s, noticeId, me.employmentId);
  revalidatePath('/');
}

/** Explicit action against the version shown on the page; a posted employment remains subject to
 * the database's real current-person and retained recipient checks, including multiple employments. */
export async function acknowledgeNoticeAction(_prior:import('@/lib/notice-acknowledgement').NoticeAcknowledgementState,formData:FormData):Promise<import('@/lib/notice-acknowledgement').NoticeAcknowledgementState>{
 const s=await getSession();
 const single=(key:string)=>{const values=formData.getAll(key);return values.length===1&&typeof values[0]==='string'?values[0]:null;};
 const noticeId=single('noticeId'),employmentId=single('employmentId'),version=single('contentVersion');
 if(!noticeId||!employmentId||!version||!/^\d+$/.test(version))return {error:'unavailable'};
 const requestHeaders=await headers();let timestamp:string;
 try{
  const receipt=await acknowledgeNotice(s,noticeId,employmentId,Number(version),{reportedChannel:'web',reportedUserAgent:requestHeaders.get('user-agent')??undefined});
  timestamp=receipt.acknowledgedAt.toISOString();
 }catch(error){
  unstable_rethrow(error);
  for(let cause=error as {code?:string;cause?:unknown}|undefined;cause;cause=cause.cause as typeof cause){
   if(cause.code==='23514')return {error:'changed'};
   if(cause.code==='42501')return {error:'unavailable'};
  }
  return {error:error instanceof NoticeError?'unavailable':'failed'};
 }
 revalidatePath('/notices');revalidatePath('/notices/'+noticeId);revalidatePath('/tasks');revalidatePath('/');
 return {acknowledgedAt:timestamp};
}
