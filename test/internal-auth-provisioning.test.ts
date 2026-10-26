/** Regression: operator-created customers must activate through internal auth without owner bootstrap. */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {generate} from 'otplib';
import {eq} from 'drizzle-orm';
import {client,withTenant} from '../db/client';
import * as schema from '../db/schema';
import {provisionTenant} from '../db/provision';
import {initializeProvisionedLoginOrganization} from '../db/provision-internal-auth';
import {createProvisionRequest} from '../core/operator';
import {runProvisionTick} from '../scripts/provision-runner';
import {readRecord,writeRecord} from '../lib/internal-auth/record-store';
import {startInvitation} from '../lib/internal-auth/invitations';
import {credentialByLogin,readSession,startLogin,verifyMfa,type Organization} from '../lib/internal-auth/service';
import {closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
const password='A confidential first login phrase 884!';
const provision=(name='Fresh Customer',email='first@example.test')=>owner.db.transaction(tx=>provisionTenant(tx,{name,adminEmail:email,baseUrl:'https://hr.test'}));
const token=(url:string)=>new URL(url).pathname.split('/invite/')[1];
beforeAll(migrateTestDb);
beforeEach(async()=>{
  await resetDb();
  vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');
  vi.stubEnv('AUTH_SESSION_KEY','9'.repeat(64));vi.stubEnv('AUTH_DEFAULT_ORGANIZATION','');
});
afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);

