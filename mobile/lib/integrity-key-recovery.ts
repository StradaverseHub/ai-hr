/** Fresh authenticated inventory is authority; enrollment caches never establish current key validity. */
import type {z} from 'zod';
import {IntegrityKeyReceiptV2,IntegrityRevokeIntent,IntegrityKeyLookupIntent} from '../../lib/mobile-integrity-contract';
import {apiPost} from './api';
import {UnavailableError} from './errors';
export type IntegrityKey=z.infer<typeof IntegrityKeyReceiptV2>;
export async function revokeIntegrityKey(employmentId:string,key:IntegrityKey){
  const original=IntegrityKeyReceiptV2.parse(key),input=IntegrityRevokeIntent.parse({keyId:original.keyId});
  const result=await apiPost(original.platform==='ios'?'integrity/revoke':'v2/integrity/revoke',input,{employmentId});
  if(result.outcome==='revoked'){
    if(result.key.revokedAt===null||JSON.stringify({...original,revokedAt:null})!==JSON.stringify({...result.key,revokedAt:null}))throw new UnavailableError();
  }
  return result;
}

/** No SDK call or enrollment replay is implied by an absent server receipt. */
export async function lookupIntegrityKeyReceipt(employmentId:string,originChallengeId:string){
  const input=IntegrityKeyLookupIntent.parse({originChallengeId});
  return apiPost('v2/integrity/key-receipt',input,{employmentId});
}
