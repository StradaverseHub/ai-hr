import {createHash} from 'node:crypto';
import {decodeFirstSync,encode} from 'cbor';
import {describe,expect,it} from 'vitest';
import guide from './fixtures/mobile-integrity/apple-attestation-guide.json';
import fixture from './fixtures/mobile-integrity/attestation-production.json';
import development from './fixtures/mobile-integrity/attestation-development.json';
import {AppAttestEnrollmentError,checkAppAttestEnrollment,checkAppAttestKeyProof} from '../lib/mobile-api/app-attest-enrollment';

const input=()=>({attestation:Buffer.from(fixture.attestation,'base64'),clientDataHash:createHash('sha256').update(Buffer.from(fixture.challenge,'base64')).digest(),
  keyId:fixture.keyId,appId:'V8H6LQ9448.io.uebelacker.AppAttestExample',environment:'production' as const,now:new Date('2024-02-07T00:00:00Z')});
async function reason(value:Parameters<typeof checkAppAttestKeyProof>[0],expected:string){
  try{await checkAppAttestKeyProof(value);throw new Error('Expected enrollment refusal');}
  catch(error){expect(error).toBeInstanceOf(AppAttestEnrollmentError);expect(error).toMatchObject({reason:expected,message:'App Attest enrollment proof check failed'});}
}
describe('App Attest enrollment proof against the pinned Apple root',()=>{
  it('validates a pinned captured Apple key proof at its historical issuance time',async()=>{
    const result=await checkAppAttestKeyProof(input());
    expect(result).toMatchObject({keyId:fixture.keyId,environment:'production',metadata:{status:'unavailable'},
      receiptVerification:'not_checked',revocation:'not_checked'});
    expect(result.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  });
  it('requires an explicit development environment for the separate captured development key',async()=>{
    const value={...input(),attestation:Buffer.from(development.attestation,'base64'),keyId:development.keyId,
      clientDataHash:createHash('sha256').update(Buffer.from(development.challenge,'base64')).digest()};
    await reason(value,'wrong_environment');
    expect(await checkAppAttestKeyProof({...value,environment:'development'})).toMatchObject({environment:'development',metadata:{status:'unavailable'}});
  });
  it('refuses expired and not-yet-valid certificates under a server-owned clock',async()=>{
    await reason({...input(),now:new Date('2026-10-27T00:00:00Z')},'certificate_path');
    await reason({...input(),now:new Date('2024-02-01T00:00:00Z')},'certificate_path');
  });
  it('binds the supplied expected hash, key identifier, app ID and environment',async()=>{
    await reason({...input(),clientDataHash:Buffer.alloc(32)},'nonce_mismatch');
    await reason({...input(),keyId:Buffer.alloc(32).toString('base64')},'key_mismatch');
    await reason({...input(),appId:'1234567890.com.example.other'},'wrong_app');
    await reason({...input(),environment:'development'},'wrong_environment');
  });
  it('keeps missing legacy distribution/build evidence unavailable under the strict enrollment check',async()=>{
    await expect(checkAppAttestEnrollment({...input(),expectedValidationCategory:4,expectedBundleVersion:'1'})).rejects.toMatchObject({reason:'metadata_unavailable'});
  });
  it('refuses the official guide sample whose nonce binds raw challenge bytes instead of the documented hash',async()=>{
    await reason({...input(),attestation:Buffer.from(guide.attestation,'base64'),clientDataHash:createHash('sha256').update(guide.challenge).digest(),
      keyId:guide.keyId,appId:guide.appId,now:new Date(guide.historicalVerificationTime)},'nonce_mismatch');
  });
  it('rejects a mutated certificate, reversed chain and client-supplied root substitution',async()=>{
    const data=decodeFirstSync(input().attestation),changed=Buffer.from(data.attStmt.x5c[0]);changed[changed.length-1]^=1;
    await reason({...input(),attestation:encode({...data,attStmt:{...data.attStmt,x5c:[changed,data.attStmt.x5c[1]]}})},'certificate_path');
    await reason({...input(),attestation:encode({...data,attStmt:{...data.attStmt,x5c:[...data.attStmt.x5c].reverse()}})},'certificate_path');
    await reason({...input(),attestation:encode({...data,attStmt:{...data.attStmt,x5c:[data.attStmt.x5c[0],data.attStmt.x5c[0]]}})},'certificate_path');
  });
  it('refuses altered authenticator bytes before they can become new metadata',async()=>{
    const data=decodeFirstSync(input().attestation),authData=Buffer.from(data.authData);authData[authData.length-1]^=1;
    await reason({...input(),attestation:encode({...data,authData})},'nonce_mismatch');
  });
  it('bounds the parser and rejects trailing objects, missing fields and unsupported distribution configuration',async()=>{
    const original=input(),data=decodeFirstSync(original.attestation);
    for(const attestation of [Buffer.alloc(65537),Buffer.concat([original.attestation,Buffer.from([0])]),encode({...data,verified:true}),encode({...data,attStmt:{x5c:data.attStmt.x5c}})])
      await reason({...original,attestation},'malformed');
    await reason({...original,keyId:fixture.keyId+'\n'},'malformed');
    await expect(checkAppAttestEnrollment({...original,expectedValidationCategory:7,expectedBundleVersion:'1'})).rejects.toMatchObject({reason:'invalid_configuration'});
    await reason({...original,now:new Date('invalid')},'invalid_configuration');
  });
  it('keeps the receipt explicitly unverified and performs no key enrollment, challenge consumption or attendance mutation',async()=>{
    const original=input(),data=decodeFirstSync(original.attestation);
    const result=await checkAppAttestKeyProof({...original,attestation:encode({...data,attStmt:{...data.attStmt,receipt:Buffer.from('unverified opaque receipt')}})});
    expect(result.receiptVerification).toBe('not_checked');expect(result.revocation).toBe('not_checked');
    expect(result).not.toHaveProperty('trustTier');expect(result).not.toHaveProperty('accepted');
  });
});
