import {describe,expect,it} from 'vitest';
import {IntegrityCapabilities,IntegrityClockResult,IntegrityEnrollmentIntent,IntegrityEnrollmentProof,IntegrityKeyReceipt,IntegrityKeysResult} from '../lib/mobile-integrity-contract';
const id='11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('integrity v1 compatibility and closed security outcomes',()=>{
  it('tolerates additive response fields and bounded unknown discovery features without retaining extra data',()=>{
    const response={outcome:'capabilities',protocol:1,platform:'ios',features:['key_enrollment','online_clock_assertion','future_known_by_newer_app'],offline:false,newMetadata:'private extra'};
    expect(IntegrityCapabilities.parse(response)).toEqual({...response,newMetadata:undefined});
    expect(IntegrityCapabilities.parse(response)).not.toHaveProperty('newMetadata');
    expect(IntegrityCapabilities.safeParse({...response,features:Array(17).fill('extra')}).success).toBe(false);
  });
  it('strips private extras from nested key and accepted-clock receipts',()=>{
    const key={keyId:id,originChallengeId:id,platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production',proofKind:'apple_key_proof',nativeKeyBinding:'a'.repeat(64),createdAt:'2026-10-27T00:00:00.000Z',revokedAt:null};
    expect(IntegrityKeysResult.parse({outcome:'keys',items:[{...key,receiptCiphertext:'private',vendorKeyId:'private'}]})).toEqual({outcome:'keys',items:[key]});
    const receipt={id,direction:'in',recordedAt:'2026-10-27T00:00:00.000Z',date:'2026-10-27',photoAvailable:false};
    expect(IntegrityClockResult.parse({outcome:'accepted',receipt:{...receipt,rawProof:'private'},support:'extra'})).toEqual({outcome:'accepted',receipt});
  });
  it('rejects trailing newlines in key IDs, proof bytes and receipt bindings',()=>{
    const proof={requestId:id,appInstallationId:id,challengeId:id,vendorKeyId:Buffer.alloc(32,7).toString('base64'),attestation:'YQ=='};
    expect(IntegrityEnrollmentProof.safeParse(proof).success).toBe(true);
    for(const field of ['vendorKeyId','attestation'] as const)expect(IntegrityEnrollmentProof.safeParse({...proof,[field]:proof[field]+'\n'}).success).toBe(false);
    const key={keyId:id,originChallengeId:id,platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production',proofKind:'apple_key_proof',nativeKeyBinding:'a'.repeat(64),createdAt:'2026-10-27T00:00:00.000Z',revokedAt:null};
    expect(IntegrityKeyReceipt.safeParse(key).success).toBe(true);
    expect(IntegrityKeyReceipt.safeParse({...key,nativeKeyBinding:key.nativeKeyBinding+'\n'}).success).toBe(false);
  });
  it('refuses unknown outcomes/versions and client-supplied authority instead of interpreting them as acceptance',()=>{
    expect(IntegrityClockResult.safeParse({outcome:'verified',receipt:{}}).success).toBe(false);
    expect(IntegrityCapabilities.safeParse({outcome:'capabilities',protocol:2,platform:'ios',features:[],offline:false}).success).toBe(false);
    expect(IntegrityEnrollmentIntent.safeParse({requestId:id,appInstallationId:id,tenantId:id}).success).toBe(false);
    for(const outcome of ['refused','unavailable'])expect(IntegrityClockResult.safeParse({outcome,code:'unrecognized'}).success).toBe(false);
  });
});
