import {describe,expect,it} from 'vitest';
import {IntegrityCapabilities,IntegrityClockResult,IntegrityEnrollmentIntent,IntegrityEnrollmentProof,IntegrityKeyLookupResult,IntegrityKeyLookupIntent,IntegrityKeyReceipt,IntegrityKeysResult} from '../lib/mobile-integrity-contract';
import {IntegrityKeyReceiptV2,IntegrityKeysResultV2,IntegrityKeyLookupResultV2,IntegrityRevocationResultV2} from '../lib/mobile-integrity-contract';
import {IntegrityAndroidEnrollmentPrepared,IntegrityAndroidEnrollmentProof,IntegrityClockCapabilities} from '../lib/mobile-integrity-contract';
import {androidEnrollmentFixture} from './helpers/mobile-android-enrollment-fixture';
const id='11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('integrity v1 compatibility and closed security outcomes',()=>{
  it('accepts only bounded Android proof bytes and refuses client authority or noncanonical encoding',()=>{
    const proof={requestId:id,appInstallationId:id,challengeId:id,publicKeySpki:Buffer.alloc(91,1).toString('base64'),certificateChain:[Buffer.from('leaf').toString('base64'),Buffer.from('root').toString('base64')]};
    expect(IntegrityAndroidEnrollmentProof.parse(proof)).toEqual(proof);
    for(const change of [{verified:true},{tenantId:id},{actorId:id},{employmentId:id},{clientDataHash:'A'.repeat(43)+'='},{certificateChain:['AB==','YQ==']},{certificateChain:['YQ==']},{publicKeySpki:proof.publicKeySpki+'\n'},{certificateChain:[Buffer.alloc(16384).toString('base64'),Buffer.alloc(16384).toString('base64')]}])expect(IntegrityAndroidEnrollmentProof.safeParse({...proof,...change}).success).toBe(false);
  });
  it('keeps Android preparation transport version separate from immutable signed context and terminal state',()=>{
    const p=androidEnrollmentFixture().prepared();expect(IntegrityAndroidEnrollmentPrepared.parse({...p,state:'expired',future:'ignored'})).not.toHaveProperty('future');
    for(const change of [{protocol:1},{state:'trusted'},{context:{...p.context,verified:true}},{context:{...p.context,target:{...p.context.target,platform:'ios'}}}])expect(IntegrityAndroidEnrollmentPrepared.safeParse({...p,...change}).success).toBe(false);
  });
  it('accepts both platforms only in explicit v2 recovery and strips private vendor material',()=>{
    const apple={keyId:id,originChallengeId:id,platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production',proofKind:'apple_key_proof',nativeKeyBinding:'a'.repeat(64),createdAt:'2026-10-27T00:00:00.000Z',revokedAt:null};
    const android={...apple,platform:'android',appId:'ai.hr',environment:null,proofKind:'google_key_generation_proof'};
    expect(IntegrityKeysResultV2.parse({outcome:'keys',items:[apple,{...android,receiptCiphertext:'private',vendorKeyId:'private',metadata:{private:true},publicKeySpki:'private'}]})).toEqual({outcome:'keys',items:[apple,android]});
    expect(IntegrityKeyLookupResultV2.parse({outcome:'key_receipt',key:null})).toEqual({outcome:'key_receipt',key:null});
    expect(IntegrityRevocationResultV2.parse({outcome:'revoked',key:{...android,revokedAt:android.createdAt}}).outcome).toBe('revoked');
    expect(IntegrityKeyReceipt.safeParse(android).success).toBe(false);expect(IntegrityKeysResult.safeParse({outcome:'keys',items:[android]}).success).toBe(false);
    for(const changed of [{...android,environment:'production'},{...android,proofKind:'apple_key_proof'},{...apple,environment:null},{...apple,proofKind:'google_key_generation_proof'},{...android,platform:'future'},{...android,nativeKeyBinding:'claimed'}])expect(IntegrityKeyReceiptV2.safeParse(changed).success).toBe(false);
    expect(IntegrityKeysResultV2.safeParse({outcome:'keys',items:Array(21).fill(android)}).success).toBe(false);
  });
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
  it('distinguishes an absent exact key receipt from malformed or client-authorized lookup state',()=>{
    expect(IntegrityKeyLookupResult.parse({outcome:'key_receipt',key:null})).toEqual({outcome:'key_receipt',key:null});
    expect(IntegrityKeyLookupResult.safeParse({outcome:'key_receipt'}).success).toBe(false);
    expect(IntegrityKeyLookupIntent.safeParse({originChallengeId:id,tenantId:id}).success).toBe(false);
    expect(IntegrityKeyLookupIntent.safeParse({originChallengeId:id,verified:true}).success).toBe(false);
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


describe('online-only signed-clock capability discovery',()=>{
 it('retains required understood features while tolerating bounded future feature names',()=>{
  const ios={outcome:'capabilities',protocol:2,platform:'ios',commandProtocol:1,features:['online_clock_assertion','future_feature'],offline:false,cloudProjectNumber:null};
  const android={...ios,platform:'android',commandProtocol:2,features:['online_clock_signature','current_play_integrity','future_feature'],cloudProjectNumber:'123456789'};
  expect(IntegrityClockCapabilities.parse({...ios,privateExtra:'stripped'})).toEqual(ios);expect(IntegrityClockCapabilities.parse(android)).toEqual(android);
  expect(IntegrityClockCapabilities.safeParse({...android,features:['online_clock_signature']}).success).toBe(false);
  expect(IntegrityClockCapabilities.safeParse({...ios,features:['future_feature']}).success).toBe(false);
 });
 it('refuses offline claims, platform protocol confusion and malformed public SDK configuration',()=>{
  const android={outcome:'capabilities',protocol:2,platform:'android',commandProtocol:2,features:['online_clock_signature','current_play_integrity'],offline:false,cloudProjectNumber:'123456789'};
  for(const change of [{offline:true},{commandProtocol:1},{cloudProjectNumber:null},{cloudProjectNumber:'abc'},{cloudProjectNumber:'123\n'},{platform:'ios'},{features:Array(17).fill('online_clock_signature')}])expect(IntegrityClockCapabilities.safeParse({...android,...change}).success).toBe(false);
 });
});
