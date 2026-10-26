import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {generate} from 'otplib';
import {todayInKualaLumpur} from '../lib/hr-date';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {createProvisionRequest,listProvisionRequests,claimActivationUrl} from '../core/operator';
import {listOperatorCustomers,renameOperatorCustomer,requestOperatorModuleChange} from '../core/operator-customers';
import {runProvisionTick} from '../scripts/provision-runner';
import {runModuleChangeTick} from '../scripts/module-change-runner';
import {provisionInternalOrganization} from '../lib/internal-auth/provision-organization';
import {readRecord} from '../lib/internal-auth/record-store';
import {startInvitation} from '../lib/internal-auth/invitations';
import {readSession,startLogin,verifyMfa,type Organization} from '../lib/internal-auth/service';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base,customer:Base,operator:SessionContext;
beforeAll(migrateTestDb);
beforeEach(async()=>{
  await resetDb();base=await seedBase();customer=await seedBase();
  const [u]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:randomUUID()}).returning();
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:u.id,role:'operator',companyId:null});
  operator={tenantId:base.tenantId,userId:u.id,roles:['operator'],grants:[{role:'operator',companyId:null}]};
});
afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
const internal=()=>{vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY','8'.repeat(64));vi.stubEnv('NEXT_PUBLIC_APP_URL','https://hr.test');};
const ask=(code:string,action='activate',extra={})=>requestOperatorModuleChange(operator,{tenantId:customer.tenantId,moduleCode:code,action,purchaseReference:'Agreement TEST-2026',...extra});

describe('operator customer workspace permissions and persistence',()=>{
  it('customer administrators cannot read or change installation customer metadata, including direct SQL',async()=>{
    await expect(listOperatorCustomers(adminCtx(customer))).rejects.toThrow(/operator/);
    await expect(renameOperatorCustomer(adminCtx(customer),base.tenantId,'Forged')).rejects.toThrow(/operator/);
    await expect(requestOperatorModuleChange(adminCtx(customer),{tenantId:base.tenantId,moduleCode:'payroll',action:'activate'})).rejects.toThrow(/operator/);
    for(const query of [sql`select * from app.operator_customer_data(NULL)`,sql`select app.operator_rename_customer(${base.tenantId}::uuid,'Forged')`,sql`select app.operator_request_module_change(${base.tenantId}::uuid,'payroll','activate','Forged',NULL)`]) {
      await expect(withTenant(adminCtx(customer),tx=>tx.execute(query))).rejects.toThrow();
    }
  });
  it('rejects roles-only and stale operator claims at the authoritative database boundary',async()=>{
    const forged={...adminCtx(customer),grants:[{role:'operator',companyId:null}]};
    await expect(listOperatorCustomers(forged)).rejects.toThrow();
    await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,operator.userId!));
    await expect(listOperatorCustomers(operator)).rejects.toThrow();
    await owner.db.update(schema.appUser).set({archivedAt:null}).where(eq(schema.appUser.id,operator.userId!));
    await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,operator.userId!));
    await expect(listOperatorCustomers(operator)).rejects.toThrow();
  });
  it('renames the account without changing a company legal name or a login code, and audits the actor',async()=>{
    internal();await owner.db.transaction(tx=>provisionInternalOrganization(tx,{tenantId:customer.tenantId,code:'customer-test',name:'Original'}));
    const [before]=await owner.db.select().from(schema.company).where(eq(schema.company.id,customer.companyId));
    await renameOperatorCustomer(operator,customer.tenantId,'New customer account');
    const [row]=await listOperatorCustomers(operator,customer.tenantId);
    expect(row.customer_name).toBe('New customer account');expect(row.organizationCode).toBe('customer-test');
    const [after]=await owner.db.select().from(schema.company).where(eq(schema.company.id,customer.companyId));expect(after.legalName).toBe(before.legalName);
    const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'tenant.renamed'));
    expect(events).toHaveLength(1);expect(events[0].actorId).toBe(operator.userId);
    await expect(withTenant(operator,tx=>tx.update(schema.tenant).set({name:'Bypass'}).where(eq(schema.tenant.id,customer.tenantId)))).rejects.toThrow();
  });
  it('refuses blank names, missing customers, and demo deployment writes',async()=>{
    await expect(renameOperatorCustomer(operator,customer.tenantId,' ')).rejects.toThrow(/name/);
    await expect(renameOperatorCustomer(operator,randomUUID(),'Missing')).rejects.toThrow(/found/);
    vi.stubEnv('ALLOW_DEMO_SESSION','true');vi.stubEnv('NODE_ENV','production');
    await expect(listOperatorCustomers(operator)).rejects.toThrow(/operator/);
  });
});

