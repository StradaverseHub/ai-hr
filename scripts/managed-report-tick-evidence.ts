/** Finite installed-runner acceptance order, not a scheduler or a synthetic delivery result. */
export async function runManagedReportActualTicks(d:{activate():Promise<void>;observe(kind:'weekly'|'monthly'):Promise<unknown>;duplicates():Promise<unknown>;rollback():Promise<void>;checkpoint(details:unknown):Promise<void>}){
 let checks:{weekly:unknown;monthly:unknown;duplicates:unknown};
 try{
  await d.activate();
  const weekly=await d.observe('weekly'),monthly=await d.observe('monthly'),duplicates=await d.duplicates();
  checks={weekly,monthly,duplicates};
 }finally{await d.rollback();}
 // A failed delivery, duplicate check or canonical rollback never receives a positive checkpoint.
 const receipt={checks,cleanup:'VERIFIED' as const};await d.checkpoint(receipt);return receipt;
}
