/** Authored UNRUN: native operator-attested enrollment/service MFA only. No mailbox, HTTP,
 * browser, TLS installation, notification consent, mocked principal or manufactured credential rows. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {generate} from 'otplib';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {assignRole} from '../core/admin';
import {todayInKualaLumpur} from '../lib/hr-date';
import {bootstrapInternalOwner} from '../lib/internal-auth/bootstrap';
import {changeInitialPassword,credentialByLogin,loginKey,startLogin,verifyMfa} from '../lib/internal-auth/service';
import {INTERNAL_SESSION_COOKIE} from '../lib/internal-auth/config';
import {prepareAiDeliveryNativeNotificationIdentity,type AiDeliveryNativeNotificationIdentityInput as Input} from '../scripts/fixtures/ai-delivery-native-notification-identity';
import type {AiDeliveryFixtureActor,AiDeliveryFixtureContext} from '../scripts/fixtures/ai-delivery-fixture-context';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,context:AiDeliveryFixtureContext,input:Input;
const temporary='Fictional temporary private passphrase 771!',replacement='Fictional changed private passphrase 883!',sessionKey='7'.repeat(64),origin='https://127.0.0.1:3177';
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 await resetDb();b=await seedBase();vi.stubEnv('NODE_ENV','test');vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN',origin);vi.stubEnv('AUTH_SESSION_KEY',sessionKey);vi.stubEnv('AUTH_DEFAULT_ORGANIZATION','fixture-alpha');
 const bootstrapCtx:SessionContext={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 const actor=async(name:string,role:'hr_admin'|'employee'):Promise<AiDeliveryFixtureActor>=>{const email=randomUUID()+'@fixture.test',employee=await hireEmployee(bootstrapCtx,{person:{fullName:name,primaryEmail:email},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur().slice(0,4)+'-01-01'}),userId=await createAppUser(b.tenantId,employee.personId,role),ctx:SessionContext={...await entitledCtx(b,[role]),userId,personId:employee.personId,roles:[role],grants:[{role,companyId:null}]};return{...employee,userId,ctx};};
 const operator=await actor('Fictional native notification operator','hr_admin'),self=await actor('Fictional native notification subject','employee'),r1=await actor('Fictional first reviewer','employee'),r2=await actor('Fictional second reviewer','employee'),peer=await actor('Fictional peer','employee'),manager=await actor('Fictional manager','employee');
 context={owner,tenantId:b.tenantId,companyId:b.companyId,departmentId:b.deptA,today:todayInKualaLumpur(),period:todayInKualaLumpur().slice(0,7),bootstrapCtx,actors:{operator,self,reviewers:[r1,r2],peer,manager}};
 const [person]=await owner.client<{email:string}[]>`select primary_email as email from person where id=${operator.personId}::uuid`;
 input={configuration:{AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:origin,AUTH_SESSION_KEY:sessionKey,AUTH_DEFAULT_ORGANIZATION:'fixture-alpha'},credential:{organization:'fixture-alpha',username:'fixture.operator',email:person.email,temporaryPassword:temporary},operatorOwnershipAttested:true};
});
/** Compare opaque fingerprints, not decrypted credentials or session material. */
async function state(){return{
 records:await owner.client`select record_key,md5(row_to_json(r)::text) as fingerprint from app_internal_auth_record r order by record_key`,
 bindings:await owner.client`select md5(row_to_json(r)::text) as fingerprint from app_external_identity r order by issuer,subject`,
 operators:await owner.client`select md5(row_to_json(r)::text) as fingerprint from deployment_identity_operator r order by issuer,subject`,
 events:await owner.client`select md5(row_to_json(r)::text) as fingerprint from domain_event r order by id`,
 preferences:await owner.client`select md5(row_to_json(r)::text) as fingerprint from notification_pref r order by id`,
};}
async function noEffects(run:()=>Promise<unknown>){const before=await state();await expect(run()).rejects.toThrow('Native notification identity fixture unavailable');expect(await state()).toEqual(before);}
it('enrolls exactly the actual current operator without creating a session, installation operator or notification preference',async()=>{
 const before=await state(),result=await prepareAiDeliveryNativeNotificationIdentity(context,input),credential=await credentialByLogin(input.credential.organization,input.credential.username);if(!credential)throw Error('Actual native credential missing');
 expect(result).toEqual({kind:'native_internal_operator_enrollment',tenantId:b.tenantId,userId:context.actors.operator.userId,personId:context.actors.operator.personId,employmentId:context.actors.operator.employmentId,issuer:origin+'/auth/'+b.tenantId,subject:credential.subject,organization:'fixture-alpha',username:'fixture.operator',email:input.credential.email,verification:'native_operator_ownership_attestation_not_mailbox_delivery',installationOperator:false,browser:{origin,loginRoute:'/login',sessionCookie:INTERNAL_SESSION_COOKIE,requiresHttps:true,passwordChangePending:true,mfaEnrollmentPending:true,realBrowserLoginPending:true,notificationRoute:'/assistant/notifications',humanConsentPending:true},sessionCreated:false,notificationPreferencesChanged:false,emailDeliveryVerified:false});
 expect(credential).toMatchObject({tenantId:b.tenantId,issuer:result.issuer,email:input.credential.email,emailVerified:true,mustChange:true,totpSecret:null,enabled:true});
 const binding=await owner.client`select app_user_id,tenant_id from app.principal_by_identity(${result.issuer},${result.subject})`;expect(binding).toEqual([{app_user_id:context.actors.operator.userId,tenant_id:b.tenantId}]);
 const after=await state();expect(after.operators).toEqual(before.operators);expect(after.preferences).toEqual(before.preferences);expect(after.records.some(row=>String(row.record_key).startsWith('session:'))).toBe(false);
 const events=await owner.client`select event_type,payload from domain_event where tenant_id=${b.tenantId}::uuid and event_type='app-user.internal-owner-enrolled'`;expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({ownershipAttested:true,installationOperator:false});
 for(const secret of [temporary,sessionKey,credential.password!])expect(JSON.stringify(result)).not.toContain(secret);for(const key of ['password','temporaryPassword','AUTH_SESSION_KEY','access_token','refresh_token','totpSecret'])expect(result).not.toHaveProperty(key);
 await noEffects(()=>prepareAiDeliveryNativeNotificationIdentity(context,input));
});
it('keeps password change and MFA as actual native service steps rather than a fabricated browser login',async()=>{
 await prepareAiDeliveryNativeNotificationIdentity(context,input);const login=await startLogin({organization:input.credential.organization,username:input.credential.username,password:temporary,native:false});expect(login.step).toBe('password');if(login.step!=='password')throw Error('Expected native password transition');
 const setup=await changeInitialPassword(login.challenge,replacement);expect(setup.step).toBe('enroll');if(setup.step!=='enroll'||!setup.secret)throw Error('Expected actual MFA enrollment');
 const done=await verifyMfa(setup.challenge,await generate({secret:setup.secret}));expect(done.step).toBe('complete');
 const credential=await credentialByLogin(input.credential.organization,input.credential.username);expect(credential).toMatchObject({mustChange:false,enabled:true,emailVerified:true});expect(credential?.totpSecret).toBeTruthy();
 expect((await state()).records.filter(row=>String(row.record_key).startsWith('session:'))).toHaveLength(1);expect((await state()).preferences).toEqual([]);expect((await state()).operators).toEqual([]);
});
it.each(['wrong_actor','wrong_email','remote_origin','runtime_key','runtime_provider','production','unattested'] as const)('refuses %s before any enrollment/binding/event/consent effects',async kind=>{
 const request={configuration:{...input.configuration},credential:{...input.credential},operatorOwnershipAttested:true as const},fixture={...context,actors:{...context.actors}};
 if(kind==='wrong_actor')fixture.actors.operator={...context.actors.peer};
 if(kind==='wrong_email')request.credential.email='wrong-native-owner@fixture.test';
 if(kind==='remote_origin'){request.configuration.AUTH_PUBLIC_ORIGIN='https://remote.fixture.test:3177';vi.stubEnv('AUTH_PUBLIC_ORIGIN',request.configuration.AUTH_PUBLIC_ORIGIN);}
 if(kind==='runtime_key')vi.stubEnv('AUTH_SESSION_KEY','8'.repeat(64));
 if(kind==='runtime_provider')vi.stubEnv('AUTH_PROVIDER','workos');
 if(kind==='production')vi.stubEnv('NODE_ENV','production');
 if(kind==='unattested')Object.defineProperty(request,'operatorOwnershipAttested',{value:false});
 await noEffects(()=>prepareAiDeliveryNativeNotificationIdentity(fixture,request));
});
it('refuses an existing real native organization/tenant namespace and preserves its original credential and binding',async()=>{
 const peer=context.actors.peer;await assignRole(context.bootstrapCtx,{appUserId:peer.userId,role:'hr_admin'});
 const [person]=await owner.client<{email:string}[]>`select primary_email as email from person where id=${peer.personId}::uuid`;
 await bootstrapInternalOwner(owner.client,{appUserId:peer.userId,organization:input.credential.organization,username:'existing.native.owner',email:person.email,password:temporary,installationOperator:false});
 expect(await credentialByLogin(input.credential.organization,'existing.native.owner')).not.toBeNull();
 await noEffects(()=>prepareAiDeliveryNativeNotificationIdentity(context,input));
 const record=await owner.client`select record_key from app_internal_auth_record where record_key=${loginKey(input.credential.organization,input.credential.username)}`;expect(record).toHaveLength(0);
});
