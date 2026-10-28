'use server';
import {redirect} from 'next/navigation';
import {getBrowserCommandSession} from '@/lib/session';
import {recordOwnGovernedJobFeedback,eraseOwnGovernedJobFeedback,GOVERNED_JOB_FEEDBACK_OUTCOMES} from '@/core/module-agent-releases';
export async function saveGovernedJobFeedbackAction(form:FormData){
 const jobId=String(form.get('jobId')??''),outcome=String(form.get('outcome')??''),consented=form.get('consented')==='yes';
 try{const ctx=await getBrowserCommandSession();if(!consented||!GOVERNED_JOB_FEEDBACK_OUTCOMES.some(value=>value===outcome))throw Error();
  await recordOwnGovernedJobFeedback(ctx,{jobId,outcome:outcome as typeof GOVERNED_JOB_FEEDBACK_OUTCOMES[number],consented:true});
 }catch{redirect('/assistant?error=governed_job');}
 redirect('/assistant?governed='+encodeURIComponent(jobId));
}
export async function eraseGovernedJobFeedbackAction(){
 try{const ctx=await getBrowserCommandSession();await eraseOwnGovernedJobFeedback(ctx);}catch{redirect('/assistant?ownClear=unavailable');}
 redirect('/assistant?ownClear=ratings');
}
