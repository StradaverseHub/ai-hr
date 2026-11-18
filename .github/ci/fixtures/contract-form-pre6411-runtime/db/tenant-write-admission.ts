import {createDatabaseAdmission} from './admission';

/** Serialize standalone tenant writes before checkout. Explicit transaction
 * composition bypasses this owner. No re-entry, retry or authority is implied. */
export function createTenantWriteAdmission(options:{capacity:number;maxWaiting:number;waitMs:number}){
 const gate=createDatabaseAdmission({...options,backgroundCapacity:options.capacity,perTenantCapacity:1});
 async function run<T>(tenant:string,write:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  const release=await gate.acquire(tenant,'interactive',signal);
  try{signal?.throwIfAborted();return await write();}
  finally{release();}
 }
 return {run,snapshot:gate.snapshot};
}
