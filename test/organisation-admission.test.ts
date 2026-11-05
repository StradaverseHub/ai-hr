/** Programmatic native-account fixtures; no live employee enrollment or acceptance claim. */
import {randomUUID,createHmac} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {client,withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {writeRecord} from '../lib/internal-auth/record-store';
import {internalIssuer} from '../lib/internal-auth/config';
import {passwordPolicyKey} from '../lib/password-policy';
import type {Credential} from '../lib/internal-auth/credential';
import {refreshOrganisationAdmission} from '../lib/internal-auth/organisation-admission';
import {organisationAdmissionKey} from '../lib/internal-auth/organisation-admission-proof';
import {companyOrganisationOptions,prepareCompanyOrganisationRun,companyOrganisationRunReport,decideCompanyOrganisationRun,processCompanyOrganisationRun} from '../core/company-organisation';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,c:Credential;const master='7'.repeat(64);
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 await resetDb();b=await seedBase();vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY',master);
 await owner.client`truncate app.organisation_admission_verifier,app.organisation_admission_proof,app.organisation_native_identity_history`;
 await owner.client`insert into app.organisation_admission_verifier(singleton,secret) values(true,${organisationAdmissionKey(master)})`;
 c=await bind(b.adminUserId);
});
async function bind(userId:string):Promise<Credential>{
 const subject=randomUUID(),issuer=internalIssuer(b.tenantId);
 await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${issuer},${subject},${userId})`;
 const credential:Credential={subject,tenantId:b.tenantId,issuer,organization:'fixture',username:'fixture',email:'fictional@example.test',emailVerified:true,enabled:true,password:'fictional-auth-fixture',mustChange:false,version:randomUUID(),totpSecret:'FictionalFixtureOnly',lastStep:-1,recoveryHashes:[],passwordChangedAt:Date.now()};
 await writeRecord(client,'credential:'+subject,credential,subject);return credential;
}
const nativeOptions=(ctx=adminCtx(b))=>withTenant(ctx,async tx=>{const [row]=await tx.execute<{options:{companies:{id:string}[]}}>(sql`select app.company_organisation_options() options`);return row.options;});
async function storedProof(userId=b.adminUserId){const [row]=await owner.client`select payload from app.organisation_admission_proof where tenant_id=${b.tenantId} and user_id=${userId}`;return row.payload;}
it('requires canonical native availability; revoked or deleted bindings never become compatibility actors',async()=>{
 expect((await nativeOptions()).companies).toHaveLength(0);
 expect((await companyOrganisationOptions(adminCtx(b))).companies.map(x=>x.id)).toContain(b.companyId);
 await owner.client`update app_external_identity set revoked_at=now() where subject=${c.subject}`;
 expect((await nativeOptions()).companies).toHaveLength(0);
 await owner.client`delete from app_external_identity where subject=${c.subject}`;
 expect((await nativeOptions()).companies).toHaveLength(0);
 const legacy:SessionContext={...adminCtx(b),userId:await createAppUser(b.tenantId,null,'hr_admin')};
 expect((await companyOrganisationOptions(legacy)).companies.map(x=>x.id)).toContain(b.companyId);
});
it.each([{suspended:true},{enabled:false},{accountActiveUntil:'2000-01-01'},{mustChange:true},{totpSecret:null},{emailVerified:false},{password:null}])('fails closed for unavailable canonical state %j',async change=>{
 await writeRecord(client,'credential:'+c.subject,{...c,...change},c.subject);
 expect((await companyOrganisationOptions(adminCtx(b))).companies).toHaveLength(0);
});
it('invalidates old proofs immediately on ciphertext change, person rebinding or record expiry',async()=>{
 await refreshOrganisationAdmission(adminCtx(b));expect((await nativeOptions()).companies).toHaveLength(1);
 await writeRecord(client,'credential:'+c.subject,{...c,suspended:true},c.subject);
 expect((await nativeOptions()).companies).toHaveLength(0);
 await writeRecord(client,'credential:'+c.subject,c,c.subject);await refreshOrganisationAdmission(adminCtx(b));
 await owner.client`update app_external_identity set created_at=created_at+interval '1 microsecond' where subject=${c.subject}`;
 expect((await nativeOptions()).companies).toHaveLength(0);
 await refreshOrganisationAdmission(adminCtx(b));await owner.client`update app_internal_auth_record set expires_at=now()-interval '1 second' where record_key=${'credential:'+c.subject}`;
 expect((await nativeOptions()).companies).toHaveLength(0);
});
it('rejects forged, extra, expired, future and cross-tenant proofs and denies key/cache access',async()=>{
 await refreshOrganisationAdmission(adminCtx(b));const original=await storedProof();
 const submit=(payload:string,signature:string)=>client.unsafe('select app.organisation_admission_submit($1,$2)',[payload,signature]);
 await expect(submit(JSON.stringify({...original,available:true}),'0'.repeat(64))).rejects.toThrow();
 for(const claims of [{...original,expiresAt:Date.now()-1,issuedAt:Date.now()-60001},{...original,issuedAt:Date.now()+100000,expiresAt:Date.now()+100001},{...original,tenantId:randomUUID()},{...original,userId:randomUUID()},{...original,unexpected:true},{...original,purpose:'login'}]){
  const payload=JSON.stringify(claims),signature=createHmac('sha256',organisationAdmissionKey(master)).update(payload).digest('hex');await expect(submit(payload,signature)).rejects.toThrow();
 }
 for(const table of ['organisation_admission_verifier','organisation_admission_proof','organisation_native_identity_history']){
  await expect(client.unsafe('select * from app.'+table)).rejects.toThrow(/permission denied/);
  await expect(client.unsafe('delete from app.'+table)).rejects.toThrow(/permission denied/);
 }
 await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select app.organisation_actor_account_available(${b.adminUserId}::uuid)`))).rejects.toThrow();
 await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select * from app.organisation_admission_identity(${randomUUID()}::uuid,null)`))).rejects.toThrow();
 await owner.client`delete from app.organisation_admission_verifier`;
 expect((await nativeOptions()).companies).toHaveLength(0);
 await expect(refreshOrganisationAdmission(adminCtx(b))).rejects.toThrow();
});
it('retains admission credential locks through the native transaction commit',async()=>{
 await refreshOrganisationAdmission(adminCtx(b));let release!:()=>void,ready!:()=>void,rejectReady!:(e:unknown)=>void;
 const released=new Promise<void>(r=>{release=r;}),started=new Promise<void>((r,reject)=>{ready=r;rejectReady=reject;});
 const holding=withTenant(adminCtx(b),async tx=>{await tx.execute(sql`select app.company_organisation_options()`);ready();await released;});
 void holding.catch(rejectReady);
 try{await started;await expect(client.begin(async tx=>{await tx.unsafe("set local lock_timeout='100ms'");await writeRecord(tx,'credential:'+c.subject,{...c,suspended:true},c.subject);})).rejects.toMatchObject({code:'55P03'});}finally{release();await holding;}
});
it('refreshes exact native doer/checker identities for reviewed public workflow and rechecks suspension',async()=>{
 const checkerId=await createAppUser(b.tenantId,null,'hr_admin'),checker={...adminCtx(b),userId:checkerId};const checked=await bind(checkerId);
 const [unit]=await owner.withTenant(adminCtx(b),tx=>tx.execute<{id:string}>(sql`insert into business_unit(tenant_id,company_id,code,name,is_global) values(${b.tenantId}::uuid,${b.companyId}::uuid,'PROOF','Fictional proof unit',true) returning id`));
 const id=await prepareCompanyOrganisationRun(adminCtx(b),{kind:'mapping',companyIds:[b.companyId],effectiveOn:todayInKualaLumpur(),changes:[{companyId:b.companyId,businessUnitId:unit.id,parentCompanyId:null}]});
 const {run}=await companyOrganisationRunReport(checker,id);
 await decideCompanyOrganisationRun(checker,{id,digest:run.digest,approve:true,reason:'Independent canonical account review'});
 await writeRecord(client,'credential:'+checked.subject,{...checked,suspended:true},checked.subject);
 expect((await processCompanyOrganisationRun(adminCtx(b),id)).state).toBe('stale');
});

it('honours canonical password expiry, stale proof TTL and exact same-payload replay without renewal',async()=>{
 await refreshOrganisationAdmission(adminCtx(b));const original=await storedProof();
 const payload=JSON.stringify(original),signature=createHmac('sha256',organisationAdmissionKey(master)).update(payload).digest('hex');
 await client.unsafe('select app.organisation_admission_submit($1,$2)',[payload,signature]);
 expect((await storedProof()).expiresAt).toBe(original.expiresAt);
 // The owner installs an already-expired persisted fixture; the runtime has no cache mutation grant.
 await owner.client`update app.organisation_admission_proof set payload=jsonb_set(payload,'{expiresAt}',to_jsonb((${Date.now()-1})::bigint)) where user_id=${b.adminUserId}`;
 expect((await nativeOptions()).companies).toHaveLength(0);
 await writeRecord(client,passwordPolicyKey(b.tenantId),{policy:{enabled:true,interval:1,unit:'days'}},null);
 await writeRecord(client,'credential:'+c.subject,{...c,passwordChangedAt:Date.now()-3*86400000},c.subject);
 expect((await companyOrganisationOptions(adminCtx(b))).companies).toHaveLength(0);
});
it('publishes a reviewed mapping with two canonical native accounts and refuses later permission revocation',async()=>{
 const checkerId=await createAppUser(b.tenantId,null,'hr_admin'),checker={...adminCtx(b),userId:checkerId};await bind(checkerId);
 const [unit]=await owner.withTenant(adminCtx(b),tx=>tx.execute<{id:string}>(sql`insert into business_unit(tenant_id,company_id,code,name,is_global) values(${b.tenantId}::uuid,${b.companyId}::uuid,'NATIVE','Fictional native unit',true) returning id`));
 const prepare=()=>prepareCompanyOrganisationRun(adminCtx(b),{kind:'mapping',companyIds:[b.companyId],effectiveOn:todayInKualaLumpur(),changes:[{companyId:b.companyId,businessUnitId:unit.id,parentCompanyId:null}]});
 const id=await prepare(),{run}=await companyOrganisationRunReport(checker,id);
 await decideCompanyOrganisationRun(checker,{id,digest:run.digest,approve:true,reason:'Independent native-account approval'});
 expect((await processCompanyOrganisationRun(adminCtx(b),id)).state).toBe('published');
 const next=await prepare(),{run:preview}=await companyOrganisationRunReport(checker,next);
 await decideCompanyOrganisationRun(checker,{id:next,digest:preview.digest,approve:true,reason:'Second independent native-account approval'});
 await owner.client`delete from role_assignment where app_user_id=${checkerId}`;
 expect((await processCompanyOrganisationRun(adminCtx(b),next)).state).toBe('stale');
});

it('binds native proof to the exact current person without creating a forged checker context',async()=>{
 await refreshOrganisationAdmission(adminCtx(b));
 const [person]=await owner.client`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId},'Fictional rebound person',${'rebound-'+randomUUID()+'@admission.test'}) returning id`;
 await owner.client`update app_user set person_id=${person.id} where id=${b.adminUserId}`;
 const current={...adminCtx(b),personId:person.id};
 expect((await nativeOptions(current)).companies).toHaveLength(0);
 expect((await companyOrganisationOptions(current)).companies).toHaveLength(1);
});

it('closes identity FK insert phantoms until native admission commits through the STABLE options caller',async()=>{
 await refreshOrganisationAdmission(adminCtx(b));
 let release!:()=>void,ready!:()=>void,rejectReady!:(error:unknown)=>void;
 const released=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>((resolve,reject)=>{ready=resolve;rejectReady=reject;});
 const issuer=internalIssuer(b.tenantId),subject=randomUUID();
 // company_organisation_options is SQL STABLE and invokes the VOLATILE native lock helper.
 // Success here proves that the real outer caller can take and retain the admission locks.
 const holding=withTenant(adminCtx(b),async tx=>{
  const [row]=await tx.execute<{options:{companies:{id:string}[]}}>(sql`select app.company_organisation_options() options`);
  expect(row.options.companies.map(company=>company.id)).toContain(b.companyId);
  ready();await released;
 });
 void holding.catch(rejectReady);
 try{
  await started;
  await expect(owner.client.begin(async tx=>{
   await tx.unsafe("set local lock_timeout='100ms'");
   await tx`insert into app_external_identity(issuer,subject,app_user_id) values(${issuer},${subject},${b.adminUserId})`;
  })).rejects.toMatchObject({code:'55P03'});
 }finally{release();await holding;}
 // The same FK insert succeeds after commit; the extra live native binding then fails closed.
 await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${issuer},${subject},${b.adminUserId})`;
 const [inserted]=await owner.client`select count(*)::int count from app_external_identity where issuer=${issuer} and subject=${subject} and app_user_id=${b.adminUserId}`;
 expect(inserted.count).toBe(1);
 expect((await nativeOptions()).companies).toHaveLength(0);
});
