/** Closed TEST observer wire values. They supply no native authority. */
import {z} from 'zod';
export const reviewObservationActions=['employees.bank.maintain','org.position.archive']as const;
export type ReviewObservationAction=typeof reviewObservationActions[number];
export const reviewObservationScope=z.object({tenantId:z.guid(),userId:z.guid(),reviewId:z.guid(),action:z.enum(reviewObservationActions)}).strict();
export const reviewObservationRoot=z.object({pid:z.number().int().min(2),started:z.string().min(20).max(80),xid:z.string().regex(/^[1-9][0-9]{0,19}(?![\s\S])/),login:z.literal('ai_hr_app'),database:z.string().min(1)}).strict();
/** Closed native ACL observations only; never principal/capability admission. */
export const reviewObservationAclObservation=z.object({kind:z.literal('UNINSTALLED_REWARDS_OBSERVER_ACL_OBSERVATION'),releaseAuthorized:z.literal(false),action:z.enum(reviewObservationActions),stage:z.enum(['owner-before-revoke','owner-after-commit','app-first-effective','app-direct','app-after-effective']),allowed:z.boolean(),root:reviewObservationRoot}).strict();
const pre=z.object({armed:z.boolean(),priorSeq:z.number().int().nullable(),priorHash:z.string().nullable()}).strict().nullable();
export const reviewObservationResult=z.object({phase:z.enum(['armed','written','recorded','completed']).nullable(),pre}).strict();
export function reviewObservationNativeBody(source:string){
 const start='LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$',end='END $body$;';
 if(source.split(start).length!==2||source.split(end).length!==2)throw Error('Exact test observer source required');
 const tail=source.split(start)[1],body=tail.split(end)[0]+'END ';
 if(!body.startsWith('\nDECLARE ')||!tail.slice(body.length-4).startsWith(end))throw Error('Exact test observer source required');
 return body;
}

/** Closed test-frame lifecycle. Native callers supply ONLY fixed parent SQL and
 * a real Drizzle/postgres nested owner; models cannot attest native settlement. */
export type ReviewObservationFrame=Readonly<{open:()=>PromiseLike<unknown>;rollback:()=>PromiseLike<unknown>;release:()=>PromiseLike<unknown>}>;
export async function runReviewObservationRefusal<Lease>(signal:AbortSignal,frame:ReviewObservationFrame,scope:(work:(lease:Lease)=>Promise<never>)=>PromiseLike<unknown>,work:(lease:Lease)=>PromiseLike<unknown>,verify:(error:unknown)=>void,poison:(error:Error)=>void){
 signal.throwIfAborted();
 const unexpected=Error('Native test observer statement unexpectedly returned');
 let opened=false,openFailed=false,openError:unknown,scopeAttempted=false,entered=false,repeated=false,callbackFailed=false,callbackError:unknown,ownerFailed=false,ownerError:unknown,returned=false;
 let rolledBack=false,rollbackFailed=false,rollbackError:unknown,released=false,releaseFailed=false,releaseError:unknown;
 try{await frame.open();opened=true;}catch(error){openFailed=true;openError=error;}
 // An abort during open cannot skip the mandatory parent-frame restoration.
 if(opened&&!signal.aborted){
  scopeAttempted=true;
  try{
   await scope(async lease=>{
    if(entered){repeated=true;throw Error('Repeated native test observer scope admission');}entered=true;
    try{
     signal.throwIfAborted();await work(lease);signal.throwIfAborted();returned=true;throw unexpected;
    }catch(error){callbackFailed=true;callbackError=error;throw error;}
   });
  }catch(error){ownerFailed=true;ownerError=error;}
 }
 // The nested owner MUST settle before these parent commands. Even a failed
 // open may have reached PostgreSQL, so rollback is always attempted. Never
 // release after failed rollback: that could merge uncertain negative work.
 try{await frame.rollback();rolledBack=true;}catch(error){rollbackFailed=true;rollbackError=error;}
 if(rolledBack){try{await frame.release();released=true;}catch(error){releaseFailed=true;releaseError=error;}}
 const uncertain=!opened||!rolledBack||!released||scopeAttempted&&(!entered||repeated||!callbackFailed||!ownerFailed||!Object.is(callbackError,ownerError));
 if(uncertain){
  const errors:unknown[]=[],add=(error:unknown)=>{if(!errors.some(value=>Object.is(value,error)))errors.push(error);};
  if(callbackFailed)add(callbackError);if(ownerFailed)add(ownerError);if(openFailed)add(openError);if(signal.aborted)add(signal.reason);
  if(rollbackFailed)add(rollbackError);if(releaseFailed)add(releaseError);
  if(scopeAttempted&&!ownerFailed)add(Error('Native test observer nested owner returned without rollback refusal'));
  if(repeated)add(Error('Native test observer nested owner repeated its callback'));
  const failed=()=>errors.length===1?errors[0]:new AggregateError(errors,'Native test observer callback and parent frame restoration refused');
  try{poison(Error('Native test observer frame restoration uncertain; successors refused',{cause:failed()}));}catch(error){add(error);}
  throw failed();
 }
 // Verification is a NEW admission after BOTH driver and native parent frame
 // settlement. It cannot run on abort, unexpected success or uncertain cleanup.
 signal.throwIfAborted();if(returned)throw unexpected;verify(callbackError);
}
