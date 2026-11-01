'use server';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {configureRunner} from '@/lib/runner-control';
import type {RunnerActionState} from '@/lib/runner-control-model';
export async function configureRunnerAction(_previous:RunnerActionState,form:FormData):Promise<RunnerActionState> {
 try {
  const enabled=String(form.get('enabled')??'');
  if(!['true','false'].includes(enabled))throw new Error('Choose an activation state.');
  const scheduleType=String(form.get('scheduleType')??'unchanged');
  if(!['unchanged','interval','time'].includes(scheduleType))throw new Error('Choose a valid schedule.');
  await configureRunner(await getSession(),{
   id:String(form.get('id')??''),revision:String(form.get('revision')??''),enabled:enabled==='true',
   schedule:scheduleType==='unchanged'?null:scheduleType==='interval'?{minutes:Number(form.get('minutes'))}:{time:String(form.get('time')??'')},
  });
  revalidatePath('/admin/scheduled-actions');return {ok:true,error:null};
 }catch{return {ok:false,error:'saveFailed'};}
}
