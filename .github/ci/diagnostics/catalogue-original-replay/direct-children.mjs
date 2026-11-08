/** Parent API/extraction sockets and the fixed adapter handle only.
 * The shared Python kernel exclusively owns the worker's descendant family.
 * This helper neither selects commands nor signals numeric PIDs/groups. */
export function directChildren(){
 const pending=new Map();let cancelled=false,finishing=false,stopFailed=false;
 function stop(row){try{row.stop(row.child);}catch{stopFailed=true;}}
 return Object.freeze({
  start(create,stopChild=child=>child.kill('SIGKILL')){
   if(cancelled||finishing)throw Error('Fixed replay child admission closed');
   const child=create();let settled;
   const done=new Promise(resolve=>{settled=resolve;});
   const row={child,stop:stopChild,done};pending.set(child,row);
   child.once('close',()=>{pending.delete(child);settled();});
   return child;
  },
  cancel(){if(cancelled)return;cancelled=true;for(const row of pending.values())stop(row);},
  async finish(){
   finishing=true;
   // Every start registers synchronously, before its caller can await work.
   // No successor may be admitted while this complete owned set drains.
   await Promise.all([...pending.values()].map(row=>row.done));
   return Object.freeze({cancelled,stopFailed});
  },
 });
}
