/** Real DB/crypto storage; vendor proof is a synthetic port here, not a hardware claim. */
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createAppleEnrollmentService,listOwnIntegrityKeys,revokeOwnIntegrityKey} from '../core/mobile-apple-enrollment';
import {keyEnrollmentClientData} from '../lib/mobile-key-enrollment';
import {decryptSecret} from '../lib/ai/crypto';
import type {AppAttestKeyProof} from '../lib/mobile-api/app-attest-enrollment';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
const settings={apiOrigin:'https://hr.example.com',target:{platform:'ios',appId:'ABCDEFGHIJ.ai.stradaverse.aihr.test',environment:'production',requiredMetadata:null}};
let base:Base;
beforeAll(()=>vi.stubEnv('AI_CONFIG_SECRET','synthetic-mobile-key-receipt-secret-2026'));
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-mobile-key-receipt-secret-2026');await resetDb();base=await seedBase();});
afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});
async function employee(b=base){
  const e=await hireEmployee(adminCtx(b),{person:{fullName:'Key employee',primaryEmail:randomUUID()+'@key.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
  const userId=await createAppUser(b.tenantId,e.personId,'employee');
  const ctx:SessionContext={tenantId:b.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}],entitlements:harnessSnapshot(b.tenantId)};
  return {...e,ctx,intent:{employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()}};
}
function fixture(){
  const {publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'});
  const vendorKeyId=createHash('sha256').update(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])).digest('base64');
  const proof:AppAttestKeyProof={publicKey,keyId:vendorKeyId,environment:'production',metadata:{status:'unavailable'},receipt:Buffer.from('SYNTHETIC_PRIVATE_RECEIPT'),receiptVerification:'not_checked',revocation:'not_checked'};
  const verifyProof=vi.fn(async()=>proof),service=createAppleEnrollmentService(settings,{verifyProof});
  return {vendorKeyId,proof,verifyProof,service,attestation:Buffer.from('synthetic vendor proof')};
}
describe('scoped Apple key enrollment transaction',()=>{
  it('binds context, persists encrypted receipt/public key, and recovers a byte-identical concurrent enrollment',async()=>{
    const e=await employee(),f=fixture(),begin=await f.service.begin(e.ctx,e.intent),again=await f.service.begin(e.ctx,e.intent);
    expect(again).toEqual(begin);expect(begin.alias).toMatch(/^aihr_[0-9a-f]{64}$/);
    expect(begin.context).toMatchObject({actorId:e.ctx.userId,employmentId:e.employmentId,appInstallationId:e.intent.appInstallationId});
    expect(createHash('sha256').update(keyEnrollmentClientData(begin.context)).digest('base64')).toBe(begin.clientDataHash);
    const command={...e.intent,challengeId:begin.challenge.id,vendorKeyId:f.vendorKeyId,attestation:f.attestation};
    const [a,b]=await Promise.all([f.service.complete(e.ctx,command),f.service.complete(e.ctx,command)]);expect(a).toEqual(b);
    expect(f.verifyProof).toHaveBeenCalledWith(expect.objectContaining({clientDataHash:Buffer.from(begin.clientDataHash,'base64'),keyId:f.vendorKeyId,appId:settings.target.appId,environment:'production'}));
    const [row]=await owner.db.select().from(schema.mobileIntegrityKey);expect(row.proofKind).toBe('apple_key_proof');expect(row.assertionCounter).toBe(0);
    expect(row.receiptCiphertext).not.toContain('SYNTHETIC_PRIVATE_RECEIPT');
    const aad=JSON.stringify(['mobile-integrity-key-receipt',1,base.tenantId,e.ctx.userId,row.id,begin.challenge.id]);
    expect(Buffer.from(decryptSecret(row.receiptCiphertext,aad),'base64').toString()).toBe('SYNTHETIC_PRIVATE_RECEIPT');
    expect(()=>decryptSecret(row.receiptCiphertext,aad+'wrong')).toThrow();
    const audit=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,row.id));
    expect(audit).toHaveLength(1);expect(JSON.stringify(audit)).not.toContain('SYNTHETIC_PRIVATE_RECEIPT');
    expect((await listOwnIntegrityKeys(e.ctx,e.employmentId))[0]).toEqual(a);
    expect(a).not.toHaveProperty('receiptCiphertext');expect(a).not.toHaveProperty('publicKeySpki');expect(a).not.toHaveProperty('trustTier');
  });
  it('reconciles before re-verification, rejects altered proof/reference, and never resurrects a revoked key',async()=>{
    const e=await employee(),f=fixture(),begin=await f.service.begin(e.ctx,e.intent);
    const command={...e.intent,challengeId:begin.challenge.id,vendorKeyId:f.vendorKeyId,attestation:f.attestation};
    const receipt=await f.service.complete(e.ctx,command);f.verifyProof.mockRejectedValue(new Error('must not reverify an accepted receipt'));
    expect(await f.service.complete(e.ctx,command)).toEqual(receipt);
    await expect(f.service.complete(e.ctx,{...command,attestation:Buffer.from('changed')})).rejects.toMatchObject({reason:'binding_conflict'});
    await expect(f.service.complete(e.ctx,{...command,requestId:randomUUID()})).rejects.toMatchObject({reason:'binding_conflict'});
    const revoked=await revokeOwnIntegrityKey(e.ctx,{employmentId:e.employmentId,keyId:receipt.keyId});expect(revoked.revokedAt).not.toBeNull();
    expect(await revokeOwnIntegrityKey(e.ctx,{employmentId:e.employmentId,keyId:receipt.keyId})).toEqual(revoked);
    expect(await f.service.complete(e.ctx,command)).toEqual(revoked);expect(f.verifyProof).toHaveBeenCalledOnce();
    await expect(withTenant(e.ctx,tx=>tx.update(schema.mobileIntegrityKey).set({revokedAt:null}).where(eq(schema.mobileIntegrityKey.id,receipt.keyId)))).rejects.toThrow();
  });
  it('refuses peer/admin scope and offboarding before invoking verification or exposing keys',async()=>{
    const e=await employee(),peer=await employee(),f=fixture(),begin=await f.service.begin(e.ctx,e.intent);
    const command={...e.intent,challengeId:begin.challenge.id,vendorKeyId:f.vendorKeyId,attestation:f.attestation};
    await expect(f.service.complete(peer.ctx,command)).rejects.toThrow();expect(f.verifyProof).not.toHaveBeenCalled();
    const receipt=await f.service.complete(e.ctx,command);
    for(const ctx of [peer.ctx,adminCtx(base)])expect(await withTenant(ctx,tx=>tx.select().from(schema.mobileIntegrityKey))).toHaveLength(0);
    await expect(revokeOwnIntegrityKey(peer.ctx,{employmentId:peer.employmentId,keyId:receipt.keyId})).rejects.toMatchObject({reason:'not_found'});
    await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,e.ctx.userId!));
    await expect(f.service.complete(e.ctx,command)).rejects.toThrow();await expect(listOwnIntegrityKeys(e.ctx,e.employmentId)).rejects.toThrow();
  });
  it('keeps a challenge unconsumed on invalid/unavailable metadata or a missing encryption key',async()=>{
    const e=await employee(),f=fixture(),strict=createAppleEnrollmentService({...settings,target:{...settings.target,requiredMetadata:{validationCategory:4,bundleVersions:['4']}}},{verifyProof:f.verifyProof});
    const begin=await strict.begin(e.ctx,e.intent),command={...e.intent,challengeId:begin.challenge.id,vendorKeyId:f.vendorKeyId,attestation:f.attestation};
    await expect(strict.complete(e.ctx,command)).rejects.toMatchObject({reason:'metadata_unavailable'});
    expect((await strict.begin(e.ctx,e.intent)).challenge.state).toBe('active');expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(0);
    f.proof.metadata={status:'available',validationCategory:4,bundleVersion:'4'};
    const result=await strict.complete(e.ctx,command);expect(result.proofKind).toBe('apple_app_metadata');
    vi.stubEnv('AI_CONFIG_SECRET','');
    expect(await strict.complete(e.ctx,command)).toEqual(result);
    await expect(f.service.begin(e.ctx,{...e.intent,requestId:randomUUID()})).rejects.toMatchObject({reason:'configuration_unavailable'});
    vi.stubEnv('AI_CONFIG_SECRET','synthetic-mobile-key-receipt-secret-2026');
  });
  it('uses the actual verifier by default, without consuming a challenge on malformed vendor data',async()=>{
    const e=await employee(),real=createAppleEnrollmentService(settings),f=fixture(),begin=await real.begin(e.ctx,e.intent);
    await expect(real.complete(e.ctx,{...e.intent,challengeId:begin.challenge.id,vendorKeyId:f.vendorKeyId,attestation:f.attestation})).rejects.toThrow();
    expect((await real.begin(e.ctx,e.intent)).challenge.state).toBe('active');expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(0);
  });
  it('does not replace an active installation key or permit raw key/counter rewrites',async()=>{
    const e=await employee(),f=fixture(),begin=await f.service.begin(e.ctx,e.intent);
    const receipt=await f.service.complete(e.ctx,{...e.intent,challengeId:begin.challenge.id,vendorKeyId:f.vendorKeyId,attestation:f.attestation});
    const next={...e.intent,requestId:randomUUID()},g=fixture(),second=await g.service.begin(e.ctx,next);
    await expect(g.service.complete(e.ctx,{...next,challengeId:second.challenge.id,vendorKeyId:g.vendorKeyId,attestation:g.attestation})).rejects.toMatchObject({reason:'active_key_exists'});
    expect((await g.service.begin(e.ctx,next)).challenge.state).toBe('active');
    await expect(withTenant(e.ctx,tx=>tx.update(schema.mobileIntegrityKey).set({publicKeySpki:Buffer.alloc(91)}).where(eq(schema.mobileIntegrityKey.id,receipt.keyId)))).rejects.toThrow();
    await withTenant(e.ctx,tx=>tx.update(schema.mobileIntegrityKey).set({assertionCounter:1}).where(eq(schema.mobileIntegrityKey.id,receipt.keyId)));
    await expect(withTenant(e.ctx,tx=>tx.update(schema.mobileIntegrityKey).set({assertionCounter:0}).where(eq(schema.mobileIntegrityKey.id,receipt.keyId)))).rejects.toThrow();
    await expect(withTenant(e.ctx,tx=>tx.delete(schema.mobileIntegrityKey).where(eq(schema.mobileIntegrityKey.id,receipt.keyId)))).rejects.toThrow();
  });
  it('never transfers a fingerprint to another actor or re-enrolls revoked key material',async()=>{
    const e=await employee(),peer=await employee(),f=fixture(),begin=await f.service.begin(e.ctx,e.intent);
    const receipt=await f.service.complete(e.ctx,{...e.intent,challengeId:begin.challenge.id,vendorKeyId:f.vendorKeyId,attestation:f.attestation});
    const other=await f.service.begin(peer.ctx,peer.intent);
    await expect(f.service.complete(peer.ctx,{...peer.intent,challengeId:other.challenge.id,vendorKeyId:f.vendorKeyId,attestation:f.attestation})).rejects.toMatchObject({reason:'key_unavailable'});
    expect((await f.service.begin(peer.ctx,peer.intent)).challenge.state).toBe('active');
    await revokeOwnIntegrityKey(e.ctx,{employmentId:e.employmentId,keyId:receipt.keyId});
    const next={...e.intent,requestId:randomUUID()},fresh=await f.service.begin(e.ctx,next);
    await expect(f.service.complete(e.ctx,{...next,challengeId:fresh.challenge.id,vendorKeyId:f.vendorKeyId,attestation:f.attestation})).rejects.toMatchObject({reason:'key_unavailable'});
    expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(1);
  });
  it('enforces active-key capacity independently of issuance rate and keeps earlier active keys visible first',async()=>{
    const e=await employee(),keys:Awaited<ReturnType<typeof listOwnIntegrityKeys>>=[];
    for(let i=0;i<5;i++){
      const f=fixture(),intent={...e.intent,requestId:randomUUID(),appInstallationId:randomUUID()},begin=await f.service.begin(e.ctx,intent);
      keys.push(await f.service.complete(e.ctx,{...intent,challengeId:begin.challenge.id,vendorKeyId:f.vendorKeyId,attestation:f.attestation}));
    }
    // Refill only this owned synthetic actor's issuance bucket to test the distinct active-key cap.
    const budgetKey=createHash('sha256').update(JSON.stringify(['mobile-integrity-issue',base.tenantId,e.ctx.userId,'device.enrollment'])).digest('hex');
    await owner.db.execute(sql`update app_request_budget set tokens=5,updated_at=clock_timestamp() where budget_key=${budgetKey}`);
    const sixth=fixture(),intent={...e.intent,requestId:randomUUID(),appInstallationId:randomUUID()},begin=await sixth.service.begin(e.ctx,intent);
    await expect(sixth.service.complete(e.ctx,{...intent,challengeId:begin.challenge.id,vendorKeyId:sixth.vendorKeyId,attestation:sixth.attestation})).rejects.toMatchObject({reason:'capacity'});
    expect((await sixth.service.begin(e.ctx,intent)).challenge.state).toBe('active');
    await revokeOwnIntegrityKey(e.ctx,{employmentId:e.employmentId,keyId:keys[4].keyId});
    const list=await listOwnIntegrityKeys(e.ctx,e.employmentId);expect(list.slice(0,4).every(key=>key.revokedAt===null)).toBe(true);expect(list[4].keyId).toBe(keys[4].keyId);
    expect(await sixth.service.complete(e.ctx,{...intent,challengeId:begin.challenge.id,vendorKeyId:sixth.vendorKeyId,attestation:sixth.attestation})).toMatchObject({revokedAt:null});
  });
});
