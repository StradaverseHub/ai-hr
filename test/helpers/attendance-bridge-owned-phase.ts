/** Test-only ownership barrier: a deadline stops new work, never restoration. */
export class AttendanceBridgeOwnedPhases {
 private readonly pending=new Set<{stopAndDrain:()=>Promise<void>}>();
 private poisoned:Error|undefined;
 assertReady(){if(this.poisoned)throw this.poisoned;if(this.pending.size)throw Error('Attendance bridge ownership phase remains unsettled');}
 start(work:(step:<T>(action:()=>PromiseLike<T>)=>Promise<T>)=>Promise<void>,restore:()=>Promise<void>,stop:()=>void=()=>{}){
  this.assertReady();
  let stopped=false,settle!:()=>void;
  const settled=new Promise<void>(resolve=>{settle=resolve;});
  const phase={stopAndDrain:async()=>{stopped=true;
   try{stop();}catch(error){this.poisoned=error instanceof Error?error:new Error('Attendance bridge stop failed',{cause:error});}
   await settled;if(this.poisoned)throw this.poisoned;
  }};
  this.pending.add(phase); // Registered before work's first microtask or checkout.
  const result=Promise.resolve().then(async()=>{
   try{
    await work(async action=>{if(stopped||this.poisoned)throw Error('Attendance bridge phase stopped');const value=await action();return value;});
   }finally{
    try{await restore();}catch(error){this.poisoned=error instanceof Error?error:new Error('Attendance bridge restoration failed',{cause:error});throw this.poisoned;}
    finally{this.pending.delete(phase);settle();}
   }
  });
  void result.catch(()=>undefined); // A deadline may detach the test's await; drain still owns settlement.
  return{result,stopAndDrain:phase.stopAndDrain};
 }
 async drain(){for(const phase of [...this.pending])await phase.stopAndDrain();this.assertReady();}
}