describe('internal authentication on the real customer provisioning path',()=>{
  it('operator provisioning reaches personal MFA and activates the original customer administrator exactly once',async()=>{
    const base=await seedBase();
    const [operator]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`operator:${crypto.randomUUID()}`,personId:null}).returning({id:schema.appUser.id});
    await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:operator.id,companyId:null,role:'operator'});
    const request=await createProvisionRequest({tenantId:base.tenantId,userId:operator.id,roles:['operator'],grants:[{role:'operator',companyId:null}]},{customerName:'Fresh Customer',adminEmail:'first@example.test'});
    await runProvisionTick(owner);
    const [row]=await owner.db.select().from(schema.tenantProvisionRequest).where(eq(schema.tenantProvisionRequest.id,request.id));
    expect(row.status).toBe('done');expect(row.activationUrl).toBeTruthy();
    const organization=await readRecord<Organization>(client,`tenant:${row.tenantId}`);
    expect(organization).toEqual({code:'fresh-customer',name:'Fresh Customer',tenantId:row.tenantId});
    expect(await readRecord(client,'org:fresh-customer')).toEqual(organization);
    const invitation=token(row.activationUrl!);
    const setup=await startInvitation(invitation,'first.admin',password);
    expect(setup.step).toBe('enroll');
    if(setup.step!=='enroll'||!setup.secret)throw Error('Expected personal MFA enrollment');
    expect(await credentialByLogin(organization!.code,'first.admin')).toBeNull();
    expect(await readSession(setup.challenge)).toBeNull();
    expect(await owner.db.select().from(schema.roleAssignment).where(eq(schema.roleAssignment.tenantId,row.tenantId!))).toHaveLength(0);
    const signedIn=await verifyMfa(setup.challenge,await generate({secret:setup.secret}));
    if(signedIn.step!=='complete')throw Error('Expected completed customer activation');
    const identity=await readSession(signedIn.access_token);
    expect(identity?.credential.tenantId).toBe(row.tenantId);
    const [administrator]=await owner.db.select().from(schema.appUser).where(eq(schema.appUser.tenantId,row.tenantId!));
    const [principal]=await client`select app_user_id from app.principal_by_identity(${identity!.issuer},${identity!.subject})`;
    expect(principal.app_user_id).toBe(administrator.id);
    const grants=await owner.db.select().from(schema.roleAssignment).where(eq(schema.roleAssignment.tenantId,row.tenantId!));
    expect(grants.map(r=>r.role)).toEqual(['hr_admin']);
    await expect(startInvitation(invitation,'other.admin',password)).rejects.toMatchObject({code:'invalidChallenge'});
    const login=await startLogin({organization:organization!.code,username:'first.admin',password,native:false});
    expect(login.step).toBe('mfa');
  });
  it('rolls organization records and audit back when a later provisioning step fails',async()=>{
    await expect(owner.db.transaction(tx=>provisionTenant(tx,{name:'Rollback Customer',adminEmail:'rollback@example.test',country:'ZZ'}))).rejects.toThrow();
    expect(await owner.client`select record_key from app_internal_auth_record where record_key like 'org:%' or record_key like 'tenant:%'`).toHaveLength(0);
    expect(await owner.db.select().from(schema.tenant)).toHaveLength(0);
    expect(await owner.client`select id from domain_event where event_type='tenant.internal-login-organization-initialized'`).toHaveLength(0);
  });
  it('keeps same-name customers in separate login organizations without replacing either mapping',async()=>{
    const first=await provision('Same Customer','first@example.test'),second=await provision('Same Customer','second@example.test');
    const a=await readRecord<Organization>(client,`tenant:${first.tenantId}`),b=await readRecord<Organization>(client,`tenant:${second.tenantId}`);
    expect(a!.code).not.toBe(b!.code);
    expect(await readRecord(client,`org:${a!.code}`)).toEqual(a);
    expect(await readRecord(client,`org:${b!.code}`)).toEqual(b);
    expect(a!.tenantId).toBe(first.tenantId);expect(b!.tenantId).toBe(second.tenantId);
  });
  it('serializes concurrently provisioned normalized-name collisions',async()=>{
    const results=await Promise.all([provision('Concurrent Customer','a@example.test'),provision('Concurrent Customer','b@example.test')]);
    const organizations=await Promise.all(results.map(r=>readRecord<Organization>(client,`tenant:${r.tenantId}`)));
    expect(new Set(organizations.map(o=>o!.code)).size).toBe(2);
    for(const organization of organizations)expect(await readRecord(client,`org:${organization!.code}`)).toEqual(organization);
  });
  it('preserves an existing manually chosen customer code and does not duplicate its audit event',async()=>{
    const created=await provision();
    const original=await readRecord<Organization>(client,`tenant:${created.tenantId}`);
    const before={...original!,code:'manually-chosen'};
    await owner.client`delete from app_internal_auth_record where record_key=${`org:${original!.code}`}`;
    await writeRecord(owner.client,`tenant:${created.tenantId}`,before,null);
    await writeRecord(owner.client,'org:manually-chosen',before,null);
    await owner.db.transaction(tx=>initializeProvisionedLoginOrganization(tx,created.tenantId,'A different display name'));
    expect(await readRecord(client,`tenant:${created.tenantId}`)).toEqual(before);
    expect(await owner.client`select id from domain_event where tenant_id=${created.tenantId}::uuid and event_type='tenant.internal-login-organization-initialized'`).toHaveLength(1);
  });
  it('does not claim the installation operator namespace and supports non-ASCII customer names',async()=>{
    for(const [name,email] of [['Operator','operator-customer@example.test'],['公司','unicode@example.test'],['A','short@example.test']]){
      const created=await provision(name,email),org=await readRecord<Organization>(client,`tenant:${created.tenantId}`);
      expect(org!.code).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);expect(org!.code).not.toBe('operator');
    }
  });
  it('refuses initialization from an application-role transaction',async()=>{
    const base=await seedBase();
    await expect(withTenant({tenantId:base.tenantId,userId:base.adminUserId,roles:['hr_admin']},tx=>initializeProvisionedLoginOrganization(tx,base.tenantId,'Forbidden'))).rejects.toThrow(/owner connection/);
    expect(await readRecord(client,`tenant:${base.tenantId}`)).toBeNull();
  });
  it('reports missing organization configuration as unavailable while keeping the invitation pending',async()=>{
    const created=await provision();
    await owner.client`delete from app_internal_auth_record where record_key=${`tenant:${created.tenantId}`}`;
    await expect(startInvitation(token(created.activationUrl),'first.admin',password)).rejects.toMatchObject({code:'unavailable'});
    const [invitation]=await owner.db.select().from(schema.appInvitation).where(eq(schema.appInvitation.tenantId,created.tenantId));
    expect(invitation.status).toBe('pending');
    expect(await owner.client`select record_key from app_internal_auth_record where record_key like 'credential:%'`).toHaveLength(0);
  });
  it('rejects an inconsistent tenant mapping without creating a credential for a different customer',async()=>{
    const created=await provision();
    await writeRecord(owner.client,`tenant:${created.tenantId}`,{code:'other',tenantId:crypto.randomUUID(),name:'Other'},null);
    await expect(startInvitation(token(created.activationUrl),'first.admin',password)).rejects.toMatchObject({code:'unavailable'});
    expect(await owner.client`select record_key from app_internal_auth_record where record_key like 'credential:%'`).toHaveLength(0);
  });
  it('leaves other authentication providers independent of internal encryption configuration',async()=>{
    vi.stubEnv('AUTH_PROVIDER','keycloak');vi.stubEnv('AUTH_SESSION_KEY','');
    const created=await provision();
    expect(created.activationUrl).toContain('/invite/');
    expect(await owner.client`select record_key from app_internal_auth_record`).toHaveLength(0);
  });
});
