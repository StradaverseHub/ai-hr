'use server';

import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {getBrowserCommandSession} from '@/lib/session';
import {isGroupAdmin} from '@/lib/authz-model';
import {setMandateStopSwitch,setJobTypeEnablement} from '@/core/mandates/mandates';
import {setAiCentreReadControl} from '@/core/ai-centre-inventory';

const PAGE='/control-tower/agents/features';
async function administrator(){
 const ctx=await getBrowserCommandSession();
 if(!ctx.userId||ctx.agent||!isGroupAdmin(ctx))throw Error('refused');
 return ctx;
}
async function failure():Promise<never>{
 const t=await getTranslations('aiCentre.controls');
 redirect(PAGE+'?error='+encodeURIComponent(t('saveFailed')));
}
function boolean(form:FormData,key:string):boolean{
 const value=form.get(key);if(value!=='true'&&value!=='false')throw Error('invalid');return value==='true';
}
export async function setAiCentreStopAction(form:FormData){
 try{
  const ctx=await administrator(),stopped=boolean(form,'stopped'),raw=form.get('generation');
  if(typeof raw!=='string'||!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw Error('invalid');
  await setMandateStopSwitch(ctx,stopped,{expectedGeneration:Number(raw),reason:stopped?'Administrator stopped AI Centre':'Administrator resumed AI Centre'});
 }catch{return failure();}
 revalidatePath('/control-tower','layout');revalidatePath('/assistant');
 redirect(PAGE+'?toast=saved#ai-centre-stop');
}
export async function setAiCentreFunctionAction(form:FormData){
 try{await setAiCentreReadControl(await administrator(),form.get('function'),boolean(form,'enabled'));}catch{return failure();}
 revalidatePath('/control-tower','layout');revalidatePath('/assistant');
 redirect(PAGE+'?toast=saved#ai-centre-functions');
}
export async function setAiCentreJobAction(form:FormData){
 try{await setJobTypeEnablement(await administrator(),{jobType:form.get('jobType'),enabled:boolean(form,'enabled'),
  maxValidityDays:Number(form.get('maxValidityDays')),maxRunsPerDay:Number(form.get('maxRunsPerDay'))});}catch{return failure();}
 revalidatePath('/control-tower','layout');
 redirect(PAGE+'?toast=saved#ai-centre-jobs');
}
