/** Concurrent leased work is refused immediately; it never waits behind another attachment render. */
import {masterDeliveryRequest,type MasterDeliveryRequest} from '../../lib/employee-master-delivery-model';
export function createSingleReportHandler(
  deliver:(request:MasterDeliveryRequest)=>Promise<unknown>,
  remove:(id:string,token:string)=>Promise<void>,
  cleanupFailed:()=>void=()=>console.error('Private report artifact cleanup unavailable; renderer expiry remains active.'),
) {
  let active=false;
  return async(input:unknown):Promise<unknown>=>{
    const request=masterDeliveryRequest.parse(input);
    if(request.op==='status')return deliver(request);
    if(active)return {outcome:'busy'};
    active=true;
    try{return await deliver(request);}
    finally{
      try{await remove(request.occurrenceId,request.leaseToken);}catch{cleanupFailed();}
      finally{active=false;}
    }
  };
}
