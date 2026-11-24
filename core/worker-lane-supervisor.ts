/** The lane supervisor of the protected import worker (ADR 0181 J1.2, owner decision 24 November 2026: "child
 * processes"). With AIHR_WORKER_LANES set, aihr-bank-import.service's main process (scripts/bank-import-runner.ts)
 * opens no database connection and loads no job handler. It starts one child Node process that serves every lane
 * (it runs the singleton ticks and is the fallback for every lane) and one child per dedicated lane, each with its
 * own owner connection and app pool (db/capacity.ts). The unit file and the root worker tools are unchanged: the
 * children live in the unit's control group, so a stop, drain or rollback of the unit covers them, and removing the
 * key returns to a single process.
 *
 * Exit rules, so systemd's Restart=on-failure brings the whole worker back whenever something is wrong:
 *  - a stop request (SIGTERM/SIGINT to the main process) is forwarded to every child, and the supervisor exits 0 only
 *    after every child has exited 0;
 *  - a child that exits for any reason without a stop request (a crash, the stall watchdog, a lost database, even
 *    status 0) stops the other children and the supervisor exits WORKER_UNEXPECTED_EXIT_CODE;
 *  - a child that fails while stopping makes the stop fail too;
 *  - after a failure the other children get FAILURE_DRAIN_MS to finish their unit before they are killed.
 * With --once each child runs one pass and its exit is expected. Pure: the caller passes spawn, signal wiring and exit. */
export const WORKER_UNEXPECTED_EXIT_CODE=75;
export const FAILURE_DRAIN_MS=120_000;

export type SupervisedChild={
 pid?:number;
 kill(signal:NodeJS.Signals):boolean;
 once(event:'exit',listener:(code:number|null,signal:NodeJS.Signals|null)=>void):unknown;
 once(event:'error',listener:(error:Error)=>void):unknown;
};
export type WorkerLaneChildSpec={name:string;env:Record<string,string|undefined>};
export type WorkerLaneSupervisorOptions={
 children:readonly WorkerLaneChildSpec[];
 spawn(spec:WorkerLaneChildSpec):SupervisedChild;
 once?:boolean;
 log?(line:string):void;
 exit(code:number):void;
 setTimeout?(fn:()=>void,ms:number):{unref?():unknown};
};
export type WorkerLaneSupervisor={stop(signal:NodeJS.Signals):void;readonly failed:boolean;readonly running:readonly string[]};

/** The children for a set of dedicated lanes: the all-lane child first, then one per lane. Each child inherits the
 * protected environment except the supervisor's own key, so a child never supervises. */
export function workerLaneChildren(env:Record<string,string|undefined>,dedicated:readonly string[]):WorkerLaneChildSpec[]{
 const base={...env,AIHR_WORKER_LANES:undefined};
 return [{name:'all lanes',env:{...base,AIHR_WORKER_LANE:undefined}},...dedicated.map(lane=>({name:`lane ${lane}`,env:{...base,AIHR_WORKER_LANE:lane}}))];
}

export function superviseWorkerLanes(options:WorkerLaneSupervisorOptions):WorkerLaneSupervisor{
 const log=options.log??(line=>console.error(line));
 const later=options.setTimeout??((fn,ms)=>setTimeout(fn,ms));
 const live=new Map<string,SupervisedChild>();
 let stopping=false,failed=false,exited=false;
 const finishIfDone=()=>{
  if(live.size||exited)return;
  exited=true;
  log(failed?`Import worker lanes stopped after a failure; exiting with status ${WORKER_UNEXPECTED_EXIT_CODE} so systemd restarts the worker.`:'Import worker lanes stopped.');
  options.exit(failed?WORKER_UNEXPECTED_EXIT_CODE:0);
 };
 const stopAll=(signal:NodeJS.Signals)=>{for(const child of live.values())child.kill(signal);};
 const fail=(reason:string)=>{
  log(reason);
  failed=true;
  if(!stopping){
   stopping=true;stopAll('SIGTERM');
   // A child that never finishes its unit must not keep the worker from restarting.
   later(()=>{if(live.size){log(`Import worker lanes did not stop within ${FAILURE_DRAIN_MS/1000} s after a failure; killing them.`);stopAll('SIGKILL');}},FAILURE_DRAIN_MS).unref?.();
  }
 };
 for(const spec of options.children){
  let child:SupervisedChild;
  try{child=options.spawn(spec);}
  catch{fail(`Import worker ${spec.name} could not start.`);continue;}
  live.set(spec.name,child);
  let settled=false;
  const ended=(code:number|null,signal:NodeJS.Signals|null)=>{
   if(settled)return;settled=true;live.delete(spec.name);
   const how=signal?`signal ${signal}`:`status ${code}`;
   if(code!==0||signal)fail(`Import worker ${spec.name} exited with ${how}${stopping?' while stopping':''}.`);
   else if(!stopping&&!options.once)fail(`Import worker ${spec.name} exited with status 0 without a stop request.`);
   finishIfDone();
  };
  child.once('exit',ended);
  child.once('error',()=>ended(null,null));
 }
 finishIfDone();
 return{
  stop(signal){if(!stopping)log(`Import worker lanes stopping (${signal}).`);stopping=true;stopAll(signal);},
  get failed(){return failed;},
  get running(){return[...live.keys()];},
 };
}
