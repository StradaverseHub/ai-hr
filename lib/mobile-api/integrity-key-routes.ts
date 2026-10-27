/** Authenticated key recovery only. No enrollment, hardware policy or attendance acceptance. */
import {z} from 'zod';
import {ModuleNotEnabledError} from '../../core/entitlements';
import {listOwnIntegrityKeys,revokeOwnIntegrityKey,IntegrityKeyError,OwnClockEmploymentUnavailableError} from '../../packs/attendance/mobile-integrity-recovery';
import * as C from '../mobile-integrity-contract';
import {mobileRoute,MobileBadRequest,type MobileSessionResolver} from './handler';
import {mobileInput} from './body';
import {integrityEmployment} from './integrity-request';
export function createIntegrityKeyHttpHandlers(resolve?:MobileSessionResolver){
  function route<S extends z.ZodType>(schema:S,fn:Parameters<typeof mobileRoute<S>>[1]){
    return mobileRoute(schema,async(ctx,req)=>{
      try{return await fn(ctx,req);}
      catch(error){
        if(error instanceof ModuleNotEnabledError)return {outcome:'unavailable',code:'module_unavailable'} as z.input<S>;
        if(error instanceof OwnClockEmploymentUnavailableError)return {outcome:'refused',code:'subject_unavailable'} as z.input<S>;
        if(error instanceof IntegrityKeyError)return {outcome:'refused',code:'key_unavailable'} as z.input<S>;
        throw error;
      }
    },resolve);
  }
  return {
    keys:route(C.IntegrityKeysResult,async(ctx,req)=>({outcome:'keys',items:await listOwnIntegrityKeys(ctx,await integrityEmployment(ctx,req))})),
    revoke:route(C.IntegrityRevocationResult,async(ctx,req)=>{
      const id=await integrityEmployment(ctx,req),input=C.IntegrityRevokeIntent.safeParse(await mobileInput(req,256));
      if(!input.success)throw new MobileBadRequest('Invalid integrity command');
      return {outcome:'revoked',key:await revokeOwnIntegrityKey(ctx,{...input.data,employmentId:id})};
    }),
  };
}