describe('organization code from the intake form to activated customer login',()=>{
  it('establishes the exact namespace atomically and activation grants only customer administration',async()=>{
    internal();
    const {id}=await createProvisionRequest(operator,{customerName:'Operator flow test',adminEmail:'flow-admin@example.test',organizationCode:' New-Customer ',modules:[]});
    await runProvisionTick(owner);
    const row=(await listProvisionRequests(operator)).find(r=>r.id===id)!;
    expect(row.status).toBe('done');expect(row.organizationCode).toBe('new-customer');
    expect(JSON.stringify(await listOperatorCustomers(operator))).not.toContain('/invite/');
    const org=await readRecord<Organization>(owner.client,`tenant:${row.tenantId}`);expect(org?.code).toBe('new-customer');
    const url=await claimActivationUrl(operator,id);expect(url).toBeTruthy();
    const token=url!.split('/').at(-1)!;
    const setup=await startInvitation(token,'customer-admin','Private enrollment phrase 293!');
    if(setup.step!=='enroll'||!setup.secret)throw new Error('Expected authenticator enrollment');
    const activated=await verifyMfa(setup.challenge,await generate({secret:setup.secret}));
    if(activated.step!=='activated')throw new Error('Expected activation followed by login');
    expect(activated.organization).toBe('new-customer');expect(activated).not.toHaveProperty('access_token');
    const login=await startLogin({organization:activated.organization,username:'customer-admin',password:'Private enrollment phrase 293!',native:false});
    if(login.step!=='mfa')throw new Error('Expected login MFA');
    const signedIn=await verifyMfa(login.challenge,activated.recoveryCodes![0]);
    if(signedIn.step!=='complete')throw new Error('Expected a customer session after login');
    const identity=await readSession(signedIn.access_token);expect(identity?.credential.tenantId).toBe(row.tenantId);
    const [principal]=await owner.client`select * from app.principal_by_identity(${identity!.issuer},${identity!.subject})`;
    expect(principal.grants).toContainEqual(expect.objectContaining({role:'hr_admin'}));
    expect(principal.grants).not.toContainEqual(expect.objectContaining({role:'operator'}));
    expect(await claimActivationUrl(operator,id)).toBeNull();
  });
  it('fails atomically if the worker lacks authentication configuration or the code is bound after intake',async()=>{
    internal();
    const first=await createProvisionRequest(operator,{customerName:'Missing worker key',adminEmail:'key-missing@example.test',organizationCode:'key-missing'});
    vi.stubEnv('AUTH_SESSION_KEY','');await runProvisionTick(owner);
    const failed=(await listProvisionRequests(operator)).find(r=>r.id===first.id)!;expect(failed.status).toBe('failed');expect(failed.tenantId).toBeNull();
    vi.stubEnv('AUTH_SESSION_KEY','8'.repeat(64));
    const second=await createProvisionRequest(operator,{customerName:'Late collision',adminEmail:'late-collision@example.test',organizationCode:'late-code'});
    await owner.db.transaction(tx=>provisionInternalOrganization(tx,{tenantId:customer.tenantId,code:'late-code',name:'Existing binding'}));
    await runProvisionTick(owner);
    const collision=(await listProvisionRequests(operator)).find(r=>r.id===second.id)!;expect(collision.status).toBe('failed');expect(collision.tenantId).toBeNull();
    const org=await readRecord<Organization>(owner.client,'org:late-code');expect(org?.tenantId).toBe(customer.tenantId);
    const rows=await owner.db.select().from(schema.tenant);expect(rows.some(t=>['Missing worker key','Late collision'].includes(t.name))).toBe(false);
  });
  it('refuses malformed/reserved codes and duplicate pending or already-bound namespaces',async()=>{
    internal();
    for(const code of ['operator','root','a','with spaces'])await expect(createProvisionRequest(operator,{customerName:'Invalid',adminEmail:'invalid@example.test',organizationCode:code})).rejects.toThrow();
    await expect(createProvisionRequest(operator,{customerName:'Missing',adminEmail:'missing@example.test'})).rejects.toThrow(/code/);
    await owner.db.transaction(tx=>provisionInternalOrganization(tx,{tenantId:customer.tenantId,code:'bound-code',name:'Bound'}));
    await expect(createProvisionRequest(operator,{customerName:'Duplicate',adminEmail:'duplicate@example.test',organizationCode:'bound-code'})).rejects.toThrow(/in use/);
    const attempts=await Promise.allSettled([1,2].map(n=>createProvisionRequest(operator,{customerName:'Pending '+n,adminEmail:`pending${n}@example.test`,organizationCode:'pending-code'})));
    expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
    await expect(owner.db.transaction(tx=>provisionInternalOrganization(tx,{tenantId:base.tenantId,code:'bound-code',name:'Hijack'}))).rejects.toThrow(/in use/);
    await expect(owner.db.transaction(tx=>provisionInternalOrganization(tx,{tenantId:customer.tenantId,code:'other-code',name:'Reassign'}))).rejects.toThrow(/in use/);
  });
});

