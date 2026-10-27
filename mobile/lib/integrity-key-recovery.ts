/** Fresh authenticated inventory is authority; enrollment caches never establish current key validity. */
import type {z} from 'zod';
import {IntegrityKeyReceipt,IntegrityRevokeIntent} from '../../lib/mobile-integrity-contract';
import {apiPost} from './api';
import {UnavailableError} from './errors';
export type IntegrityKey=z.infer<typeof IntegrityKeyReceipt>;
export async function revokeIntegrityKey(employmentId:string,key:IntegrityKey){
  const original=IntegrityKeyReceipt.parse(key),input=IntegrityRevokeIntent.parse({keyId:original.keyId});
  const result=await apiPost('integrity/revoke',input,{employmentId});
  if(result.outcome==='revoked'){
    if(result.key.revokedAt===null||JSON.stringify({...original,revokedAt:null})!==JSON.stringify({...result.key,revokedAt:null}))throw new UnavailableError();
  }
  return result;
}
