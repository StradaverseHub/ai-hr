import {AsyncLocalStorage} from 'node:async_hooks';
import {createDatabaseAdmission} from './admission';
import {databaseReadSignal,withBackgroundDatabaseWork,withDatabaseReadCancellation} from './workload';

/** Admit a logical passive read BEFORE it fans out. This gate never borrows a
 * connection. Nested composition stays in the same logical operation, while
 * each actual query still enters the physical pool gate and its own authority. */
export function createBackgroundReadAdmission(options: {capacity:number;maxWaiting:number;waitMs:number}) {
 const gate=createDatabaseAdmission({...options,backgroundCapacity:options.capacity});
 const scope=new AsyncLocalStorage<{tenant:string;active:boolean}>();
 async function run<T>(tenant:string,read:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  signal=databaseReadSignal(signal);
  const ownedRead=()=>withBackgroundDatabaseWork(()=>signal?withDatabaseReadCancellation(signal,read):read());
  tenant=tenant.toLowerCase();
  const inherited=scope.getStore();
  if(inherited?.active){
   if(inherited.tenant!==tenant)throw new Error('A passive read cannot compose a different tenant operation.');
   return ownedRead();
  }
  const timing=(globalThis as typeof globalThis & {__aihrPerfBeginBackgroundRead?:()=>{acquired:()=>void;finished:()=>void}}).__aihrPerfBeginBackgroundRead?.();
  const operation={tenant,active:true};let release:(()=>void)|undefined;
  try{
   release=await gate.acquire(tenant,'background',signal);timing?.acquired();
   signal?.throwIfAborted();return await scope.run(operation,ownedRead);
  }finally{operation.active=false;release?.();timing?.finished();}
 }
 return {run,snapshot:gate.snapshot};
}
