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

/** The real driver's nested owner MUST roll back before returning the original
 * callback failure. Raw SQL SAVEPOINT cannot isolate postgres.js error custody.
 * A model scope is not native rollback proof; the native caller supplies only
 * Drizzle tx.transaction or postgres TransactionSql.savepoint. */
export async function runReviewObservationRefusal<Lease>(signal:AbortSignal,scope:(work:(lease:Lease)=>Promise<never>)=>PromiseLike<unknown>,work:(lease:Lease)=>PromiseLike<unknown>,verify:(error:unknown)=>void,poison:(error:Error)=>void){
 signal.throwIfAborted();
 const unexpected=Error('Native test observer statement unexpectedly returned');
 let entered=false,callbackFailed=false,callbackError:unknown,ownerFailed=false,ownerError:unknown,returned=false;
 try{
  await scope(async lease=>{
   if(entered)throw Error('Repeated native test observer scope admission');entered=true;
   try{
    signal.throwIfAborted();await work(lease);signal.throwIfAborted();returned=true;throw unexpected;
   }catch(error){callbackFailed=true;callbackError=error;throw error;}
  });
 }catch(error){ownerFailed=true;ownerError=error;}
 if(!entered||!callbackFailed||!ownerFailed||!Object.is(callbackError,ownerError)){
  const errors:unknown[]=[],add=(error:unknown)=>{if(!errors.some(value=>Object.is(value,error)))errors.push(error);};
  if(callbackFailed)add(callbackError);if(ownerFailed)add(ownerError);if(signal.aborted)add(signal.reason);
  if(!ownerFailed)add(Error('Native test observer nested owner returned without rollback refusal'));
  const failed=()=>errors.length===1?errors[0]:new AggregateError(errors,'Native test observer callback and nested rollback refused');
  try{poison(Error('Native test observer nested rollback uncertain; successors refused',{cause:failed()}));}catch(error){add(error);}
  throw failed();
 }
 // Driver settlement is mandatory even after abort. Verification is a NEW
 // admission and cannot run until that settlement and a fresh signal check.
 signal.throwIfAborted();if(returned)throw unexpected;verify(callbackError);
}
