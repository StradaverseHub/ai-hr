/** Browser polling of one roster (or Schedule Group) bulk job: shared by the progress panel and the grid's bulk bar,
 * kept free of React so the grid's module graph stays small. */
import {rosterBulkActive,type RosterBulkJobView} from './roster-bulk-job';

const pollMs=2000;

/** Polls one roster (or Schedule Group) bulk job until it ends. Shared by the panel and the grid's bulk bar. */
export function pollRosterBulkJob(endpoint:string,id:string,onUpdate:(job:RosterBulkJobView)=>void,onError:(message:string)=>void){
 let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
 const poll=async()=>{
  let again=true;
  try{
   const response=await fetch(`${endpoint}/${id}`,{cache:'no-store'});
   const payload=await response.json().catch(()=>null);
   if(!response.ok||!payload?.job)throw new Error(payload?.error??'');
   if(alive){onUpdate(payload.job);again=rosterBulkActive(payload.job.state);}
  }catch(e){if(alive)onError((e as Error).message||'');}
  finally{if(alive&&again)timer=setTimeout(poll,pollMs);}
 };
 void poll();
 return()=>{alive=false;if(timer)clearTimeout(timer);};
}
/** Resolves with the job once it has ended (the grid's bulk bar awaits it inside its transition). */
export function waitForRosterBulkJob(endpoint:string,id:string):Promise<RosterBulkJobView>{
 return new Promise(resolve=>{const stop=pollRosterBulkJob(endpoint,id,job=>{if(!rosterBulkActive(job.state)){stop();resolve(job);}},()=>{});});
}