describe('module changes use the installed worker, preserve history and enforce dependencies',()=>{
  it('records a purchase, queues activation, and applies it through the provisioning tick',async()=>{
    await ask('payroll');
    const [pending]=await listOperatorCustomers(operator,customer.tenantId);expect(pending.changes[0].status).toBe('pending');
    await expect(ask('claims')).rejects.toThrow(/pending/);
    await runProvisionTick(owner);
    const [done]=await listOperatorCustomers(operator,customer.tenantId);expect(done.modules).toContainEqual({code:'payroll',status:'active',companyId:null});
    expect(done.changes[0].status).toBe('done');
    const lines=await owner.db.select().from(schema.subscriptionLine).where(eq(schema.subscriptionLine.tenantId,customer.tenantId));expect(lines[0].scopeNote).toBe('Agreement TEST-2026');
    const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,done.changes[0].id));
    expect(events.map(e=>e.eventType).sort()).toEqual(['module.activated','module.change-requested']);
  });
  it('refuses unsold modules, missing prerequisites and removal while dependents remain active',async()=>{
    await expect(ask('payroll','activate',{purchaseReference:''})).rejects.toThrow(/agreement/);
    await expect(ask('multi_cycle_payroll')).rejects.toThrow(/required/);
    await ask('payroll');expect(await runModuleChangeTick(owner)).toBe('done');
    await ask('multi_cycle_payroll');expect(await runModuleChangeTick(owner)).toBe('done');
    await expect(ask('payroll','deactivate')).rejects.toThrow(/dependent/);
    await ask('multi_cycle_payroll','deactivate');expect(await runModuleChangeTick(owner)).toBe('done');
    await ask('payroll','deactivate');expect(await runModuleChangeTick(owner)).toBe('done');
    const [disabled]=await listOperatorCustomers(operator,customer.tenantId);expect(disabled.modules.find(m=>m.code==='payroll')?.status).toBe('disabled');
    await ask('payroll');expect(await runModuleChangeTick(owner)).toBe('done');
    const [active]=await listOperatorCustomers(operator,customer.tenantId);expect(active.modules.filter(m=>m.code==='payroll')).toHaveLength(1);
  });
  it('shows the same unfinished-work counts used by the worker and requires a recorded decision',async()=>{
    await ask('payroll');await runModuleChangeTick(owner);
    const today=todayInKualaLumpur();
    const [period]=await owner.db.insert(schema.payPeriod).values({tenantId:customer.tenantId,companyId:customer.companyId,period:today.slice(0,7)}).returning();
    await owner.db.insert(schema.payrollBatch).values({tenantId:customer.tenantId,companyId:customer.companyId,payPeriodId:period.id,payPeriod:today.slice(0,7),batchDate:today,status:'draft'});
    const [preview]=await listOperatorCustomers(operator,customer.tenantId);expect(preview.blockers.payroll).toContainEqual(expect.objectContaining({kind:'draft_payroll_batch',count:1}));
    await expect(ask('payroll','deactivate')).rejects.toThrow(/unfinished/);
    await ask('payroll','deactivate',{disposition:{draft_payroll_batch:'Customer agreed to pause and resume after reactivation.'}});expect(await runModuleChangeTick(owner)).toBe('done');
    const rows=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.tenantId,customer.tenantId));expect(rows).toHaveLength(1);expect(rows[0].status).toBe('draft');
  });
  it('shows expired access honestly and a recorded renewal makes it usable again',async()=>{
    await owner.db.insert(schema.tenantModule).values({tenantId:customer.tenantId,moduleCode:'claims',status:'trial',expiresAt:new Date(Date.now()-60_000)});
    const [before]=await listOperatorCustomers(operator,customer.tenantId);expect(before.modules.find(m=>m.code==='claims')?.status).toBe('expired');
    await ask('claims');expect(await runModuleChangeTick(owner)).toBe('done');
    const [after]=await listOperatorCustomers(operator,customer.tenantId);expect(after.modules.find(m=>m.code==='claims')?.status).toBe('active');
  });
  it('cannot switch core modules or replace company-specific grants',async()=>{
    await expect(ask('employees','deactivate')).rejects.toThrow(/optional/);
    await owner.db.insert(schema.tenantModule).values({tenantId:customer.tenantId,moduleCode:'claims',companyId:customer.companyId,status:'active'});
    await expect(ask('claims','deactivate')).rejects.toThrow(/company-specific/);
  });
});
