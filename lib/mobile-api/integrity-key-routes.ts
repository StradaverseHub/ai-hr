/** Authenticated key recovery only. No enrollment, hardware policy or attendance acceptance. */
import {z} from 'zod';
import {ModuleNotEnabledError} from '../../core/entitlements';
import {readOwnIntegrityKeyReceipt,listOwnIntegrityKeys,revokeOwnIntegrityKey,IntegrityKeyError,OwnClockEmploymentUnavailableError} from '../../packs/attendance/mobile-integrity-recovery';
import * as C from '../mobile-integrity-contract';
import {mobileRoute,MobileBadRequest,type MobileSessionResolver} from './handler';
import {mobileInput} from './body';
import {integrityEmployment} from './integrity-request';
export function createIntegrityKeyHttpHandlers(resolve?:MobileSessionResolver,version:1|2=1){
  const visibility=version===1?{platform:'ios' as const}:{};
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
    keyReceipt:route(version===1?C.IntegrityKeyLookupResult:C.IntegrityKeyLookupResultV2,async(ctx,req)=>{
      const id=await integrityEmployment(ctx,req),input=C.IntegrityKeyLookupIntent.safeParse(await mobileInput(req,256));
      if(!input.success)throw new MobileBadRequest('Invalid integrity receipt selector');
      return {outcome:'key_receipt' as const,key:await readOwnIntegrityKeyReceipt(ctx,{...input.data,employmentId:id},visibility)};
    }),
    keys:route(version===1?C.IntegrityKeysResult:C.IntegrityKeysResultV2,async(ctx,req)=>({outcome:'keys' as const,items:await listOwnIntegrityKeys(ctx,await integrityEmployment(ctx,req),visibility)})),
    revoke:route(version===1?C.IntegrityRevocationResult:C.IntegrityRevocationResultV2,async(ctx,req)=>{
      const id=await integrityEmployment(ctx,req),input=C.IntegrityRevokeIntent.safeParse(await mobileInput(req,256));
      if(!input.success)throw new MobileBadRequest('Invalid integrity command');
      return {outcome:'revoked' as const,key:await revokeOwnIntegrityKey(ctx,{...input.data,employmentId:id},visibility)};
    }),
  };
}
