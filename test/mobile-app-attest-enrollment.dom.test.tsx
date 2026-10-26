import {createHash} from 'node:crypto';
import {decodeFirstSync,encode} from 'cbor';
import {describe,expect,it} from 'vitest';
import fixture from './fixtures/mobile-integrity/apple-attestation-guide.json';
import {AppAttestEnrollmentError,checkAppAttestEnrollment} from '../lib/mobile-api/app-attest-enrollment';

const input=()=>({attestation:Buffer.from(fixture.attestation,'base64'),clientDataHash:createHash('sha256').update(fixture.challenge).digest(),
  keyId:fixture.keyId,appId:fixture.appId,environment:'production' as const,expectedValidationCategory:fixture.actualValidationCategory,
  expectedBundleVersion:fixture.actualBundleVersion,now:new Date(fixture.historicalVerificationTime)});
async function reason(value:Parameters<typeof checkAppAttestEnrollment>[0],expected:string){
  try{await checkAppAttestEnrollment(value);throw new Error('Expected enrollment refusal');}
  catch(error){expect(error).toBeInstanceOf(AppAttestEnrollmentError);expect(error).toMatchObject({reason:expected,message:'App Attest enrollment proof check failed'});}
}
describe('App Attest enrollment proof against the pinned Apple root',()=>{
  it('validates Apple’s published certificate/authenticator sample at its historical issuance time',async()=>{
    const result=await checkAppAttestEnrollment(input());
    expect(result).toMatchObject({keyId:fixture.keyId,environment:'production',validationCategory:1,bundleVersion:'1',
      receiptVerification:'not_checked',revocation:'not_checked'});
    expect(result.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  });
  it('refuses expired and not-yet-valid certificates under a server-owned clock',async()=>{
    await reason({...input(),now:new Date('2026-10-27T00:00:00Z')},'certificate_path');
    await reason({...input(),now:new Date('2026-04-19T00:00:00Z')},'certificate_path');
  });
  it('binds the supplied expected hash, key identifier, app ID and environment',async()=>{
    await reason({...input(),clientDataHash:Buffer.alloc(32)},'nonce_mismatch');
    await reason({...input(),keyId:Buffer.alloc(32).toString('base64')},'key_mismatch');
    await reason({...input(),appId:'1234567890.com.example.other'},'wrong_app');
    await reason({...input(),environment:'development'},'wrong_environment');
  });
  it('checks the actual signed distribution category and build version rather than the explanatory prose',async()=>{
    await reason({...input(),expectedValidationCategory:4},'metadata_mismatch');
    await reason({...input(),expectedBundleVersion:'1.0'},'metadata_mismatch');
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
    await reason({...original,expectedValidationCategory:7},'invalid_configuration');
    await reason({...original,now:new Date('invalid')},'invalid_configuration');
  });
  it('keeps the receipt explicitly unverified and performs no key enrollment, challenge consumption or attendance mutation',async()=>{
    const original=input(),data=decodeFirstSync(original.attestation);
    const result=await checkAppAttestEnrollment({...original,attestation:encode({...data,attStmt:{...data.attStmt,receipt:Buffer.from('unverified opaque receipt')}})});
    expect(result.receiptVerification).toBe('not_checked');expect(result.revocation).toBe('not_checked');
    expect(result).not.toHaveProperty('trustTier');expect(result).not.toHaveProperty('accepted');
  });
});
