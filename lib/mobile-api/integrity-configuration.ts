/** Server assembly owns integrity settings. A phone never selects a policy or verifier. */
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
export type EnrollmentCommitGuard=(tx:Tx,ctx:SessionContext,employmentId:string,settings:unknown)=>Promise<void>;
export class IntegrityConfigurationUnavailable extends Error {
 constructor(readonly reason:'not_configured'|'configuration_unavailable'){
  super('Integrity configuration unavailable');this.name='IntegrityConfigurationUnavailable';
 }
}
export type IntegrityConfigurationReader=(ctx:SessionContext,employmentId:string,signal:AbortSignal)=>Promise<unknown|null>;
/** The caller authorizes the selected subject before invoking this reader. Late callbacks cannot
 * resume a timed-out operation; the reader receives cancellation for its own resource cleanup. */
export function createIntegrityConfigurationReader<S extends z.ZodType>(schema:S,configuration:IntegrityConfigurationReader,timeout=3000){
 if(!Number.isInteger(timeout)||timeout<1||timeout>10000)throw new Error('Invalid configuration deadline');
 return async(ctx:SessionContext,id:string,signal:AbortSignal):Promise<z.output<S>>=>{
  const unavailable=()=>new IntegrityConfigurationUnavailable('configuration_unavailable');
  if(signal.aborted)throw unavailable();
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,abort=()=>{};
  const stopped=new Promise<never>((_,reject)=>{
   abort=()=>{controller.abort();reject(unavailable());};
   signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,timeout);
  });
  try{
   const reading=Promise.resolve().then(()=>{
    if(controller.signal.aborted)throw unavailable();return configuration(ctx,id,controller.signal);
   });
   const raw=await Promise.race([reading,stopped]);
   if(controller.signal.aborted||signal.aborted)throw unavailable();
   if(raw===null)throw new IntegrityConfigurationUnavailable('not_configured');
   const parsed=schema.safeParse(raw);if(!parsed.success)throw unavailable();return parsed.data;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
 };
}
