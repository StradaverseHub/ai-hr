'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {scopedSession} from '@/lib/scope';
import {isCalendarDate} from '@/lib/calendar-date';
import {LetterModelError,type LetterField} from '@/lib/letter-model';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {letterCustomValues} from '@/lib/letter-form-values';
import {WorkforceAccessError} from '@/core/workforce-access';
import {getLetterTemplate,saveLetterAutomationRule,LETTER_AUTOMATION_TRIGGERS,type LetterAutomationTrigger} from '@/core/letters';
export type AutomationActionState={error:string;field?:string}|null;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function scalar(form:FormData,key:string){const values=form.getAll(key);return values.length===1&&typeof values[0]==='string'?values[0]:null;}
export async function saveAutomationSettings(_previous:AutomationActionState,form:FormData):Promise<AutomationActionState>{
 const companyId=scalar(form,'companyId'),templateId=scalar(form,'templateId'),trigger=scalar(form,'trigger'),ordinal=scalar(form,'expectedOrdinal'),enabled=scalar(form,'enabled'),startOn=scalar(form,'startOn'),versionId=scalar(form,'versionId');
 if(!companyId||!uuid.test(companyId)||!templateId||!uuid.test(templateId)||!trigger||!LETTER_AUTOMATION_TRIGGERS.includes(trigger as LetterAutomationTrigger)||!ordinal||!/^\d{1,9}$/.test(ordinal)||!['yes','no'].includes(enabled??'')||enabled==='yes'&&(!startOn||!isCalendarDate(startOn)||!versionId||!uuid.test(versionId)))return {error:'invalid'};
 const {s,scopeIds}=await scopedSession();if(!scopeIds.includes(companyId))return {error:'permission'};let fields:LetterField[]=[];
 try{
  let customValues;if(enabled==='yes'){
   const template=await getLetterTemplate(s,versionId!,{forGeneration:true});if(!template||template.root.companyId!==companyId||template.root.id!==templateId)return {error:'permission'};fields=template.fields.map(field=>field.definition);
   for(const key of new Set(form.keys()))if(key.startsWith('custom:')&&form.getAll(key).length!==1)return {error:'invalid'};
   customValues=letterCustomValues(form,fields);
  }
  await saveLetterAutomationRule(s,{companyId,templateId,trigger:trigger as LetterAutomationTrigger,expectedOrdinal:Number(ordinal),enabled:enabled==='yes',...(enabled==='yes'?{startOn:startOn!,customValues}: {})});
 }catch(error){if(error instanceof WorkforceAccessError)return {error:'permission'};if(error instanceof LetterModelError)return {error:'invalid',field:fields.find(field=>field.key===error.path)?.label};return {error:error instanceof LetterWorkflowError?error.code:'unavailable'};}
 revalidatePath('/letters/settings/automation');revalidatePath('/letters/settings');redirect('/letters/settings/automation?'+new URLSearchParams({companyId,notice:'saved'}));
}
