/** Captured certificate signatures/PKI are real. Status-list transport is synthetic, not current Google evidence. */
import {readFileSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {createAndroidKeyChainVerifier} from '../lib/mobile-api/android-key-chain';
const base='test/fixtures/mobile-integrity/android/';
function fixture(file='strongbox-2026',date='2026-02-26T00:00:00Z'){
 const certificateChain=readFileSync(base+file+'.pem','utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)!.map(pem=>new X509Certificate(pem).raw);
 const expected=JSON.parse(readFileSync(base+file+'.json','utf8')),challenge=Buffer.from(expected.attestationChallenge,'base64');
 const publicKeySpki=new X509Certificate(certificateChain[0]).publicKey.export({type:'spki',format:'der'});
 let now=Date.parse(date);const revocation=vi.fn(async(serials:readonly string[])=>({status:'checked' as const,source:'google_https' as const,checkedAt:now,certificateCount:serials.length}));
 return {input:{certificateChain,publicKeySpki,challenge},revocation,verify:createAndroidKeyChainVerifier({revocation,now:()=>now}),time:(value:string)=>{now=Date.parse(value);}};
}
describe('Android pinned chain and revocation evidence',()=>{
 it.each([['strongbox-2026','2026-02-26T00:00:00Z'],['tee-rkp','2025-09-27T00:00:00Z']])('checks captured %s root, path, key, challenge and every serial',async(file,date)=>{
  const f=fixture(file,date),value=await f.verify(f.input);
  expect(value).toMatchObject({verification:'google_root_path_and_status',provisioning:'remote',factoryExpiryException:false});
  expect(value.publicKey.export({type:'spki',format:'der'})).toEqual(f.input.publicKeySpki);expect(value.description.challenge).toEqual(f.input.challenge);
  expect(f.revocation).toHaveBeenCalledExactlyOnceWith(f.input.certificateChain.map(bytes=>new X509Certificate(bytes).serialNumber.toLowerCase().replace(/^0+/,'')),undefined);
  expect(value).not.toHaveProperty('accepted');expect(value).not.toHaveProperty('trustTier');
 });
 it('retains the narrow factory expiry exception without accepting future issuers or manufacturing device assurance',async()=>{
  const f=fixture('tee-v3','2030-01-01T00:00:00Z'),value=await f.verify(f.input);
  expect(value).toMatchObject({provisioning:'factory',factoryExpiryException:true,description:{hardwareEnforced:{rootOfTrust:{deviceLocked:false,state:'unverified'}}}});
  expect(f.revocation).toHaveBeenCalledOnce();
  const before=fixture('tee-v3','2017-01-01T00:00:00Z');await expect(before.verify(before.input)).rejects.toMatchObject({reason:'expired'});expect(before.revocation).not.toHaveBeenCalled();
 });
 it('refuses cancelled or inconsistent status observations even after a signed path checks',async()=>{
  for(const checkedAt of [Date.parse('2026-02-25T00:00:00Z'),Date.parse('2026-02-27T00:00:00Z')]){
   const f=fixture();f.revocation.mockImplementationOnce(async serials=>({status:'checked',source:'google_https',checkedAt,certificateCount:serials.length}));
   await expect(f.verify(f.input)).rejects.toMatchObject({reason:'revocation_unavailable'});
  }
  const f=fixture(),abort=new AbortController();f.revocation.mockImplementationOnce(async serials=>{abort.abort();return {status:'checked',source:'google_https',checkedAt:Date.parse('2026-02-26T00:00:00Z'),certificateCount:serials.length};});
  await expect(f.verify(f.input,abort.signal)).rejects.toMatchObject({reason:'revocation_unavailable'});
 });
 it('copies signed input before an asynchronous status check can mutate caller buffers',async()=>{
  const f=fixture(),expected=Buffer.from(f.input.challenge),spki=Buffer.from(f.input.publicKeySpki);
  f.revocation.mockImplementationOnce(async serials=>{f.input.challenge.fill(0);f.input.publicKeySpki.fill(0);f.input.certificateChain[0].fill(0);return {status:'checked',source:'google_https',checkedAt:Date.parse('2026-02-26T00:00:00Z'),certificateCount:serials.length};});
  const value=await f.verify(f.input);expect(value.description.challenge).toEqual(expected);expect(value.publicKey.export({type:'spki',format:'der'})).toEqual(spki);
 });
 it('refuses expired/future RKP issuer chains before revocation or attendance',async()=>{
  for(const date of ['2026-02-01T00:00:00Z','2026-10-27T00:00:00Z']){
   const f=fixture('strongbox-2026',date);await expect(f.verify(f.input)).rejects.toMatchObject({reason:'expired'});expect(f.revocation).not.toHaveBeenCalled();
  }
 });
 it('rejects root substitution, signature tampering, reversed/duplicate chains and trailing certificate data',async()=>{
  const f=fixture(),other=fixture('tee-v3');
  const tampered=f.input.certificateChain.map(bytes=>Buffer.from(bytes));tampered[0][tampered[0].length-1]^=1;
  for(const certificateChain of [tampered,[...f.input.certificateChain].reverse(),[...f.input.certificateChain.slice(0,-1),other.input.certificateChain.at(-1)!],
    [f.input.certificateChain[0],...f.input.certificateChain],f.input.certificateChain.map((bytes,i)=>i===0?Buffer.concat([bytes,Buffer.from([0])]):bytes)]){
   await expect(f.verify({...f.input,certificateChain})).rejects.toThrow();
  }
  expect(f.revocation).not.toHaveBeenCalled();
 });
 it('refuses changed public key/challenge and bounded malformed input before network work',async()=>{
  const f=fixture(),other=fixture('tee-rkp');
  await expect(f.verify({...f.input,publicKeySpki:other.input.publicKeySpki})).rejects.toMatchObject({reason:'key_mismatch'});
  await expect(f.verify({...f.input,challenge:Buffer.alloc(f.input.challenge.length)})).rejects.toMatchObject({reason:'challenge_mismatch'});
  for(const certificateChain of [[],Array(9).fill(f.input.certificateChain[0]),[Buffer.alloc(16385),...f.input.certificateChain.slice(1)]])await expect(f.verify({...f.input,certificateChain})).rejects.toMatchObject({reason:'malformed'});
  expect(f.revocation).not.toHaveBeenCalled();
 });
 it.each(['revoked','suspended'] as const)('refuses %s despite a valid signature path',async reason=>{
  const f=fixture();f.revocation.mockResolvedValueOnce({status:'refused',reason} as never);await expect(f.verify(f.input)).rejects.toMatchObject({reason});
 });
 it('never treats unavailable or incomplete status as evidence',async()=>{
  for(const result of [{status:'unavailable',reason:'provider'},{status:'checked',source:'google_https',checkedAt:Date.parse('2026-02-26T00:00:00Z'),certificateCount:1}]){
   const f=fixture();f.revocation.mockResolvedValueOnce(result as never);await expect(f.verify(f.input)).rejects.toMatchObject({reason:'revocation_unavailable'});
  }
 });
 it('rechecks issuer expiry after a delayed status response and snapshots mutable caller buffers',async()=>{
  const f=fixture();f.revocation.mockImplementationOnce(async serials=>{f.input.challenge.fill(0);f.input.publicKeySpki.fill(0);f.time('2026-03-07T00:00:00Z');return {status:'checked',source:'google_https',checkedAt:Date.parse('2026-03-07T00:00:00Z'),certificateCount:serials.length};});
  await expect(f.verify(f.input)).rejects.toMatchObject({reason:'expired'});
 });
 it('rejects captured malformed/unsupported extensions before status work',async()=>{
  const f=fixture();for(const file of ['malformed-locked','unordered-tags']){
   const chain=readFileSync(base+file+'.pem','utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)!.map(pem=>new X509Certificate(pem).raw);
   await expect(f.verify({...f.input,certificateChain:chain,publicKeySpki:new X509Certificate(chain[0]).publicKey.export({type:'spki',format:'der'})})).rejects.toThrow();
  }
  expect(f.revocation).not.toHaveBeenCalled();
 });
});
