'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getFreshSession} from '@/lib/session';
import {submitAssistantFeedbackDraft} from '@/core/assistant-feedback';
import {addFeedbackAttachment} from '@/core/feedback';
import {AssistantConversationError} from '@/lib/assistant-conversation-model';
/** The normal Feedback action is unchanged. This selected private draft is consumed by its canonical
 * writer once; attachment upload retains that existing owner's separate post-submission lifecycle. */
export async function submitAssistantFeedbackAction(formData:FormData){
 let saved:{feedbackId:string;created:boolean};const draftId=String(formData.get('assistantDraft')??'');
 try{saved=await submitAssistantFeedbackDraft({draftId,expectedRevision:Number(formData.get('draftRevision')),reporterEmploymentId:String(formData.get('reporterEmploymentId')??'')||null,category:String(formData.get('category')),title:String(formData.get('title')??''),description:String(formData.get('description')??''),expectedBehavior:String(formData.get('expectedBehavior')??'').trim()||null,expectedFunction:String(formData.get('expectedFunction')??'').trim()||null});}
 catch(error){const code=error instanceof AssistantConversationError?error.code:'unavailable';redirect('/feedback?assistantDraft='+encodeURIComponent(draftId)+'&draftError='+encodeURIComponent(code));}
 let attachmentFailed=false;
 if(saved.created){const ctx=await getFreshSession();for(const file of formData.getAll('attachments').filter((value):value is File=>value instanceof File&&value.size>0))try{await addFeedbackAttachment(ctx,{feedbackId:saved.feedbackId,fileName:file.name,mimeType:file.type||'application/octet-stream',content:Buffer.from(await file.arrayBuffer())});}catch{attachmentFailed=true;}}
 revalidatePath('/feedback');revalidatePath('/assistant');revalidatePath('/');
 redirect('/feedback?assistantDraft='+encodeURIComponent(draftId)+(attachmentFailed?'&draftAttachments=failed':''));
}
