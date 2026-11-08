/** Closed TEST observer wire values. They supply no native authority. */
import {z} from 'zod';
export const reviewObservationActions=['employees.bank.maintain','org.position.archive']as const;
export type ReviewObservationAction=typeof reviewObservationActions[number];
export const reviewObservationScope=z.object({tenantId:z.guid(),userId:z.guid(),reviewId:z.guid(),action:z.enum(reviewObservationActions)}).strict();
export const reviewObservationRoot=z.object({pid:z.number().int().min(2),started:z.string().min(20).max(80),xid:z.string().regex(/^[1-9][0-9]{0,19}(?![\s\S])/),login:z.literal('ai_hr_app'),database:z.string().min(1)}).strict();
const pre=z.object({armed:z.boolean(),priorSeq:z.number().int().nullable(),priorHash:z.string().nullable()}).strict().nullable();
export const reviewObservationResult=z.object({phase:z.enum(['armed','written','recorded','completed']).nullable(),pre}).strict();
export function reviewObservationNativeBody(source:string){
 const start='LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$',end='END $body$;';
 if(source.split(start).length!==2||source.split(end).length!==2)throw Error('Exact test observer source required');
 const tail=source.split(start)[1],body=tail.split(end)[0]+'END ';
 if(!body.startsWith('\nDECLARE ')||!tail.slice(body.length-4).startsWith(end))throw Error('Exact test observer source required');
 return body;
}

import {controlledPolicyWait} from './rewards-audit-policy-controlled-wait';
/** Open/work are new admissions; rollback is mandatory cleanup after real open. */
export async function runReviewObservationRefusal(signal:AbortSignal,open:()=>PromiseLike<unknown>,work:()=>PromiseLike<unknown>,verify:(error:unknown)=>void,rollback:()=>Promise<void>,poison:(error:Error)=>void){
 signal.throwIfAborted();await open();
 await controlledPolicyWait(poison).run(async()=>{
  signal.throwIfAborted();let error:unknown;try{await work();}catch(caught){error=caught;}
  signal.throwIfAborted();verify(error);
 },rollback);
}
