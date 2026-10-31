'use server';
import {z} from 'zod';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {decideLetter,delegateLetterApproval,bulkDecideLetters} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
export type LetterApprovalActionState={error:string}|null;
const witness=z.object({letterId:z.uuid(),expectedRevisionId:z.uuid(),expectedLockVersion:z.number().int().min(1).max(1_000_000_000)}).strict();
const value=(form:FormData,key:string)=>typeof form.get(key)==='string'?form.get(key) as string:'';
function formWitness(form:FormData){const lock=value(form,'expectedLockVersion');return witness.safeParse({letterId:value(form,'letterId'),expectedRevisionId:value(form,'expectedRevisionId'),expectedLockVersion:/^[1-9]\d{0,9}$/.test(lock)?Number(lock):NaN});}
function failure(error:unknown):LetterApprovalActionState{return {error:error instanceof LetterWorkflowError?error.code:'unavailable'};}
function refresh(){for(const path of ['/letters/approval','/letters/generate','/letters/register','/letters/reports'])revalidatePath(path);}
export async function decideApproval(_previous:LetterApprovalActionState,form:FormData):Promise<LetterApprovalActionState>{
 const head=formWitness(form),action=value(form,'decision'),comment=value(form,'comment');if(!head.success||!['approve','reject','return'].includes(action)||comment.length>2000)return {error:'invalid'};
 const ctx=await getSession();
 try{await decideLetter(ctx,{...head.data,decision:{action:action as 'approve'|'reject'|'return',comment,confirmSignature:value(form,'confirmSignature')==='yes'}});}catch(error){return failure(error);}
 refresh();redirect('/letters/approval/'+head.data.letterId+'?notice=decided');
}
export async function delegateApproval(_previous:LetterApprovalActionState,form:FormData):Promise<LetterApprovalActionState>{
 const head=formWitness(form),delegate=z.uuid().safeParse(value(form,'delegateUserId')),reason=value(form,'comment');if(!head.success||!delegate.success||reason.length>2000)return {error:'invalid'};
 const ctx=await getSession();
 try{await delegateLetterApproval(ctx,{...head.data,delegateUserId:delegate.data,reason});}catch(error){return failure(error);}
 refresh();redirect('/letters/approval/'+head.data.letterId+'?notice=delegated');
}
export async function bulkApprove(_previous:LetterApprovalActionState,form:FormData):Promise<LetterApprovalActionState>{
 const encoded=value(form,'selection'),comment=value(form,'comment');if(!encoded||encoded.length>70_000||comment.length>2000)return {error:'invalid'};
 let selection:unknown;try{selection=JSON.parse(encoded);}catch{return {error:'invalid'};}
 const selected=z.array(witness).min(1).max(100).refine(rows=>new Set(rows.map(row=>row.letterId)).size===rows.length).safeParse(selection);if(!selected.success)return {error:'invalid'};
 const ctx=await getSession();
 // Preserve the exact revisions reviewed in the browser. Never refresh a stale witness here.
 try{await bulkDecideLetters(ctx,{letters:selected.data,decision:{action:'approve',comment,confirmSignature:value(form,'confirmSignature')==='yes'}});}catch(error){return failure(error);}
 refresh();redirect('/letters/approval?notice=completed');
}
